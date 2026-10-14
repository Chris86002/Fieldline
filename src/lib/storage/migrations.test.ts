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

  it("reports, but never re-imports, fieldline-v1 content changed after completion", async () => {
    const local = fakeLocalStorage({ [LEGACY_KEY]: legacyFixtureString() });
    const backend = new MemoryBackend();
    await runMigrations({ backend, legacy: local, now: () => 1 });

    // Non-content fields (view, active hunt) change all the time: not a content change.
    const viewOnly = JSON.parse(legacyFixtureString());
    viewOnly.state.lastView = { lng: 0, lat: 0, zoom: 3, bearing: 0, pitch: 0 };
    viewOnly.state.activeHunt = "Other";
    local.setItem(LEGACY_KEY, JSON.stringify(viewOnly));
    assert.equal(
      (await runMigrations({ backend, legacy: local, now: () => 2 })).status,
      "already-complete",
    );

    const before = await snapshot(backend);
    local.setItem(LEGACY_KEY, JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 0 }));
    const changed = await runMigrations({ backend, legacy: local, now: () => 3 });
    assert.equal(changed.ok, true);
    assert.equal(changed.status, "legacy-changed-after-migration");
    assert.match(changed.message, /not merged/);
    assert.deepEqual(await snapshot(backend), before, "nothing merged or rewritten");

    local.setItem(LEGACY_KEY, "{");
    assert.equal(
      (await runMigrations({ backend, legacy: local, now: () => 4 })).status,
      "legacy-changed-after-migration",
    );
  });

  it("maps an unknown marker kind to pin, records it, and keeps the record", async () => {
    const odd = { ...FIXTURE_WAYPOINTS[0], kind: "<img src=x onerror=alert(1)>" };
    const missing: Record<string, unknown> = { ...FIXTURE_WAYPOINTS[1] };
    delete missing.kind;
    const raw = JSON.stringify({ state: { waypoints: [odd, missing], tracks: [] }, version: 0 });
    const local = fakeLocalStorage({ [LEGACY_KEY]: raw });
    const backend = new MemoryBackend();
    const result = await runMigrations({ backend, legacy: local, now: () => 1 });
    assert.equal(result.status, "migrated");
    assert.deepEqual(result.ok && result.normalized, [
      { id: odd.id, field: "kind", from: odd.kind, to: "pin" },
      { id: missing.id, field: "kind", from: "null", to: "pin" },
    ]);
    assert.match(result.message, /2 marks had unknown types/);
    const repo = new ContentRepository(backend);
    assert.deepEqual(await repo.getWaypoint(odd.id), { ...odd, kind: "pin" });
    assert.equal((await repo.getWaypoint(String(missing.id)))?.kind, "pin");
    const meta = await backend.read(["meta"], (tx) =>
      tx.get<LegacyMigrationMeta>("meta", LEGACY_MIGRATION_KEY),
    );
    assert.equal(meta?.normalizedCount, 2);
    assert.equal(local.getItem(LEGACY_KEY), raw, "the source keeps its original kind");
    assert.equal(
      (await runMigrations({ backend, legacy: local, now: () => 2 })).status,
      "already-complete",
    );
  });

  it("does not mistake a storage conflict for another tab finishing first", async () => {
    const local = fakeLocalStorage({ [LEGACY_KEY]: legacyFixtureString() });
    const backend = new MemoryBackend();
    backend.faults.onOp = (op) => {
      if (op.type === "put") throw new StorageError("conflict", "ConstraintError");
    };
    const result = await runMigrations({ backend, legacy: local, now: () => 1 });
    assert.equal(result.ok, false);
    assert.equal(result.status, "storage-error");
    assert.equal(!result.ok && result.code, "conflict");
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
