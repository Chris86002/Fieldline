import { StorageError, type StorageBackend } from "../../lib/storage/backend.ts";
import { TrackCheckpointStore, type Fix, type RecoveredSession } from "../../lib/storage/checkpoints.ts";
import { runMigrations } from "../../lib/storage/migrations.ts";
import type { StoredTrack } from "../../lib/storage/records.ts";
import type { FieldTestReport } from "./report.ts";

/**
 * Durable storage for phone field-test runs (CC-01).
 *
 * Runs live in their own IndexedDB database, `fieldline-field-test`, with the
 * same layout as the content database, so test tracks never mix with the
 * user's saved tracks and a test run never shows up as the app's
 * "interrupted recording". Fixes go through the real `TrackCheckpointStore`,
 * so kills and reloads measure the same recovery the app uses.
 *
 * Extra records use the database's `meta` store:
 * - `ft-run:<sessionId>`: the run's setup and its last-alive time and counters;
 * - `ft-event:<sessionId>:<seq>`: the event log, one record per event;
 * - `ft-report:<sessionId>`: the finished report (fixes stay in the track).
 * Finished runs become tracks in this database's `tracks` store, id = session id.
 */
export const FIELD_TEST_DB = "fieldline-field-test";

const RUN_PREFIX = "ft-run:";
const EVENT_PREFIX = "ft-event:";
const REPORT_PREFIX = "ft-report:";
/** Events per run; beyond this only the last-alive record is updated. */
export const MAX_EVENTS = 5000;

export type BuildInfo = {
  version: string;
  commit: string;
  /** "app" for /field-test inside Fieldline, "static" for the standalone page. */
  flavor: "app" | "static";
};

export type DeviceInfo = {
  userAgent: string;
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
  /** Model and platform version from User-Agent Client Hints, when the browser shares them (Chromium). */
  model: string | null;
  platformVersion: string | null;
  /** Opened from the home screen (standalone) rather than a browser tab. */
  standalone: boolean;
  screen: string | null;
  notes: string[];
};

export type Capabilities = {
  secureContext: boolean;
  geolocation: boolean;
  permissionsApi: boolean;
  wakeLock: boolean;
  freezeEvents: boolean;
  batteryApi: boolean;
  shareFiles: boolean;
  persistentStorage: "granted" | "denied" | "unsupported" | "unknown";
  storageQuotaBytes: number | null;
  storageUsageBytes: number | null;
};

export type BatteryReading = { at: number; level: number; charging: boolean };

export type RunSettings = {
  keepScreenOn: boolean;
  highAccuracy: boolean;
  maximumAgeMs: number;
  timeoutMs: number;
  gapThresholdMs: number;
};

export type RunMeta = {
  sessionId: string;
  scenario: number;
  note: string;
  startedAt: number;
  settings: RunSettings;
  build: BuildInfo;
  device: DeviceInfo;
  capabilities: Capabilities;
  batteryStart: BatteryReading | null;
  /** Last time the page was known to be running (heartbeat), for kill/restart detection. */
  lastAliveAt: number;
  /** Fixes received from the location source, as of `lastAliveAt`. */
  fixesReceived: number;
  /** Fixes committed to storage, as of `lastAliveAt`. */
  fixesSaved: number;
  /** Times the page was opened during this run (1 + recoveries). */
  pageLoads: number;
};

export type RunEvent = {
  seq: number;
  at: number;
  type: string;
  detail?: string;
  data?: Record<string, number | string | boolean | null>;
  /** Fixes received / saved when the event happened. */
  received: number;
  saved: number;
};

export type ActiveRun = {
  recovered: RecoveredSession;
  /** Null when the run started but its setup record was never written. */
  meta: RunMeta | null;
  events: RunEvent[];
};

export type StoredReport = FieldTestReport;

const SEQ_WIDTH = 8;

export function eventKey(sessionId: string, seq: number): string {
  return `${EVENT_PREFIX}${sessionId}:${String(seq).padStart(SEQ_WIDTH, "0")}`;
}

/**
 * Opens a backend for field-test runs: initializes its schema record (there
 * is nothing to migrate into this database) and refuses a database it can't
 * use.
 */
