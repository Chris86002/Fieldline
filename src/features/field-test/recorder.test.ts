import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryBackend, StorageError } from "../../lib/storage/backend.ts";
import type { LocationEvent, LocationFix, LocationListener, LocationSource, LocationStartOptions, LocationStatus } from "../location/types.ts";
import { FieldTestRecorder, HEARTBEAT_MS } from "./recorder.ts";
import { FieldTestStore, prepareFieldTestBackend } from "./run-store.ts";

/** Fake location source the test drives by hand. */
class FakeSource implements LocationSource {
  readonly kind = "fake";
  listeners = new Set<LocationListener>();
  started: LocationStartOptions[] = [];
  stopped = 0;
  running = false;
  capabilities() {
    return { geolocation: true, secureContext: true, permissionsApi: true, wakeLock: true, freezeEvents: false, backgroundLocation: "unknown" as const };
  }
  status(): LocationStatus {
    return { running: this.running, permission: "granted", lastError: null, wakeLock: "off", visible: true, online: true };
  }
  async start(options: LocationStartOptions) {
    this.started.push(options);
    this.running = true;
  }
  async stop() {
    this.stopped += 1;
    this.running = false;
  }
  subscribe(listener: LocationListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: LocationEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const SESSION = "6a1f0c2e-4b5d-4e8f-9a1b-2c3d4e5f0001";
const START = 1_760_000_000_000;

function fix(t: number, lat = 45): LocationFix {
  return { lng: -110, lat, t, receivedAt: t, accuracy: 6, altitude: 1500, altitudeAccuracy: 3, speed: 1.3, heading: 10, headingSource: "course" };
}

let backend: MemoryBackend;
let clock: number;

function recorder(source: FakeSource, store: FieldTestStore | null) {
  return new FieldTestRecorder({
    source,
    store,
    build: { version: "1.0.0", commit: "abc123", flavor: "app" },
    now: () => clock,
    newId: () => SESSION,
    readBattery: async () => ({ at: clock, level: 0.8, charging: false }),
    // Timers are driven by the test (beat()).
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
}

beforeEach(() => {
  backend = new MemoryBackend();
  clock = START;
});

describe("field-test recorder", () => {
  it("records a run with lifecycle events and makes a report with gaps and hidden time", async () => {
    const store = await prepareFieldTestBackend(backend);
    const source = new FakeSource();
    const rec = recorder(source, store);
    await rec.init();
    assert.equal(rec.getState().phase, "idle");

    await rec.start({ scenario: 2, keepScreenOn: true, note: "Low Power Mode off" });
    assert.equal(rec.getState().phase, "running");
    assert.equal(source.started[0].keepScreenOn, true);

    for (let i = 0; i < 10; i += 1) source.emit({ type: "fix", fix: fix(START + i * 1000, 45 + i * 1e-5) });
    source.emit({ type: "fix", fix: fix(START + 9000) }); // duplicate time
    clock = START + 10_000;
    source.emit({ type: "lifecycle", signal: "hidden", at: clock });
    // Screen locked for 5 minutes: no fixes, no timers.
    clock = START + 310_000;
    source.emit({ type: "lifecycle", signal: "visible", at: clock });
    for (let i = 0; i < 5; i += 1) source.emit({ type: "fix", fix: { ...fix(START + 311_000 + i * 1000, 45.002), receivedAt: START + 311_000 + i * 1000 } });
    // A fix delivered late, as when a phone batches positions.
    source.emit({ type: "fix", fix: { ...fix(START + 316_000, 45.002), receivedAt: START + 330_000 } });
    clock = START + 330_000;
    source.emit({ type: "error", error: { code: "timeout", message: "No fix", transient: true, at: clock } });
    rec.mark("unlocked");
    await rec.flush();

    const live = rec.getState();
    assert.equal(live.received, 16);
    assert.equal(live.saved, 16);
    assert.equal(live.duplicates, 1);
    assert.equal(live.visibilityChanges, 2);
    assert.equal(live.largestGapMs, 302_000);

    clock = START + 340_000;
    const report = await rec.stop();
    assert.ok(report);
    assert.equal(source.stopped, 1);
    assert.equal(report.run.scenario, 2);
    assert.equal(report.run.scenarioTitle, "Screen locked");
    assert.equal(report.run.durationMs, 340_000);
    assert.equal(report.counts.fixesSaved, 16);
    assert.equal(report.counts.fixesReceived, 16);
    assert.equal(report.counts.lateFixes, 1);
    assert.deepEqual(report.counts.errors, { timeout: 1 });
    assert.equal(report.gaps.count, 1);
    assert.equal(report.gaps.longestMs, 302_000);
    // The whole gap fell while the page was hidden except the last second after it was shown.
    assert.equal(report.gaps.list[0].hiddenMs, 300_000);
    assert.equal(report.hidden.count, 1);
    assert.equal(report.hidden.totalMs, 300_000);
    assert.equal(report.hidden.periods[0].fixes, 0);
    assert.equal(report.battery.start?.level, 0.8);
    assert.equal(report.build?.commit, "abc123");
    assert.equal(report.settings?.keepScreenOn, true);
    assert.equal(report.intervalsS.median, 1);
    assert.ok(report.events.some((event) => event.type === "tester-mark" && event.detail === "unlocked"));

    // The run is now a finished report and a track in the test database, not an open session.
    const state = rec.getState();
    assert.equal(state.phase, "idle");
    assert.equal(state.reports.length, 1);
    assert.equal(await store.activeRun(), null);
    const track = await store.track(SESSION);
    assert.equal(track?.points.length, 16);
    assert.deepEqual(track?.segmentStarts, [10]);

    const json = JSON.parse((await rec.exportJson(report, false)).text);
    assert.equal(json.format, "fieldline-field-test-report");
    assert.equal(json.fixes.length, 16);
    assert.equal(json.fixes[0].lat, undefined);
    assert.equal(JSON.parse((await rec.exportJson(report, true)).text).fixes[0].lat, 45);
    const gpx = await rec.exportGpx(report);
    assert.match(gpx?.text ?? "", /<trkseg>[\s\S]*<trkseg>/);
    assert.match(gpx?.name ?? "", /^fieldline-field-test-s02-\d{8}-\d{4}\.gpx$/);

    await rec.deleteRun(SESSION);
    assert.equal(rec.getState().reports.length, 0);
    assert.equal(await store.track(SESSION), null);
  });

  it("recovers a run after a kill and reports what was saved before it", async () => {
    const source = new FakeSource();
    const first = recorder(source, await prepareFieldTestBackend(backend));
    await first.init();
    await first.start({ scenario: 10, keepScreenOn: false, note: "" });
    for (let i = 0; i < 6; i += 1) {
      clock = START + i * 1000;
      source.emit({ type: "fix", fix: fix(clock) });
    }
    await first.flush();
    // Three heartbeats save the last-alive record (every 15 s in a browser).
    for (let i = 1; i <= 3; i += 1) {
      clock = START + 5000 + i * HEARTBEAT_MS;
      first.beat();
    }
    await first.flush();
    const lastAlive = clock;
    // Killed here: no stop, no pagehide. The page opens again 2 minutes later.
    clock = lastAlive + 120_000;
    const source2 = new FakeSource();
    const second = recorder(source2, await prepareFieldTestBackend(backend));
    await second.init();
    const state = second.getState();
    assert.equal(state.phase, "recovered");
    assert.equal(state.recovered?.recovered.fixCount, 6);
    assert.equal(state.run?.scenario, 10);
    const recovered = state.events.at(-1);
    assert.equal(recovered?.type, "recovered");
    assert.equal(recovered?.data?.lastAliveAt, lastAlive);
    assert.equal(recovered?.data?.savedBefore, 6);

    // Continue, record a few more, then stop.
    await second.continueRecovered();
    // The browser re-delivers its cached last fix first: a duplicate, not a new point.
    source2.emit({ type: "fix", fix: fix(START + 5000) });
    assert.equal(second.getState().duplicates, 1);
    for (let i = 0; i < 3; i += 1) source2.emit({ type: "fix", fix: fix(clock + i * 1000) });
    clock += 5000;
    const report = await second.stop();
    assert.ok(report);
    assert.equal(report.counts.fixesSaved, 9);
    assert.equal(report.interruptions.length, 1);
    assert.equal(report.interruptions[0].downMs, 120_000);
    assert.equal(report.interruptions[0].fixesRecovered, 6);
    assert.equal(report.gaps.count, 1);
    assert.ok(report.gaps.list[0].notRunningMs >= 120_000);
    assert.equal(report.run.pageLoads, 2);
    assert.deepEqual((await second.exportGpx(report))?.text.match(/<trkseg>/g)?.length, 2);
  });

  it("logs storage failures without stopping the run", async () => {
    const store = await prepareFieldTestBackend(backend);
    const source = new FakeSource();
    const rec = recorder(source, store);
    await rec.init();
    await rec.start({ scenario: 8, keepScreenOn: false, note: "" });
    source.emit({ type: "fix", fix: fix(START) });
    await rec.flush();
    backend.faults.onOp = (op) => {
      if (op.store === "chunks") throw new StorageError("quota", "Storage is full.");
    };
    source.emit({ type: "fix", fix: fix(START + 1000) });
    await rec.flush();
    backend.faults.onOp = undefined;
    source.emit({ type: "fix", fix: fix(START + 2000) });
    await rec.flush();
    const state = rec.getState();
    assert.equal(state.phase, "running");
    assert.equal(state.received, 3);
    assert.equal(state.saved, 2);
    assert.match(state.storageError ?? "", /Storage is full/);
    assert.ok(state.events.some((event) => event.type === "error:storage"));
    const report = await rec.stop();
    assert.equal(report?.counts.errors.storage, 1);
    assert.equal(report?.counts.fixesSaved, 2);
  });

  it("keeps field-test runs out of the app's content: a run never appears as the app's interrupted recording", async () => {
    // Same layout, separate database: the app's checkpoint store over its own backend sees nothing.
    const appBackend = new MemoryBackend();
    const appStore = await prepareFieldTestBackend(appBackend);
    const testStore = await prepareFieldTestBackend(backend);
    const rec = recorder(new FakeSource(), testStore);
    await rec.init();
    await rec.start({ scenario: 1, keepScreenOn: false, note: "" });
    assert.ok(await testStore.activeRun());
    assert.equal(await appStore.checkpoints.getActiveSession(), null);
  });

  it("shows an unavailable state without storage", async () => {
    const rec = recorder(new FakeSource(), null);
    await rec.init();
    assert.equal(rec.getState().phase, "unavailable");
    await rec.start({ scenario: 1, keepScreenOn: false, note: "" });
    assert.equal(rec.getState().phase, "unavailable");
  });
});
