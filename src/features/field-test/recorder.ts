import type { Fix } from "../../lib/storage/checkpoints.ts";
import { DEFAULT_GAP_MS } from "../location/analysis.ts";
import { DEFAULT_START_OPTIONS, type LocationEvent, type LocationFix, type LocationSource, type WakeLockState } from "../location/types.ts";
import { buildReport, reportGpx, reportJson, reportFileName, type FieldTestReport } from "./report.ts";
import type { ActiveRun, BatteryReading, BuildInfo, Capabilities, DeviceInfo, FieldTestStore, RunEvent, RunMeta, RunSettings } from "./run-store.ts";

/**
 * Field-test recorder: runs one test through a `LocationSource` into the
 * field-test database and keeps the live counters the screen shows. Every
 * fix the platform delivers is kept (no accuracy or distance filter), so the
 * report shows what the phone actually delivered.
 *
 * Kills and restarts give no warning, so the run's last-alive time and
 * counters are saved every 15 s and whenever the page is hidden; on the next
 * open the run is found through the checkpoint store's recovery and the
 * interruption is logged with what was saved before it.
 */

export type RecorderEnv = {
  source: LocationSource;
  /** Null when the field-test database couldn't be opened; `storageError` says why. */
  store: FieldTestStore | null;
  storageError?: string | null;
  build: BuildInfo;
  now?: () => number;
  newId?: () => string;
  readBattery?: () => Promise<BatteryReading | null>;
  describeDevice?: () => Promise<DeviceInfo>;
  capabilities?: () => Promise<Capabilities>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export type Phase = "loading" | "idle" | "recovered" | "running" | "finishing" | "unavailable";

export type RecorderState = {
  phase: Phase;
  storageError: string | null;
  run: { sessionId: string; scenario: number; startedAt: number; keepScreenOn: boolean } | null;
  received: number;
  saved: number;
  duplicates: number;
  lastFix: LocationFix | null;
  /** Largest time between consecutive fixes seen so far in this run, ms. */
  largestGapMs: number;
  visibilityChanges: number;
  hidden: boolean;
  wakeLock: WakeLockState;
  permission: string;
  online: boolean;
  lastError: string | null;
  events: RunEvent[];
  /** The run found open when the page loaded. */
  recovered: ActiveRun | null;
  lastReport: FieldTestReport | null;
  reports: FieldTestReport[];
};

export type ExportFile = { name: string; type: string; text: string };

export const HEARTBEAT_MS = 5_000;
/** A heartbeat this late means the page's timers were paused (page suspended or frozen). */
export const PAUSE_DETECT_MS = 20_000;
/** Save the last-alive record every this many heartbeats. */
const SAVE_EVERY_BEATS = 3;
/** A fix delivered this long after it was taken is logged as late. */
export const LATE_FIX_MS = 5_000;

function toFix(fix: LocationFix): Fix {
  return {
    lng: fix.lng,
    lat: fix.lat,
    t: fix.t,
    accuracy: fix.accuracy,
    altitude: fix.altitude,
    altitudeAccuracy: fix.altitudeAccuracy,
    speed: fix.speed,
    heading: fix.heading,
  };
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export class FieldTestRecorder {
  private env: RecorderEnv;
  private now: () => number;
  private state: RecorderState;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private meta: RunMeta | null = null;
  private seq = 0;
  private heartbeat: unknown = null;
  private lastBeat = 0;
  private beats = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(env: RecorderEnv) {
    this.env = env;
    this.now = env.now ?? Date.now;
    const status = env.source.status();
    this.state = {
      phase: "loading",
      storageError: env.storageError ?? null,
      run: null,
      received: 0,
      saved: 0,
      duplicates: 0,
      lastFix: null,
      largestGapMs: 0,
      visibilityChanges: 0,
      hidden: !status.visible,
      wakeLock: status.wakeLock,
      permission: status.permission,
      online: status.online,
      lastError: null,
      events: [],
      recovered: null,
      lastReport: null,
      reports: [],
    };
  }

  /* ---------- Subscription (useSyncExternalStore) ---------- */

  getState = (): RecorderState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Runs storage work in order; failures are logged and shown, never thrown at the caller. */
  private enqueue<T>(work: (store: FieldTestStore) => Promise<T>): Promise<T | undefined> {
    const store = this.env.store;
    if (!store) return Promise.resolve(undefined);
    const next = this.queue.then(() => work(store));
    this.queue = next.catch((error: unknown) => {
      const text = `Saving failed: ${message(error)}`;
      this.set({ storageError: text });
      // Log the failure itself without going through the failing queue.
      this.pushEvent("error:storage", { detail: message(error), persist: false });
    });
    return next.catch(() => undefined);
  }

  /** Waits for every queued write (tests, before building a report). */
  flush(): Promise<unknown> {
    return this.queue;
  }

  private pushEvent(type: string, options: { detail?: string; data?: RunEvent["data"]; persist?: boolean; at?: number } = {}) {
    const run = this.state.run;
    const event: RunEvent = {
      seq: this.seq,
      at: options.at ?? this.now(),
      type,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.data ? { data: options.data } : {}),
      received: this.state.received,
      saved: this.state.saved,
    };
    this.seq += 1;
    this.set({ events: [...this.state.events, event] });
    if (run && options.persist !== false) void this.enqueue((store) => store.logEvent(run.sessionId, event));
  }

  /* ---------- Startup and recovery ---------- */

  async init(): Promise<void> {
    const store = this.env.store;
    if (!store) {
      this.set({ phase: "unavailable" });
      return;
    }
    try {
      const [active, reports] = await Promise.all([store.activeRun(), store.reports()]);
      if (!active) {
        this.set({ phase: "idle", reports });
        return;
      }
      const sessionId = active.recovered.session.id;
      const meta = active.meta;
      this.meta = meta;
      this.seq = active.events.length ? active.events[active.events.length - 1].seq + 1 : 0;
      const segments = active.recovered.segments;
      const last = segments.length ? segments[segments.length - 1].at(-1) : undefined;
      this.set({
        phase: "recovered",
        reports,
        recovered: active,
        events: active.events,
        // The saved counters can lag the last fixes by up to one heartbeat save.
        received: Math.max(meta?.fixesReceived ?? 0, active.recovered.fixCount),
        saved: active.recovered.fixCount,
        // Compared with the next fix: a re-delivered cached fix is a duplicate, a long silence a gap.
        lastFix: last ? { ...last, receivedAt: last.t, headingSource: last.heading == null ? null : "course" } : null,
        run: {
          sessionId,
          scenario: meta?.scenario ?? 0,
          startedAt: meta?.startedAt ?? active.recovered.session.startedAt,
          keepScreenOn: meta?.settings.keepScreenOn ?? false,
        },
      });
      const reopenedAt = this.now();
      this.pushEvent("recovered", {
        at: reopenedAt,
        detail: active.recovered.intact ? "All saved fixes read back." : `${active.recovered.lostFixes} saved fixes couldn't be read back.`,
        data: {
          lastAliveAt: meta?.lastAliveAt ?? last?.t ?? active.recovered.session.updatedAt,
          receivedBefore: meta?.fixesReceived ?? null,
          savedBefore: meta?.fixesSaved ?? null,
          recoveredFixes: active.recovered.fixCount,
          lostFixes: active.recovered.lostFixes,
          lastFixAt: last?.t ?? null,
        },
      });
      if (meta) {
        this.meta = { ...meta, pageLoads: meta.pageLoads + 1, lastAliveAt: reopenedAt };
        const saved = this.meta;
        void this.enqueue((s) => s.saveMeta(saved));
      }
    } catch (error) {
      this.set({ phase: "unavailable", storageError: `The field-test storage couldn't be read: ${message(error)}` });
    }
  }

  /* ---------- Running ---------- */

  async start(input: { scenario: number; keepScreenOn: boolean; note: string }): Promise<void> {
    const store = this.env.store;
    if (!store || this.state.phase !== "idle") return;
    const startedAt = this.now();
    const sessionId = (this.env.newId ?? (() => crypto.randomUUID()))();
    const settings: RunSettings = {
      keepScreenOn: input.keepScreenOn,
      highAccuracy: DEFAULT_START_OPTIONS.highAccuracy,
      maximumAgeMs: DEFAULT_START_OPTIONS.maximumAgeMs,
      timeoutMs: DEFAULT_START_OPTIONS.timeoutMs,
      gapThresholdMs: DEFAULT_GAP_MS,
    };
    const [device, capabilities, batteryStart] = await Promise.all([
      this.env.describeDevice?.() ?? Promise.resolve(null),
      this.env.capabilities?.() ?? Promise.resolve(null),
      this.env.readBattery?.() ?? Promise.resolve(null),
    ]);
    const meta: RunMeta = {
      sessionId,
      scenario: input.scenario,
      note: input.note.trim().slice(0, 500),
      startedAt,
      settings,
      build: this.env.build,
      device: device ?? emptyDevice(),
      capabilities: capabilities ?? emptyCapabilities(),
      batteryStart,
      lastAliveAt: startedAt,
      fixesReceived: 0,
      fixesSaved: 0,
      pageLoads: 1,
    };
    try {
      await store.startRun(meta);
    } catch (error) {
      this.set({ storageError: `The run couldn't be started: ${message(error)}` });
      return;
    }
    this.meta = meta;
    this.seq = 0;
    this.set({
      phase: "running",
      storageError: this.env.storageError ?? null,
      run: { sessionId, scenario: input.scenario, startedAt, keepScreenOn: input.keepScreenOn },
      received: 0,
      saved: 0,
      duplicates: 0,
      lastFix: null,
      largestGapMs: 0,
      visibilityChanges: 0,
      lastError: null,
      events: [],
      recovered: null,
      lastReport: null,
    });
    this.pushEvent("run-started", {
      at: startedAt,
      detail: `Scenario ${input.scenario}`,
      data: batteryStart ? { battery: batteryStart.level, charging: batteryStart.charging } : undefined,
    });
    await this.watch();
  }

  /** Continues a recovered run: a new segment starts, so the interruption isn't drawn as a line. */
  async continueRecovered(): Promise<void> {
    const run = this.state.run;
    if (this.state.phase !== "recovered" || !run) return;
    void this.enqueue((store) => store.markGap(run.sessionId));
    this.set({ phase: "running", recovered: null });
    this.pushEvent("resumed");
    await this.watch();
  }

  private async watch() {
    const run = this.state.run;
    if (!run) return;
    this.unsubscribe?.();
    this.unsubscribe = this.env.source.subscribe((event) => this.onEvent(event));
    this.lastBeat = this.now();
    this.beats = 0;
    this.startHeartbeat();
    await this.env.source.start({ ...DEFAULT_START_OPTIONS, keepScreenOn: run.keepScreenOn });
    const status = this.env.source.status();
    this.set({ wakeLock: status.wakeLock, permission: status.permission, online: status.online, hidden: !status.visible });
  }

  private startHeartbeat() {
    const every = this.env.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
    this.stopHeartbeat();
    this.heartbeat = every(() => this.beat(), HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat == null) return;
    const clear = this.env.clearInterval ?? ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
    clear(this.heartbeat);
    this.heartbeat = null;
  }

  /** Heartbeat: detects paused timers and saves the last-alive record. */
  beat() {
    const now = this.now();
    if (now - this.lastBeat > PAUSE_DETECT_MS) {
      this.pushEvent("timers-paused", {
        at: now,
        detail: `Page code didn't run for ${Math.round((now - this.lastBeat) / 1000)} s (paused or throttled)`,
        data: { from: this.lastBeat, to: now },
      });
    }
    this.lastBeat = now;
    this.beats += 1;
    if (this.beats % SAVE_EVERY_BEATS === 0) this.saveAlive();
  }

  private saveAlive() {
    if (!this.meta) return;
    const meta: RunMeta = { ...this.meta, lastAliveAt: this.now(), fixesReceived: this.state.received, fixesSaved: this.state.saved };
    this.meta = meta;
    void this.enqueue((store) => store.saveMeta(meta));
  }

  private onEvent(event: LocationEvent) {
    const run = this.state.run;
    if (!run || this.state.phase !== "running") return;
    if (event.type === "fix") {
      this.onFix(run.sessionId, event.fix);
    } else if (event.type === "error") {
      const { error } = event;
      this.set({ lastError: error.message });
      this.pushEvent(`error:${error.code}`, { at: error.at, detail: error.message });
      // A lost signal keeps the run going (ADR-009). Segments break on long silences
      // between fixes (onFix), not on every error: some browsers interleave errors with fixes.
      if (!error.transient) this.set({ permission: this.env.source.status().permission });
    } else if (event.type === "permission") {
      this.set({ permission: event.permission });
      this.pushEvent(`permission:${event.permission}`, { at: event.at });
    } else {
      const { signal } = event;
      const patch: Partial<RecorderState> = {};
      if (signal === "hidden" || signal === "visible") {
        patch.hidden = signal === "hidden";
        patch.visibilityChanges = this.state.visibilityChanges + 1;
      }
      if (signal === "online" || signal === "offline") patch.online = signal === "online";
      if (signal.startsWith("wake-lock")) patch.wakeLock = this.env.source.status().wakeLock;
      this.set(patch);
      this.pushEvent(signal, { at: event.at, detail: event.detail });
      // Last chance before a possible kill: save what we know now.
      if (signal === "hidden" || signal === "pagehide" || signal === "freeze") this.saveAlive();
      // Check right away whether the page's code was paused while hidden or frozen.
      if (signal === "visible" || signal === "resume") this.beat();
    }
  }

  private onFix(sessionId: string, fix: LocationFix) {
    const last = this.state.lastFix;
    if (last && fix.t === last.t) {
      this.set({ duplicates: this.state.duplicates + 1 });
      return;
    }
    const gap = last ? fix.t - last.t : 0;
    // A long silence starts a new segment, so exports never draw a line across it (spec §9).
    if (gap > (this.meta?.settings.gapThresholdMs ?? DEFAULT_GAP_MS)) {
      void this.enqueue((store) => store.markGap(sessionId));
    }
    this.set({
      received: this.state.received + 1,
      lastFix: fix,
      lastError: null,
      largestGapMs: Math.max(this.state.largestGapMs, gap),
    });
    const lag = fix.receivedAt - fix.t;
    if (lag > LATE_FIX_MS) this.pushEvent("late-fix", { at: fix.receivedAt, detail: `Delivered ${Math.round(lag / 1000)} s after it was taken`, data: { lagMs: lag, fixAt: fix.t } });
    void this.enqueue(async (store) => {
      await store.appendFix(sessionId, toFix(fix));
      this.set({ saved: this.state.saved + 1 });
    });
  }

  /** Adds the tester's own note to the log ("locking the phone now"). */
  mark(note: string) {
    if (!this.state.run || (this.state.phase !== "running" && this.state.phase !== "recovered")) return;
    this.pushEvent("tester-mark", { detail: note.trim().slice(0, 200) || "Mark" });
  }

  /* ---------- Stopping and reports ---------- */

  /** Stops (or, for a recovered run, closes) the run and builds its report. */
  async stop(): Promise<FieldTestReport | null> {
    const store = this.env.store;
    const run = this.state.run;
    if (!store || !run || (this.state.phase !== "running" && this.state.phase !== "recovered")) return null;
    this.set({ phase: "finishing" });
    this.stopHeartbeat();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.env.source.stop();
    const batteryEnd = (await this.env.readBattery?.()) ?? null;
    this.pushEvent("stopped", { data: batteryEnd ? { battery: batteryEnd.level, charging: batteryEnd.charging } : undefined });
    await this.flush();
    try {
      const active = await store.activeRun();
      if (!active || active.recovered.session.id !== run.sessionId) throw new Error("The run is no longer open.");
      const meta = active.meta ?? this.meta;
      const report = buildReport({
        sessionId: run.sessionId,
        meta: meta ? { ...meta, fixesReceived: this.state.received } : null,
        sessionStartedAt: active.recovered.session.startedAt,
        // Events from storage, plus any that couldn't be saved (shown on screen only).
        events: mergeEvents(active.events, this.state.events),
        segments: active.recovered.segments,
        damage: active.recovered,
        endedAt: this.now(),
        batteryEnd,
        fixesReceived: this.state.received,
        gapThresholdMs: meta?.settings.gapThresholdMs ?? DEFAULT_GAP_MS,
      });
      await store.finishRun(run.sessionId, report);
      const reports = await store.reports();
      this.meta = null;
      this.set({ phase: "idle", run: null, recovered: null, lastReport: report, reports });
      return report;
    } catch (error) {
      this.set({ phase: "idle", run: null, storageError: `The report couldn't be made: ${message(error)}` });
      return null;
    }
  }

  async deleteRun(sessionId: string): Promise<void> {
    const store = this.env.store;
    if (!store) return;
    await store.deleteRun(sessionId);
    const reports = await store.reports();
    this.set({ reports, lastReport: this.state.lastReport?.run.id === sessionId ? null : this.state.lastReport });
  }

  async exportJson(report: FieldTestReport, includeCoordinates: boolean): Promise<ExportFile> {
    const track = (await this.env.store?.track(report.run.id)) ?? null;
    return { name: reportFileName(report, "json"), type: "application/json", text: reportJson(report, track, { includeCoordinates }) };
  }

  /** Null when the run kept fewer than two fixes (no track). */
  async exportGpx(report: FieldTestReport): Promise<ExportFile | null> {
    const track = (await this.env.store?.track(report.run.id)) ?? null;
    if (!track) return null;
    return { name: reportFileName(report, "gpx"), type: "application/gpx+xml", text: reportGpx(report, track) };
  }

  /** Stops listening (page unmount). The open run stays in storage for recovery. */
  dispose() {
    this.stopHeartbeat();
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.env.source.stop();
  }
}

function mergeEvents(stored: RunEvent[], live: RunEvent[]): RunEvent[] {
  const seen = new Set(stored.map((event) => event.seq));
  return [...stored, ...live.filter((event) => !seen.has(event.seq))].sort((a, b) => a.seq - b.seq);
}

export function emptyDevice(): DeviceInfo {
  return {
    userAgent: "",
    os: "other",
    osVersion: null,
    browser: "other",
    browserVersion: null,
    model: null,
    platformVersion: null,
    standalone: false,
    screen: null,
    notes: [],
  };
}

export function emptyCapabilities(): Capabilities {
  return {
    secureContext: false,
    geolocation: false,
    permissionsApi: false,
    wakeLock: false,
    freezeEvents: false,
    batteryApi: false,
    shareFiles: false,
    persistentStorage: "unknown",
    storageQuotaBytes: null,
    storageUsageBytes: null,
  };
}
