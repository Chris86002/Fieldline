import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { MemoryBackend, StorageError } from "../storage/backend.ts";
import { ContentRepository } from "../storage/repository.ts";
import {
  applyBackup,
  beginRecording,
  checkBackup,
  discardRecovered,
  finishRecording,
  flushContentWrites,
  makeBackup,
  recordFix,
  recordGap,
  resetContentSyncForTests,
  restoreFromTrash,
  saveRecovered,
  startContentSync,
  useContentSync,
} from "./content-sync.ts";
import { useHunt } from "./store.ts";
import type { Waypoint } from "./types.ts";
import { DEFAULT_SETTINGS } from "../../features/settings/schema.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return { values, storage };
}

after(() => {
  resetContentSyncForTests();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

// Test fixtures: a small fieldline-v1 profile.
const MARK: Waypoint = { id: "m1", name: "Saddle", kind: "glass", lng: -111.3, lat: 33.7, notes: "fixture", hunt: "", goodWinds: [225], createdAt: 1 };
const LEGACY = JSON.stringify({ state: { waypoints: [MARK], tracks: [], lastKind: "stand" }, version: 0 });

function fix(i: number) {
  return { lng: -111.3 + i * 0.001, lat: 33.7, t: 1_000 + i * 1_000, accuracy: 5, altitude: null, altitudeAccuracy: null, speed: null, heading: null };
}

async function boot(backend: MemoryBackend, legacy = LEGACY) {
  resetContentSyncForTests();
  const local = installStorage({ "fieldline-v1": legacy });
  await useHunt.persist.rehydrate();
  const mode = await startContentSync({ legacy: local.storage, open: async () => backend });
  return { mode, local, repo: new ContentRepository(backend) };
}

describe("content sync", () => {
  beforeEach(() => resetContentSyncForTests());

  it("migrates, then mirrors adds, edits and deletes to the repository (deletes go to trash)", async () => {
    const backend = new MemoryBackend();
    const { mode, repo } = await boot(backend);
    assert.equal(mode, "repository");
    assert.deepEqual(useHunt.getState().waypoints.map((w) => w.id), ["m1"]);

    useHunt.getState().addWaypoint({ ...MARK, id: "m2", name: "Tank", createdAt: 2 });
    useHunt.getState().updateWaypoint("m1", { name: "North saddle" });
    await flushContentWrites();
    assert.equal((await repo.getWaypoint("m1"))?.name, "North saddle");
    assert.ok(await repo.getWaypoint("m2"));

    useHunt.getState().removeWaypoint("m2");
    await flushContentWrites();
    assert.equal(await repo.getWaypoint("m2"), undefined);
    const trash = useContentSync.getState().trash;
    assert.equal(trash.length, 1);

    await restoreFromTrash(trash[0].id);
    assert.ok(await repo.getWaypoint("m2"));
    assert.ok(useHunt.getState().waypoints.some((w) => w.id === "m2"), "restored mark is back on the map");
    assert.equal(useContentSync.getState().trash.length, 0);
  });

  it("freezes fieldline-v1's marks at their pre-migration value", async () => {
    const backend = new MemoryBackend();
    const { local } = await boot(backend);
    useHunt.getState().addWaypoint({ ...MARK, id: "m3", createdAt: 3 });
    useHunt.getState().setActiveHunt("Unit 22");
    await flushContentWrites();
    const saved = JSON.parse(local.values.get("fieldline-v1") ?? "null");
    assert.deepEqual(saved.state.waypoints, [MARK], "content in fieldline-v1 stays as it was");
    assert.equal(saved.state.activeHunt, "Unit 22", "other fields keep saving");
  });

  it("keeps the older storage when the database can't be used", async () => {
    resetContentSyncForTests();
    const local = installStorage({ "fieldline-v1": LEGACY });
    await useHunt.persist.rehydrate();
    const mode = await startContentSync({
      legacy: local.storage,
      open: async () => {
        throw new StorageError("future-version", "Saved content was written by a newer Fieldline.");
      },
    });
    assert.equal(mode, "legacy");
    assert.match(useContentSync.getState().message ?? "", /newer Fieldline/);
    useHunt.getState().addWaypoint({ ...MARK, id: "m4", createdAt: 4 });
    const saved = JSON.parse(local.values.get("fieldline-v1") ?? "null");
    assert.ok(saved.state.waypoints.some((w: Waypoint) => w.id === "m4"), "older storage stays the store of record");
  });

  it("records durably with gaps and saves the track with segment starts", async () => {
    const backend = new MemoryBackend();
    const { repo } = await boot(backend);
    // Fixes arrive before the session has finished opening; none may be lost.
    const started = beginRecording("Morning walk");
    for (let i = 0; i < 3; i++) recordFix(fix(i));
    assert.equal(await started, true);
    recordGap();
    for (let i = 3; i < 5; i++) recordFix(fix(i));
    const { track } = await finishRecording();
    assert.ok(track);
    assert.equal(track.points.length, 5);
    assert.deepEqual(track.segmentStarts, [3]);
    assert.ok(await repo.getTrack(track.id));
    assert.ok(useHunt.getState().tracks.some((t) => t.id === track.id));
  });

  it("recovers a recording interrupted by a restart", async () => {
    const backend = new MemoryBackend();
    await boot(backend);
    await beginRecording("Interrupted");
    for (let i = 0; i < 4; i++) recordFix(fix(i));
    await flushContentWrites();
    // Restart: module state is gone, the database remains.
    await boot(backend);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovered = useContentSync.getState().recovered;
    assert.ok(recovered, "the interrupted recording is offered");
    assert.equal(recovered.fixCount, 4);
    assert.match(await saveRecovered(), /Saved the interrupted track/);
    assert.equal(useContentSync.getState().recovered, null);
    assert.ok(useHunt.getState().tracks.some((t) => t.points.length === 4));
  });

  it("can discard a recovered recording", async () => {
    const backend = new MemoryBackend();
    await boot(backend);
    await beginRecording("Unwanted");
    recordFix(fix(0));
    await flushContentWrites();
    await boot(backend);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await discardRecovered();
    assert.equal(useContentSync.getState().recovered, null);
  });

  it("round-trips a full backup into a clean profile, settings included", async () => {
    const source = new MemoryBackend();
    await boot(source);
    useHunt.getState().addWaypoint({ ...MARK, id: "m5", createdAt: 5 });
    await flushContentWrites();
    const text = await makeBackup({ prefs: { ...DEFAULT_SETTINGS, speedUnit: "knots" }, preset: null, presetEdits: {} }, "test");

    const target = new MemoryBackend();
    await boot(target, JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 0 }));
    const checked = await checkBackup(text);
    assert.ok(checked.ok);
    let appliedSettings = "";
    const summary = await applyBackup(checked.backup, (settingsText) => {
      appliedSettings = settingsText;
      return { ok: true, message: "Settings imported." };
    });
    assert.match(summary, /Restored 2 marks/);
    assert.deepEqual(
      useHunt.getState().waypoints.map((w) => w.id).sort(),
      ["m1", "m5"],
    );
    assert.equal(JSON.parse(appliedSettings).prefs.speedUnit, "knots");
  });

  it("rejects a tampered backup without touching anything", async () => {
    const backend = new MemoryBackend();
    await boot(backend);
    const text = await makeBackup({ prefs: { ...DEFAULT_SETTINGS }, preset: null, presetEdits: {} }, "test");
    const tampered = text.replace('"Saddle"', '"Saddl3"');
    const checked = await checkBackup(tampered);
    assert.equal(checked.ok, false);
  });
});
