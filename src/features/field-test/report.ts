import { toGpx } from "../../lib/hunt/gpx.ts";
import type { Track } from "../../lib/hunt/types.ts";
import type { Fix } from "../../lib/storage/checkpoints.ts";
import type { StoredTrack } from "../../lib/storage/records.ts";
import {
  accuracyDistribution,
  detectGaps,
  fixIntervals,
  fixesWithin,
  overlapMs,
  pathLengthM,
  periodsBetween,
  stats,
  timeOrdered,
  type AccuracyDistribution,
  type Period,
  type Stats,
} from "../location/analysis.ts";
import type { BatteryReading, BuildInfo, Capabilities, DeviceInfo, RunEvent, RunMeta, RunSettings } from "./run-store.ts";
import { scenarioByNumber } from "./scenarios.ts";

/**
 * Field-test report (CC-01): what one run on one phone measured. Built from
 * the durable checkpoint session and event log, so a report made after a
 * kill or restart covers the whole run. Numbers only: the report never
 * decides pass/fail; the owner and lead compare it with agreed thresholds.
 */
export const REPORT_FORMAT = "fieldline-field-test-report";
export const REPORT_VERSION = 1;

export type TimedPeriod = Period & { durationMs: number; fixes: number };

export type GapReport = {
  from: number;
  to: number;
  durationMs: number;
  distanceM: number;
  /** How much of the gap the page was hidden / not running / offline / frozen, ms. */
  hiddenMs: number;
  notRunningMs: number;
  offlineMs: number;
  frozenMs: number;
};

export type Interruption = {
  /** Last heartbeat before the page stopped running. */
  lastAliveAt: number;
  /** When the page was opened again and found the run. */
  reopenedAt: number;
  downMs: number;
  fixesReceivedBefore: number | null;
  fixesSavedBefore: number | null;
  /** Fixes read back from storage on reopening. */
  fixesRecovered: number | null;
};

export type FieldTestReport = {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  createdAt: string;
  run: {
    id: string;
    scenario: number;
    scenarioTitle: string;
    note: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    pageLoads: number;
    /** First fix this long after start, ms (null: no fix). */
    firstFixAfterMs: number | null;
  };
  build: BuildInfo | null;
  device: DeviceInfo | null;
  capabilities: Capabilities | null;
  settings: RunSettings | null;
  battery: { start: BatteryReading | null; end: BatteryReading | null; note: string };
  counts: {
    fixesReceived: number | null;
    fixesSaved: number;
    /** Saved fixes sharing a timestamp with another (a cached fix delivered again); left out of the statistics. */
    duplicateTimes: number;
    lostFixes: number;
    missingChunks: number;
    damagedChunks: number;
    segments: number;
    errors: Record<string, number>;
    lateFixes: number;
  };
  pathLengthM: number;
  /** Seconds between consecutive fixes. */
  intervalsS: Stats;
  accuracyM: AccuracyDistribution;
  gaps: { thresholdMs: number; count: number; longestMs: number; totalMs: number; list: GapReport[] };
  hidden: { count: number; totalMs: number; periods: TimedPeriod[] };
  frozen: { count: number; totalMs: number; periods: TimedPeriod[] };
  offline: { count: number; totalMs: number; periods: TimedPeriod[] };
  timersPaused: { count: number; totalMs: number; periods: TimedPeriod[] };
  interruptions: Interruption[];
  events: RunEvent[];
};

export type ReportInput = {
  sessionId: string;
  meta: RunMeta | null;
  /** Session start, used when the setup record is missing. */
  sessionStartedAt: number;
  events: RunEvent[];
  segments: Fix[][];
  damage: { lostFixes: number; missingChunks: number; damagedChunks: number };
  endedAt: number;
  batteryEnd: BatteryReading | null;
  /** Fixes received during the whole run, when known. */
  fixesReceived: number | null;
  gapThresholdMs: number;
  now?: number;
};

const NO_BATTERY_API =
  "This browser doesn't report battery level (Safari and every iPhone browser never do). Note the battery % from the phone's status bar at start and end.";

function timed(periods: Period[], fixes: Fix[]): TimedPeriod[] {
  return periods.map((period) => ({ ...period, durationMs: period.to - period.from, fixes: fixesWithin(fixes, period) }));
}

function summary(periods: TimedPeriod[]) {
  return { count: periods.length, totalMs: periods.reduce((total, period) => total + period.durationMs, 0), periods };
}

