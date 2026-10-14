import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type SettingsState } from "../../features/settings/schema.ts";
import { MemoryBackend, StorageError } from "./backend.ts";
import {
  BACKUP_LIMITS,
  createBackup,
  parseBackup,
  planRestore,
  restoreBackup,
  type ParsedBackup,
} from "./backup.ts";
import { sha256Hex } from "./digest.ts";
import { runMigrations } from "./migrations.ts";
import { canonicalJson } from "./records.ts";
import { ContentRepository } from "./repository.ts";
import {
  fakeLocalStorage,
  FIXTURE_LEGACY_WAYPOINT,
  FIXTURE_TRACKS,
  FIXTURE_WAYPOINTS,
  legacyFixtureString,
} from "./test-fixtures.ts";

const SETTINGS: SettingsState = {
  prefs: {
    ...DEFAULT_SETTINGS,
    basemap: "topo",
    distanceUnit: "metric",
    homeView: { lng: -111, lat: 34, zoom: 9, bearing: 0, pitch: 0 },
  },
  preset: "field",
  presetEdits: { field: { gpsMinMoveM: 20 } },
};

async function populated() {
  const backend = new MemoryBackend();
  await runMigrations({
    backend,
    legacy: fakeLocalStorage({ "fieldline-v1": legacyFixtureString() }),
    now: () => 1,
  });
  const repo = new ContentRepository(backend);
  await repo.putTrack({
    ...FIXTURE_TRACKS[1],
    id: "recorded-1",
    segmentStarts: [2],
    points: FIXTURE_TRACKS[1].points.map((p) => ({ ...p, accuracy: 4, altitude: null })),
  });
  await repo.deleteWaypoint(FIXTURE_WAYPOINTS[1].id, 777);
  return repo;
}

async function clean() {
  const backend = new MemoryBackend();
  await runMigrations({ backend, legacy: fakeLocalStorage(), now: () => 1 });
  return new ContentRepository(backend);
}

async function contentOf(repo: ContentRepository) {
  return {
    waypoints: await repo.listWaypoints(),
    tracks: await repo.listTracks(),
    trash: await repo.listTrash(),
  };
}

/** Re-signs an edited backup so only the intended defect is tested. */
async function resign(file: Record<string, unknown>) {
  const payload = { ...file };
  delete payload.integrity;
  return JSON.stringify({
    ...payload,
    integrity: { algorithm: "SHA-256", digest: await sha256Hex(canonicalJson(payload)) },
  });
}

async function parsed(text: string): Promise<ParsedBackup> {
  const result = await parseBackup(text);
  assert.equal(result.ok, true, result.ok ? "" : `${result.error}: ${result.message}`);
  return (result as { backup: ParsedBackup }).backup;
}

describe("full backup", () => {
  it("round-trips content and settings into a clean profile", async () => {
    const source = await populated();
    const text = await createBackup(source, {
      settings: SETTINGS,
      appVersion: "1.0.0",
      now: new Date("2026-10-13T12:00:00Z"),
    });
    const file = JSON.parse(text);
    assert.equal(file.format, "fieldline-backup");
    assert.equal(file.version, 1);
    assert.equal(file.createdAt, "2026-10-13T12:00:00.000Z");
    assert.equal(file.app.version, "1.0.0");
    assert.equal(file.settings.format, "fieldline-settings");
    assert.match(file.integrity.digest, /^[0-9a-f]{64}$/);

    const target = await clean();
    const report = await restoreBackup(target, await parsed(text));
    assert.deepEqual(report.add, { waypoints: 2, tracks: 3, trash: 1 });
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.settings, SETTINGS);
    assert.deepEqual(report.rejectedSettings, []);
    assert.deepEqual(await contentOf(target), await contentOf(source));
    assert.ok(
      (await target.getWaypoint(FIXTURE_LEGACY_WAYPOINT.id))?.name,
      "legacy-shaped records survive backup",
    );

    const trashed = (await target.listTrash())[0];
    assert.equal(trashed.itemId, FIXTURE_WAYPOINTS[1].id);
    await target.restoreFromTrash(trashed.id);
    assert.deepEqual(await target.getWaypoint(FIXTURE_WAYPOINTS[1].id), FIXTURE_WAYPOINTS[1]);
  });

  it("works without settings", async () => {
    const text = await createBackup(await populated(), { settings: null, appVersion: "1.0.0" });
    const backup = await parsed(text);
    assert.equal(backup.settings, null);
  });

  it("restoring the same backup twice skips identical records instead of duplicating them", async () => {
    const text = await createBackup(await populated(), { settings: null, appVersion: "1.0.0" });
    const target = await clean();
    await restoreBackup(target, await parsed(text));
    const before = await contentOf(target);
    const again = await restoreBackup(target, await parsed(text));
    assert.deepEqual(again.add, { waypoints: 0, tracks: 0, trash: 0 });
    assert.deepEqual(again.identical, { waypoints: 2, tracks: 3, trash: 1 });
    assert.deepEqual(await contentOf(target), before);
  });

  it("aborts on conflicting records by default, or keeps the existing ones and reports them", async () => {
    const text = await createBackup(await populated(), { settings: null, appVersion: "1.0.0" });
    const target = await clean();
    const edited = { ...FIXTURE_WAYPOINTS[0], name: "Edited here" };
    await target.putWaypoint(edited);
    const backup = await parsed(text);

    const plan = await planRestore(target, backup);
    assert.deepEqual(plan.conflicts, [{ kind: "waypoint", id: edited.id }]);
    await assert.rejects(
      restoreBackup(target, backup),
      (error: unknown) => error instanceof StorageError && error.code === "conflict",
    );
    assert.equal((await target.counts()).waypoints, 1, "nothing written");

    const report = await restoreBackup(target, backup, { onConflict: "keep-existing" });
    assert.deepEqual(report.conflicts, [{ kind: "waypoint", id: edited.id }]);
    assert.deepEqual(report.add, { waypoints: 1, tracks: 3, trash: 1 });
    assert.deepEqual(await target.getWaypoint(edited.id), edited);
  });

  it("restores all or nothing", async () => {
    const text = await createBackup(await populated(), { settings: null, appVersion: "1.0.0" });
    const target = await clean();
    const backend = target.backend as MemoryBackend;
    let puts = 0;
    backend.faults.onOp = (op) => {
      if (op.type === "put" && ++puts === 4) throw new StorageError("quota", "full");
    };
    await assert.rejects(restoreBackup(target, await parsed(text)), { code: "quota" });
    backend.faults = {};
    assert.deepEqual(await target.counts(), { waypoints: 0, tracks: 0, trash: 0 });
  });

  it("refuses to restore before the target is migrated", async () => {
    const text = await createBackup(await populated(), { settings: null, appVersion: "1.0.0" });
    await assert.rejects(
      restoreBackup(new ContentRepository(new MemoryBackend()), await parsed(text)),
      { code: "not-ready" },
    );
  });
});

