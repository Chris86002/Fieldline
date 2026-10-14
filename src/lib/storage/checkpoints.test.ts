import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryBackend, StorageError } from "./backend.ts";
import { CHECKPOINT_LIMITS, chunkKey, TrackCheckpointStore } from "./checkpoints.ts";
import { runMigrations } from "./migrations.ts";
import { trackProblems } from "./records.ts";
import { ContentRepository } from "./repository.ts";
import { fakeLocalStorage, fixtureFix } from "./test-fixtures.ts";

const SESSION = "3f1c9a52-6a5e-4c8b-9d7e-2b1a0c9e0001";
let backend: MemoryBackend;

beforeEach(async () => {
  backend = new MemoryBackend();
  await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
});

const fixes = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => fixtureFix(from + i));

describe("track checkpoints", () => {
  it("recovers every committed fix and gap after a simulated restart", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "Morning hike", startedAt: 1000 });
    await store.appendFixes(SESSION, fixes(0, 600)); // spans three chunks
    await store.markGap(SESSION);
    await store.markGap(SESSION); // a second gap without fixes adds no empty segment
    await store.appendFixes(SESSION, fixes(600, 10));
    await store.setPaused(SESSION, true);
    await store.setPaused(SESSION, false);
    await store.appendFixes(SESSION, fixes(610, 5));

    // An append that fails mid-transaction leaves nothing behind.
    backend.faults.onOp = (op) => {
      if (op.store === "sessions") throw new StorageError("quota", "full");
    };
    await assert.rejects(store.appendFixes(SESSION, fixes(615, 300)), { code: "quota" });
    backend.faults = {};

    const restarted = new TrackCheckpointStore(backend);
    const recovered = await restarted.getActiveSession();
    assert.ok(recovered);
    assert.equal(recovered.session.id, SESSION);
    assert.equal(recovered.session.status, "recording");
    assert.equal(recovered.fixCount, 615);
    assert.equal(recovered.damagedChunks, 0);
    assert.deepEqual(
      recovered.segments.map((segment) => segment.length),
      [600, 10, 5],
    );
    assert.deepEqual(recovered.segments[0][0], fixtureFix(0));
    assert.equal(recovered.segments[0][0].altitude, null, "unknown altitude stays null");
    assert.deepEqual(recovered.segments[2][4], fixtureFix(614));
    const chunkKeys = await backend.read(["chunks"], (tx) => tx.getAllKeys("chunks"));
    assert.equal(chunkKeys.length, 5);
    for (const key of chunkKeys) assert.ok(key.startsWith(`${SESSION}:`));
  });

  it("bounds chunk size and appends", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await store.appendFixes(SESSION, fixes(0, CHECKPOINT_LIMITS.fixesPerChunk + 1));
    const chunks = await backend.read(["chunks"], (tx) =>
      tx.getAll<{ fixes: unknown[] }>("chunks"),
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.fixes.length),
      [CHECKPOINT_LIMITS.fixesPerChunk, 1],
    );
    await assert.rejects(
      store.appendFixes(SESSION, fixes(0, CHECKPOINT_LIMITS.fixesPerAppend + 1)),
      { code: "invalid" },
    );
  });

  it("rejects invalid fixes instead of storing zeros", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await assert.rejects(store.appendFixes(SESSION, [fixtureFix(0, { accuracy: Number.NaN })]), {
      code: "invalid",
    });
    await assert.rejects(store.appendFixes(SESSION, [fixtureFix(0, { lat: 95 })]), {
      code: "invalid",
    });
    await assert.rejects(
      store.appendFixes(SESSION, [fixtureFix(0, { speed: undefined as unknown as null })]),
      { code: "invalid" },
    );
    assert.equal((await store.getActiveSession())?.fixCount, 0);
  });

  it("allows one open session at a time", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await assert.rejects(store.startSession({ id: "other", name: "y" }), { code: "conflict" });
  });

  it("finalizes into a track with segment breaks and raw fix detail, atomically", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "Evening sit", startedAt: 5000 });
    await store.appendFixes(SESSION, fixes(0, 4));
    await store.markGap(SESSION);
    await store.appendFixes(SESSION, fixes(4, 3));
    const track = await new TrackCheckpointStore(backend).finalizeSession(SESSION);
    assert.equal(track.id, SESSION);
    assert.equal(track.name, "Evening sit");
    assert.equal(track.createdAt, 5000);
    assert.equal(track.visible, true);
    assert.equal(track.points.length, 7);
    assert.deepEqual(track.segmentStarts, [4]);
    assert.deepEqual(track.points[6], fixtureFix(6));
    assert.deepEqual(trackProblems(track), []);
    assert.deepEqual(await new ContentRepository(backend).getTrack(SESSION), track);
    assert.equal(await store.getActiveSession(), null);
    assert.equal(await backend.read(["chunks"], (tx) => tx.count("chunks")), 0);
  });

  it("keeps the session when finalizing fails", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await store.appendFixes(SESSION, fixes(0, 1));
    await assert.rejects(store.finalizeSession(SESSION), { code: "invalid" });
    await store.appendFixes(SESSION, fixes(1, 5));
    backend.faults.beforeCommit = () => {
      throw new StorageError("quota", "full");
    };
    await assert.rejects(store.finalizeSession(SESSION), { code: "quota" });
    backend.faults = {};
    assert.equal((await store.getActiveSession())?.fixCount, 6);
    assert.equal((await new ContentRepository(backend).listTracks()).length, 0);
  });

  it("reports damaged chunks instead of silently dropping them", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await store.appendFixes(SESSION, fixes(0, 5));
    await backend.write(["chunks"], (tx) =>
      tx.put("chunks", chunkKey(SESSION, 1), {
        sessionId: SESSION,
        seq: 1,
        segment: 0,
        fixes: [{ lng: "bad" }],
      }),
    );
    const recovered = await store.getActiveSession();
    assert.equal(recovered?.fixCount, 5);
    assert.equal(recovered?.damagedChunks, 1);
    await assert.rejects(store.finalizeSession(SESSION), { code: "invalid" });
  });

  it("discards a session and all its fixes", async () => {
    const store = new TrackCheckpointStore(backend);
    await store.startSession({ id: SESSION, name: "x" });
    await store.appendFixes(SESSION, fixes(0, 300));
    await store.discardSession(SESSION);
    assert.equal(await new TrackCheckpointStore(backend).getActiveSession(), null);
    assert.equal(await backend.read(["chunks"], (tx) => tx.count("chunks")), 0);
  });

  it("refuses to record before the repository is migrated", async () => {
    const fresh = new MemoryBackend();
    await assert.rejects(new TrackCheckpointStore(fresh).startSession({ id: SESSION, name: "x" }), {
      code: "not-ready",
    });
  });
});
