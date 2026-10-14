import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryBackend, StorageError } from "./backend.ts";
import {
  LEGACY_KEY,
  LEGACY_MIGRATION_KEY,
  runMigrations,
  type LegacyMigrationMeta,
} from "./migrations.ts";
import { openContentStorage } from "./open.ts";
import { ContentRepository, SCHEMA_KEY } from "./repository.ts";
import {
  fakeLocalStorage,
  FIXTURE_LEGACY_WAYPOINT,
  FIXTURE_TRACKS,
  FIXTURE_WAYPOINTS,
  legacyFixtureString,
} from "./test-fixtures.ts";

async function snapshot(backend: MemoryBackend) {
  return backend.read(["waypoints", "tracks", "trash", "meta"], async (tx) => ({
    waypoints: await tx.getAll("waypoints"),
    tracks: await tx.getAll("tracks"),
    trash: await tx.getAll("trash"),
    meta: await tx.getAllKeys("meta"),
  }));
}

const byId = <T extends { id: string }>(list: T[]) =>
  [...list].sort((a, b) => (a.id < b.id ? -1 : 1));

describe("migration v0 → v1 from fieldline-v1", () => {
  it("copies identical records, leaves fieldline-v1 byte-identical, and is a no-op the second time", async () => {
    const raw = legacyFixtureString();
    const local = fakeLocalStorage({ [LEGACY_KEY]: raw });
    const backend = new MemoryBackend();
    const result = await runMigrations({ backend, legacy: local, now: () => 42 });
    assert.equal(result.ok, true);
    assert.equal(result.status, "migrated");
    assert.deepEqual(result.ok && result.counts, { waypoints: 3, tracks: 2 });

    const repo = new ContentRepository(backend);
    assert.deepEqual(
      await repo.listWaypoints(),
      byId([...FIXTURE_WAYPOINTS, FIXTURE_LEGACY_WAYPOINT] as typeof FIXTURE_WAYPOINTS),
    );
    assert.deepEqual(await repo.listTracks(), byId(FIXTURE_TRACKS));
    const legacyWaypoint = await repo.getWaypoint(FIXTURE_LEGACY_WAYPOINT.id);
    assert.equal(
      "goodWinds" in (legacyWaypoint ?? {}),
      false,
      "missing legacy fields are not filled with defaults",
    );
    assert.equal((await repo.getTrack(FIXTURE_TRACKS[0].id))?.points.length, 1500);

    assert.equal(local.getItem(LEGACY_KEY), raw);
    assert.equal(local.writes(), 0);
    assert.equal(await repo.schemaVersion(), 1);
    const meta = await backend.read(["meta"], (tx) =>
      tx.get<LegacyMigrationMeta>("meta", LEGACY_MIGRATION_KEY),
    );
    assert.equal(meta?.completedAt, 42);
    assert.match(meta?.sourceDigest ?? "", /^[0-9a-f]{64}$/);

    const before = await snapshot(backend);
    const again = await runMigrations({ backend, legacy: local, now: () => 99 });
    assert.equal(again.status, "already-complete");
    assert.deepEqual(await snapshot(backend), before);
    assert.equal(local.getItem(LEGACY_KEY), raw);
  });

  it("does not re-import fieldline-v1 after completion, even if it changed", async () => {
    const local = fakeLocalStorage({ [LEGACY_KEY]: legacyFixtureString() });
    const backend = new MemoryBackend();
    await runMigrations({ backend, legacy: local, now: () => 1 });
    local.setItem(LEGACY_KEY, JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 0 }));
    assert.equal(
      (await runMigrations({ backend, legacy: local, now: () => 2 })).status,
      "already-complete",
    );
    assert.equal((await new ContentRepository(backend).listWaypoints()).length, 3);
  });

  it("initializes an empty repository when there is no saved content", async () => {
    const backend = new MemoryBackend();
    const result = await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
    assert.equal(result.status, "nothing-to-migrate");
    assert.equal(await new ContentRepository(backend).isReady(), true);
  });

  it("leaves the repository unchanged and unmarked when the copy is interrupted, then succeeds on retry", async () => {
    const raw = legacyFixtureString();
    const local = fakeLocalStorage({ [LEGACY_KEY]: raw });
    const backend = new MemoryBackend();
    let puts = 0;
    backend.faults.onOp = (op) => {
      if (op.type === "put" && ++puts === 3)
        throw new StorageError("aborted", "simulated crash mid-transaction");
    };
    const failed = await runMigrations({ backend, legacy: local, now: () => 1 });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, "storage-error");
    assert.deepEqual(await snapshot(backend), { waypoints: [], tracks: [], trash: [], meta: [] });
    assert.equal(await new ContentRepository(backend).isReady(), false);
    await assert.rejects(new ContentRepository(backend).putWaypoint(FIXTURE_WAYPOINTS[0]), {
      code: "not-ready",
    });

    backend.faults = {};
    const retried = await runMigrations({ backend, legacy: local, now: () => 2 });
    assert.equal(retried.status, "migrated");
    assert.equal((await new ContentRepository(backend).listWaypoints()).length, 3);
    assert.equal(local.getItem(LEGACY_KEY), raw);
  });

  it("re-copies from the source when completion was interrupted after the data commit", async () => {
    const local = fakeLocalStorage({ [LEGACY_KEY]: legacyFixtureString() });
    const backend = new MemoryBackend();
    backend.faults.onOp = (op) => {
      if (op.type === "put" && op.store === "meta")
        throw new StorageError("aborted", "crash before completion");
    };
    assert.equal((await runMigrations({ backend, legacy: local, now: () => 1 })).ok, false);
    assert.equal((await snapshot(backend)).waypoints.length, 3, "data committed");
    assert.deepEqual((await snapshot(backend)).meta, [], "but not marked complete");

    // The old app kept saving into fieldline-v1 meanwhile: one mark was deleted.
    const changed = JSON.parse(local.getItem(LEGACY_KEY) ?? "{}");
    changed.state.waypoints = changed.state.waypoints.slice(1);
    local.setItem(LEGACY_KEY, JSON.stringify(changed));
    backend.faults = {};
    const retried = await runMigrations({ backend, legacy: local, now: () => 2 });
    assert.equal(retried.status, "migrated");
    assert.deepEqual(
      (await new ContentRepository(backend).listWaypoints()).map((w) => w.id).sort(),
      changed.state.waypoints.map((w: { id: string }) => w.id).sort(),
    );
  });

  for (const [label, raw, status] of [
    ["truncated JSON", legacyFixtureString().slice(0, 200), "corrupt-source"],
    ["not an envelope", "[1,2,3]", "corrupt-source"],
    ["missing tracks", JSON.stringify({ state: { waypoints: [] }, version: 0 }), "corrupt-source"],
    [
      "a future version",
      JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 1 }),
      "unsupported-source-version",
    ],
    [
      "an invalid record",
      JSON.stringify({
        state: { waypoints: [{ id: "a", lng: 500, lat: 0 }], tracks: [] },
        version: 0,
      }),
      "invalid-source-records",
    ],
    [
      "a path-like id",
      JSON.stringify({
        state: { waypoints: [{ id: "../x", lng: 1, lat: 1 }], tracks: [] },
        version: 0,
      }),
      "invalid-source-records",
    ],
    [
      "duplicate ids",
      JSON.stringify({
        state: {
          waypoints: [FIXTURE_WAYPOINTS[0], { ...FIXTURE_WAYPOINTS[0], name: "Other" }],
          tracks: [],
        },
        version: 0,
      }),
      "invalid-source-records",
    ],
  ] as const) {
    it(`refuses ${label}: nothing written, source untouched, clear status`, async () => {
      const local = fakeLocalStorage({ [LEGACY_KEY]: raw });
      const backend = new MemoryBackend();
      const result = await runMigrations({ backend, legacy: local, now: () => 1 });
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.ok(result.message.length > 10);
      assert.deepEqual(await snapshot(backend), { waypoints: [], tracks: [], trash: [], meta: [] });
      assert.equal(local.getItem(LEGACY_KEY), raw);
      assert.equal(local.writes(), 0);
    });
  }

  it("reports unreadable localStorage without marking anything", async () => {
    const backend = new MemoryBackend();
    const result = await runMigrations({
      backend,
      legacy: {
        getItem: () => {
          throw new Error("SecurityError");
        },
      },
      now: () => 1,
    });
    assert.equal(result.status, "source-unavailable");
    assert.deepEqual((await snapshot(backend)).meta, []);
  });

  it("opens with an explicit non-durable fallback when IndexedDB is unavailable", async () => {
    const local = fakeLocalStorage({ [LEGACY_KEY]: legacyFixtureString() });
    const storage = await openContentStorage({
      legacy: local,
      open: async () => {
        throw new StorageError("unavailable", "No IndexedDB here.");
      },
    });
    assert.equal(storage.durable, false);
    assert.equal(storage.warning, "No IndexedDB here.");
    assert.equal(storage.migration.status, "migrated");
    assert.equal(local.writes(), 0);

    const future = await openContentStorage({
      legacy: local,
      open: async () => {
        throw new StorageError("future-version", "Newer database.");
      },
    });
    assert.equal(future.migration.status, "unsupported-database");
    assert.equal(future.durable, false);
    assert.equal(await future.repository.isReady(), false);
  });

  it("refuses a repository written by a newer build and leaves both stores alone", async () => {
    const raw = legacyFixtureString();
    const local = fakeLocalStorage({ [LEGACY_KEY]: raw });
    const backend = new MemoryBackend();
    await backend.write(["meta", "waypoints"], async (tx) => {
      await tx.put("meta", SCHEMA_KEY, { version: 7, createdAt: 1, lastStep: "v6-v7" });
      await tx.put("waypoints", "future", { id: "future", lng: 1, lat: 1, futureField: true });
    });
    const before = await snapshot(backend);
    const result = await runMigrations({ backend, legacy: local, now: () => 1 });
    assert.equal(result.status, "unsupported-database");
    assert.deepEqual(await snapshot(backend), before);
    assert.equal(local.getItem(LEGACY_KEY), raw);
    await assert.rejects(new ContentRepository(backend).putWaypoint(FIXTURE_WAYPOINTS[0]), {
      code: "future-version",
    });
  });
});