describe("backup validation", () => {
  async function sample() {
    return JSON.parse(
      await createBackup(await populated(), { settings: SETTINGS, appVersion: "1.0.0" }),
    ) as Record<string, any>;
  }

  async function expectRejected(text: string, error: string, limits = BACKUP_LIMITS) {
    const result = await parseBackup(text, limits);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, error, !result.ok ? result.message : "");
  }

  it("rejects a tampered checksum or tampered content", async () => {
    const file = await sample();
    await expectRejected(
      JSON.stringify({ ...file, integrity: { algorithm: "SHA-256", digest: "0".repeat(64) } }),
      "checksum-mismatch",
    );
    file.content.waypoints[0].name = "Changed after export";
    await expectRejected(JSON.stringify(file), "checksum-mismatch");
  });

  it("rejects truncated and non-backup files", async () => {
    const text = JSON.stringify(await sample());
    await expectRejected(text.slice(0, text.length - 40), "damaged");
    await expectRejected("", "damaged");
    await expectRejected(
      JSON.stringify({ format: "fieldline-settings", version: 1 }),
      "not-a-backup",
    );
  });

  it("rejects future versions", async () => {
    await expectRejected(await resign({ ...(await sample()), version: 2 }), "future-version");
    await expectRejected(await resign({ ...(await sample()), contentSchema: 2 }), "future-version");
    const file = await sample();
    file.settings.version = 99;
    await expectRejected(await resign(file), "invalid-settings");
  });

  it("rejects oversized files and too many records", async () => {
    const text = JSON.stringify(await sample());
    await expectRejected(text, "too-large", { ...BACKUP_LIMITS, bytes: text.length - 1 });
    await expectRejected(text, "too-many-records", { ...BACKUP_LIMITS, waypoints: 1 });
    await expectRejected(text, "too-many-records", { ...BACKUP_LIMITS, pointsPerTrack: 100 });
    await expectRejected(text, "too-many-records", { ...BACKUP_LIMITS, totalPoints: 1000 });
  });

  it("rejects invalid, path-like or duplicate records even with a valid checksum", async () => {
    let file = await sample();
    file.content.waypoints[0].id = "../../evil";
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.content.tracks[0].points[3].lat = 123;
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.content.waypoints.push(file.content.waypoints[0]);
    file.counts.waypoints += 1;
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.content.trash[0].id = "waypoint:someone-else:1";
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.counts.tracks = 99;
    await expectRejected(await resign(file), "damaged");
  });

  it("rejects a re-signed backup with a marker kind the map can't draw", async () => {
    for (const kind of ["<img src=x onerror=alert(1)>", "", undefined, 3]) {
      const file = await sample();
      file.content.waypoints[0].kind = kind;
      await expectRejected(await resign(file), "invalid-records");
    }
    let file = await sample();
    delete file.content.waypoints[0].name;
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.content.trash[0].item.kind = "bogus";
    await expectRejected(await resign(file), "invalid-records");
    file = await sample();
    file.content.waypoints[0].goodWinds = ["north"];
    await expectRejected(await resign(file), "invalid-records");
  });

  it("returns a typed result for absurdly nested data instead of throwing", async () => {
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    const file = await sample();
    const text = JSON.stringify(file).replace(
      `"createdAt":"${file.createdAt}"`,
      `"createdAt":"${file.createdAt}","extra":${deep}`,
    );
    await expectRejected(text, "damaged");
    // Moderately nested unknown fields inside a record are rejected too, even when re-signed.
    let nested: unknown = 1;
    for (let i = 0; i < 40; i += 1) nested = [nested];
    const signed = await sample();
    signed.content.waypoints[0].extra = nested;
    await expectRejected(await resign(signed), "damaged");
    const shallow = await sample();
    let inner: unknown = 1;
    for (let i = 0; i < 20; i += 1) inner = { a: inner };
    shallow.content.waypoints[0].extra = inner;
    await expectRejected(await resign(shallow), "invalid-records");
  });

  it("writes nothing when validation fails", async () => {
    const target = await clean();
    const file = await sample();
    file.content.waypoints[0].lng = "east";
    const result = await parseBackup(await resign(file));
    assert.equal(result.ok, false);
    assert.deepEqual(await target.counts(), { waypoints: 0, tracks: 0, trash: 0 });
  });
});