function numberData(event: RunEvent, key: string): number | null {
  const value = event.data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildReport(input: ReportInput): FieldTestReport {
  const { meta, events, endedAt } = input;
  const startedAt = meta?.startedAt ?? input.sessionStartedAt;
  const stored = input.segments.flat();
  const all = timeOrdered(stored);
  const signals = events.map((event) => ({ at: event.at, signal: event.type }));
  // A run that starts hidden is rare (the Start button needs the page); periods open on "hidden".
  const hidden = timed(periodsBetween(signals, "hidden", "visible", endedAt), all);
  const frozen = timed(periodsBetween(signals, "freeze", "resume", endedAt), all);
  const offline = timed(periodsBetween(signals, "offline", "online", endedAt), all);
  const paused = timed(
    events
      .filter((event) => event.type === "timers-paused")
      .flatMap((event) => {
        const from = numberData(event, "from");
        const to = numberData(event, "to");
        return from != null && to != null && to > from ? [{ from, to }] : [];
      }),
    all,
  );
  const interruptions: Interruption[] = events
    .filter((event) => event.type === "recovered")
    .map((event) => {
      const lastAliveAt = numberData(event, "lastAliveAt") ?? event.at;
      return {
        lastAliveAt,
        reopenedAt: event.at,
        downMs: Math.max(0, event.at - lastAliveAt),
        fixesReceivedBefore: numberData(event, "receivedBefore"),
        fixesSavedBefore: numberData(event, "savedBefore"),
        fixesRecovered: numberData(event, "recoveredFixes"),
      };
    });
  const notRunning: Period[] = interruptions.map((item) => ({ from: item.lastAliveAt, to: item.reopenedAt }));
  const gapList: GapReport[] = detectGaps(all, input.gapThresholdMs).map((gap) => ({
    ...gap,
    hiddenMs: overlapMs(gap, hidden),
    notRunningMs: overlapMs(gap, notRunning),
    offlineMs: overlapMs(gap, offline),
    frozenMs: overlapMs(gap, frozen),
  }));
  const errors: Record<string, number> = {};
  for (const event of events) {
    if (event.type.startsWith("error:")) {
      const code = event.type.slice("error:".length);
      errors[code] = (errors[code] ?? 0) + 1;
    }
  }
  const scenario = meta?.scenario ?? 0;
  const batteryNote = meta?.capabilities.batteryApi === false || (!meta?.batteryStart && !input.batteryEnd) ? NO_BATTERY_API : "Read from the browser Battery Status API.";
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    createdAt: new Date(input.now ?? endedAt).toISOString(),
    run: {
      id: input.sessionId,
      scenario,
      scenarioTitle: scenarioByNumber(scenario)?.title ?? "Unknown scenario",
      note: meta?.note ?? "",
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      pageLoads: meta?.pageLoads ?? 1 + interruptions.length,
      firstFixAfterMs: all.length ? Math.max(0, all[0].t - startedAt) : null,
    },
    build: meta?.build ?? null,
    device: meta?.device ?? null,
    capabilities: meta?.capabilities ?? null,
    settings: meta?.settings ?? null,
    battery: { start: meta?.batteryStart ?? null, end: input.batteryEnd, note: batteryNote },
    counts: {
      fixesReceived: input.fixesReceived,
      fixesSaved: stored.length,
      duplicateTimes: stored.length - all.length,
      lostFixes: input.damage.lostFixes,
      missingChunks: input.damage.missingChunks,
      damagedChunks: input.damage.damagedChunks,
      segments: input.segments.filter((segment) => segment.length).length,
      errors,
      lateFixes: events.filter((event) => event.type === "late-fix").length,
    },
    pathLengthM: pathLengthM(input.segments),
    intervalsS: stats(fixIntervals([all]).map((ms) => ms / 1000)),
    accuracyM: accuracyDistribution(all),
    gaps: {
      thresholdMs: input.gapThresholdMs,
      count: gapList.length,
      longestMs: gapList.reduce((max, gap) => Math.max(max, gap.durationMs), 0),
      totalMs: gapList.reduce((total, gap) => total + gap.durationMs, 0),
      list: gapList,
    },
    hidden: summary(hidden),
    frozen: summary(frozen),
    offline: summary(offline),
    timersPaused: summary(paused),
    interruptions,
    events,
  };
}

/* ---------- Export ---------- */

export function reportFileName(report: FieldTestReport, extension: "json" | "gpx"): string {
  const stamp = new Date(report.run.startedAt).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const scenario = String(report.run.scenario).padStart(2, "0");
  return `fieldline-field-test-s${scenario}-${stamp}.${extension}`;
}