export async function prepareFieldTestBackend(backend: StorageBackend): Promise<FieldTestStore> {
  const migration = await runMigrations({ backend, legacy: { getItem: () => null }, now: Date.now });
  if (!migration.ok) throw new StorageError("unavailable", migration.message);
  return new FieldTestStore(backend);
}

export class FieldTestStore {
  readonly backend: StorageBackend;
  readonly checkpoints: TrackCheckpointStore;

  constructor(backend: StorageBackend) {
    this.backend = backend;
    this.checkpoints = new TrackCheckpointStore(backend);
  }

  async startRun(meta: RunMeta): Promise<void> {
    await this.checkpoints.startSession({ id: meta.sessionId, name: `Field test ${meta.scenario}`, startedAt: meta.startedAt });
    await this.saveMeta(meta);
  }

  saveMeta(meta: RunMeta): Promise<void> {
    return this.backend.write(["meta"], async (tx) => {
      await tx.put("meta", RUN_PREFIX + meta.sessionId, meta);
    });
  }

  appendFix(sessionId: string, fix: Fix) {
    return this.checkpoints.appendFixes(sessionId, [fix]);
  }

  markGap(sessionId: string) {
    return this.checkpoints.markGap(sessionId);
  }

  logEvent(sessionId: string, event: RunEvent): Promise<void> {
    if (event.seq >= MAX_EVENTS) return Promise.resolve();
    return this.backend.write(["meta"], async (tx) => {
      await tx.put("meta", eventKey(sessionId, event.seq), event);
    });
  }

  /** The run left open by a stop that never happened (reload, kill, restart), if any. */
  async activeRun(): Promise<ActiveRun | null> {
    const recovered = await this.checkpoints.getActiveSession();
    if (!recovered) return null;
    const id = recovered.session.id;
    const { meta, events } = await this.backend.read(["meta"], async (tx) => ({
      meta: ((await tx.get<RunMeta>("meta", RUN_PREFIX + id)) ?? null) as RunMeta | null,
      events: await tx.getRange<RunEvent>("meta", `${EVENT_PREFIX}${id}:`),
    }));
    return { recovered, meta, events: events.sort((a, b) => a.seq - b.seq) };
  }

  /**
   * Saves the report and turns the run into a track in this database (or
   * discards it when it has fewer than two fixes), then removes the run's
   * setup record and event log, which the report now holds.
   */
  async finishRun(sessionId: string, report: FieldTestReport): Promise<{ trackSaved: boolean }> {
    await this.backend.write(["meta"], async (tx) => {
      await tx.put("meta", REPORT_PREFIX + sessionId, report);
    });
    const active = await this.checkpoints.getActiveSession();
    let trackSaved = false;
    if (active && active.session.id === sessionId) {
      if (active.fixCount >= 2) {
        await this.checkpoints.finalizeSession(sessionId, { acceptDamage: true });
        trackSaved = true;
      } else {
        await this.checkpoints.discardSession(sessionId);
      }
    }
    await this.backend.write(["meta"], async (tx) => {
      await tx.delete("meta", RUN_PREFIX + sessionId);
      await tx.deleteRange("meta", `${EVENT_PREFIX}${sessionId}:`);
    });
    return { trackSaved };
  }

  /** Finished reports, newest first. */
  async reports(): Promise<FieldTestReport[]> {
    const list = await this.backend.read(["meta"], (tx) => tx.getRange<FieldTestReport>("meta", REPORT_PREFIX));
    return list.sort((a, b) => b.run.startedAt - a.run.startedAt);
  }

  track(sessionId: string): Promise<StoredTrack | null> {
    return this.backend.read(["tracks"], async (tx) => (await tx.get<StoredTrack>("tracks", sessionId)) ?? null);
  }

  /** Deletes a finished run's report and its track from this test database. */
  async deleteRun(sessionId: string): Promise<void> {
    await this.backend.write(["meta", "tracks"], async (tx) => {
      await tx.delete("meta", REPORT_PREFIX + sessionId);
      await tx.delete("tracks", sessionId);
    });
  }
}
