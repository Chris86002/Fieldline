import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  assertEvictable,
  MemoryBackend,
  OFFLINE_STORES,
  PERSONAL_STORES,
  REPLACEABLE_STORES,
  StorageError,
  STORES,
} from "./backend.ts";
import { runMigrations } from "./migrations.ts";
import { ContentRepository } from "./repository.ts";
import { fakeLocalStorage, FIXTURE_TRACKS, FIXTURE_WAYPOINTS } from "./test-fixtures.ts";

let backend: MemoryBackend;
let repo: ContentRepository;

beforeEach(async () => {
  backend = new MemoryBackend();
  await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
  repo = new ContentRepository(backend);
  await repo.putMany({ waypoints: FIXTURE_WAYPOINTS, tracks: FIXTURE_TRACKS });
});

describe("trash", () => {
  it("moves a deleted waypoint to the trash and restores it with the same id and content", async () => {
    const original = FIXTURE_WAYPOINTS[0];
    const entry = await repo.deleteWaypoint(original.id, 1234);
    assert.equal(await repo.getWaypoint(original.id), undefined);
    assert.equal(entry.deletedAt, 1234);
    assert.deepEqual(entry.item, original, "hunt label, winds and notes travel with the item");
    assert.deepEqual(
      (await repo.listTrash()).map((e) => e.itemId),
      [original.id],
    );

    const restored = await repo.restoreFromTrash(entry.id);
    assert.deepEqual(restored, original);
    assert.deepEqual(await repo.getWaypoint(original.id), original);
    assert.deepEqual(await repo.listTrash(), []);
  });

  it("keeps a track's points and segments through delete and restore", async () => {
    const track = { ...FIXTURE_TRACKS[0], segmentStarts: [700] };
    await repo.putTrack(track);
    const entry = await repo.deleteTrack(track.id, 5);
    await repo.restoreFromTrash(entry.id);
    assert.deepEqual(await repo.getTrack(track.id), track);
  });

  it("does not overwrite a live item with the same id on restore", async () => {
    const original = FIXTURE_WAYPOINTS[0];
    const entry = await repo.deleteWaypoint(original.id, 10);
    const replacement = { ...original, name: "Re-imported" };
    await repo.putWaypoint(replacement);
    await assert.rejects(repo.restoreFromTrash(entry.id), { code: "conflict" });
    assert.deepEqual(await repo.getWaypoint(original.id), replacement);
    assert.equal((await repo.listTrash()).length, 1);
  });

  it("permanently deletes only on explicit request", async () => {
    const a = await repo.deleteWaypoint(FIXTURE_WAYPOINTS[0].id, 1);
    await repo.deleteWaypoint(FIXTURE_WAYPOINTS[1].id, 2);
    await repo.deleteTrack(FIXTURE_TRACKS[1].id, 3);
    await repo.purgeTrash(a.id);
    assert.deepEqual(
      (await repo.listTrash()).map((e) => e.deletedAt),
      [3, 2],
    );
    await assert.rejects(repo.restoreFromTrash(a.id), { code: "not-found" });
    assert.equal(await repo.emptyTrash(), 2);
    assert.deepEqual(await repo.listTrash(), []);
  });

  it("is atomic: a failed delete leaves the item live and the trash unchanged", async () => {
    backend.faults.onOp = (op) => {
      if (op.type === "delete")
        throw new StorageError("aborted", "crash between trash write and delete");
    };
    await assert.rejects(repo.deleteWaypoint(FIXTURE_WAYPOINTS[0].id, 1), { code: "aborted" });
    backend.faults = {};
    assert.ok(await repo.getWaypoint(FIXTURE_WAYPOINTS[0].id));
    assert.deepEqual(await repo.listTrash(), []);
  });

  it("is never emptied by cache clearing", async () => {
    await repo.deleteWaypoint(FIXTURE_WAYPOINTS[0].id, 1);
    assert.ok(PERSONAL_STORES.includes("trash"));
    assert.ok(!REPLACEABLE_STORES.includes("trash"));
    await backend.write(["assets", "assetData"], async (tx) => {
      await tx.put("assets", "https://example.test/t#x", { refs: ["p@1"] });
      await tx.put("assetData", "https://example.test/t#x", new ArrayBuffer(4));
    });
    assert.deepEqual(await repo.clearReplaceableData(), [...OFFLINE_STORES]);
    assert.equal(await backend.read(["assets"], (tx) => tx.count("assets")), 0);
    assert.equal((await repo.listTrash()).length, 1);
    assert.equal((await repo.counts()).waypoints, 1);
  });

  it("classifies every store exactly once and clears offline package stores only together", async () => {
    const all = [...PERSONAL_STORES, ...REPLACEABLE_STORES].sort();
    assert.deepEqual(all, [...STORES].sort());
    assert.ok(!PERSONAL_STORES.some((store) => REPLACEABLE_STORES.includes(store)));
    await assert.rejects(repo.clearReplaceableData(["assets"]), /cleared together/);
  });

  it("refuses to clear any personal or unlisted store as a cache", async () => {
    await repo.deleteWaypoint(FIXTURE_WAYPOINTS[0].id, 1);
    for (const store of ["trash", "waypoints", "sessions"] as const) {
      await assert.rejects(repo.clearReplaceableData([store]), { code: "invalid" });
    }
    assert.equal((await repo.listTrash()).length, 1);
    assert.equal((await repo.counts()).waypoints, 1);
    // A store classified as both personal and replaceable is a bug: refuse everything.
    assert.throws(
      () => assertEvictable([], { personal: ["trash"], replaceable: ["trash"] }),
      /both personal and replaceable/,
    );
    assert.throws(() => assertEvictable(["trash"], { personal: [], replaceable: [] }), {
      code: "invalid",
    });
  });

  it("repository writes reject waypoints the map can't draw", async () => {
    const bad = { ...FIXTURE_WAYPOINTS[0], id: "new-1", kind: "<img src=x>" };
    await assert.rejects(repo.putWaypoint(bad as never), { code: "invalid" });
    await assert.rejects(repo.putMany({ waypoints: [FIXTURE_WAYPOINTS[0], bad as never] }), {
      code: "invalid",
    });
    const noName: Record<string, unknown> = { ...FIXTURE_WAYPOINTS[0], id: "new-2" };
    delete noName.name;
    await assert.rejects(repo.putWaypoint(noName as never), { code: "invalid" });
    assert.equal(await repo.getWaypoint("new-1"), undefined);
  });

  it("reports deleting something that's already gone", async () => {
    await assert.rejects(repo.deleteWaypoint("missing-id"), { code: "not-found" });
  });
});