/**
 * The report as a JSON file, with the run's fixes. Coordinates are left out
 * unless asked for: times, accuracy, speed and the gap distances already
 * answer the field-test questions without sharing where the tester walked.
 */
export function reportJson(report: FieldTestReport, track: StoredTrack | null, options: { includeCoordinates: boolean }): string {
  const points = track?.points ?? [];
  const fixes = points.map((point) => {
    const p = point as Partial<Fix> & { t: number; lng: number; lat: number };
    return {
      t: p.t,
      accuracy: p.accuracy ?? null,
      altitude: p.altitude ?? null,
      altitudeAccuracy: p.altitudeAccuracy ?? null,
      speed: p.speed ?? null,
      heading: p.heading ?? null,
      ...(options.includeCoordinates ? { lat: p.lat, lng: p.lng } : {}),
    };
  });
  return `${JSON.stringify({ ...report, coordinatesIncluded: options.includeCoordinates, segmentStarts: track?.segmentStarts ?? [], fixes }, null, 2)}\n`;
}

/** The run as GPX (segments split at gaps), through the app's GPX writer. */
export function reportGpx(report: FieldTestReport, track: StoredTrack): string {
  const named: Track = {
    id: track.id,
    name: `Field test ${report.run.scenario}: ${report.run.scenarioTitle}`,
    points: track.points.map((point) => ({ lng: point.lng, lat: point.lat, t: point.t })),
    createdAt: track.createdAt,
    visible: true,
    ...(track.segmentStarts?.length ? { segmentStarts: track.segmentStarts } : {}),
  };
  return toGpx([], [named]);
}

/* ---------- Text ---------- */

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function round(value: number | null, digits = 0): string {
  return value == null ? "–" : value.toFixed(digits);
}

function battery(reading: BatteryReading | null): string {
  return reading ? `${Math.round(reading.level * 100)}%${reading.charging ? " (charging)" : ""}` : "?";
}

/**
 * The run in the result-template layout of docs/phone-strategy.md, with the
 * measured lines filled in and the rest left for the tester.
 */
export function resultTemplate(report: FieldTestReport): string {
  const device = report.device;
  const settings = report.settings;
  const gaps = report.gaps;
  const recovered = report.interruptions.length
    ? report.interruptions
        .map((item) => `${item.fixesRecovered ?? "?"} recovered (saved before: ${item.fixesSavedBefore ?? "?"}, received before: ${item.fixesReceivedBefore ?? "?"}; down ${formatDuration(item.downMs)})`)
        .join("; ")
    : "no interruption";
  const lines = [
    `Run ID: ${report.run.id}`,
    `Date: ${new Date(report.run.startedAt).toISOString()}`,
    "Tester:",
    `Device / OS: ${device ? `${device.model ?? "?"} / ${device.os} ${device.platformVersion ?? device.osVersion ?? ""}`.trim() : "?"}`,
    `Browser or shell + version: ${device ? `${device.browser} ${device.browserVersion ?? ""}${device.standalone ? " (home-screen app)" : " (browser tab)"}`.trim() : "?"}`,
    `App build / commit: ${report.build ? `${report.build.version} ${report.build.commit} (${report.build.flavor})` : "?"}`,
    `Settings (spacing, reject threshold, keep screen on, battery saver): every fix kept; keep screen on ${settings?.keepScreenOn ? "on" : "off"}; battery saver: (note)`,
    `Scenario #: ${report.run.scenario} ${report.run.scenarioTitle}`,
    `Duration: ${formatDuration(report.run.durationMs)}`,
    `Battery start → end: ${battery(report.battery.start)} → ${battery(report.battery.end)}`,
    `Points recorded / expected: ${report.counts.fixesSaved} saved, ${report.counts.fixesReceived ?? "?"} received (about ${Math.round(report.run.durationMs / 1000)} at 1 per second)`,
    `Gaps (count, longest, cause if known): ${gaps.count} over ${formatDuration(gaps.thresholdMs)}, longest ${formatDuration(gaps.longestMs)}, total ${formatDuration(gaps.totalMs)}; hidden ${report.hidden.count}× (${formatDuration(report.hidden.totalMs)})`,
    `Typical fix accuracy: median ${round(report.accuracyM.stats.median)} m, 90% within ${round(report.accuracyM.stats.p90)} m`,
    `Recovered points after kill/restart: ${recovered}`,
    `Storage errors: ${report.counts.errors["storage"] ?? 0}`,
    `Exact steps and notes: ${report.run.note}`,
    "Result: pass / fail / limited",
  ];
  return lines.join("\n");
}
