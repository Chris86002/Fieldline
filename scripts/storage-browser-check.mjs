#!/usr/bin/env node
/**
 * Real-browser check of the IndexedDB storage adapter (src/lib/storage).
 *
 * Bundles the storage library with Vite into a temporary directory, serves it
 * with a tiny harness page on 127.0.0.1, and drives headless Chromium:
 *   1. seed a synthetic fieldline-v1 profile (TEST FIXTURE, not real data)
 *   2. migrate → write marks, trash, a recording checkpoint, a backup
 *   3. reload the page → read everything back from IndexedDB
 *   4. transaction rollback, future-version database refusal, backup restore
 *
 * Usage: node scripts/storage-browser-check.mjs   (env STORAGE_CHECK_PORT, default 3201)
 * Not part of `npm test`: it needs Playwright's Chromium.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.STORAGE_CHECK_PORT ?? 3201);
const outDir = mkdtempSync(join(tmpdir(), "fieldline-storage-check-"));

const FIXTURE_V1 = JSON.stringify({
  state: {
    waypoints: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        name: "Fixture stand",
        kind: "stand",
        lng: -111.3,
        lat: 33.7,
        notes: "fixture ünïcode",
        hunt: "Fixture",
        goodWinds: [0, 315],
        createdAt: 1,
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        name: "Fixture old camp",
        kind: "camp",
        lng: -112.1,
        lat: 36.6,
        notes: "",
        hunt: "",
        createdAt: 2,
      },
    ],
    tracks: [
      {
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        name: "Fixture track",
        points: Array.from({ length: 2000 }, (_, i) => ({
          lng: -111.3 + i * 1e-4,
          lat: 33.7,
          t: 1_700_000_000_000 + i * 1000,
        })),
        createdAt: 3,
        visible: true,
      },
    ],
    basemap: "topo",
    imperial: true,
  },
  version: 0,
});

const HARNESS = `<!doctype html><meta charset="utf-8"><title>storage check</title>
<script type="module">import * as storage from "./storage.js"; window.storage = storage; window.ready = true;</script>`;

let server;
let browser;
try {
  await build({
    configFile: false,
    logLevel: "warn",
    resolve: { alias: { "@": join(root, "src") } },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: join(root, "src/lib/storage/index.ts"),
        formats: ["es"],
        fileName: () => "storage.js",
      },
    },
  });

  server = createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" }).end(HARNESS);
    } else if (req.url === "/storage.js") {
      res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(readFileSync(join(outDir, "storage.js")));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${port}/`;
  const load = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.ready === true);
  };

  await load();
  await page.evaluate(async (raw) => {
    localStorage.clear();
    await new Promise((done) => {
      const req = indexedDB.deleteDatabase("fieldline-content");
      req.onsuccess = req.onerror = req.onblocked = done;
    });
    localStorage.setItem("fieldline-v1", raw);
  }, FIXTURE_V1);

  // Session 1: migrate, then write through every API.
  const first = await page.evaluate(async () => {
    const s = window.storage;
    const opened = await s.openContentStorage({ legacy: localStorage });
    const repo = opened.repository;
    await repo.putWaypoint({
      id: "cccccccc-0000-4000-8000-000000000001",
      name: "Added after migration",
      kind: "pin",
      lng: -110,
      lat: 35,
      notes: "",
      hunt: "",
      goodWinds: [],
      createdAt: 10,
    });
    const trashed = await repo.deleteWaypoint("aaaaaaaa-0000-4000-8000-000000000002", 1234);
    const rec = opened.checkpoints;
    await rec.startSession({
      id: "dddddddd-0000-4000-8000-000000000001",
      name: "Browser recording",
      startedAt: 100,
    });
    const fix = (i) => ({
      lng: -111 + i * 1e-4,
      lat: 34,
      t: 1000 + i,
      accuracy: 5,
      altitude: i % 2 ? null : 1500,
      altitudeAccuracy: null,
      speed: null,
      heading: null,
    });
    await rec.appendFixes(
      "dddddddd-0000-4000-8000-000000000001",
      Array.from({ length: 600 }, (_, i) => fix(i)),
    );
    await rec.markGap("dddddddd-0000-4000-8000-000000000001");
    await rec.appendFixes("dddddddd-0000-4000-8000-000000000001", [fix(600), fix(601)]);

    // Atomicity in real IndexedDB: a callback that throws after writing leaves nothing.
    let rolledBack = false;
    try {
      await opened.backend.write(["waypoints"], async (tx) => {
        await tx.put("waypoints", "rollback-probe", { id: "rollback-probe", lng: 0, lat: 0 });
        throw new Error("simulated crash");
      });
    } catch {
      rolledBack = !(await repo.getWaypoint("rollback-probe"));
    }
    const backup = await s.createBackup(repo, { settings: null, appVersion: "check" });
    opened.backend.close();
    return {
      kind: opened.backend.kind,
      durable: opened.durable,
      migration: opened.migration,
      trashedId: trashed.id,
      rolledBack,
      backup,
    };
  });
  assert.equal(first.kind, "indexeddb");
  assert.equal(first.durable, true);
  assert.equal(first.migration.status, "migrated", JSON.stringify(first.migration));
  assert.deepEqual(first.migration.counts, { waypoints: 2, tracks: 1 });
  assert.equal(first.rolledBack, true);

  // Session 2: reload the page and read everything back.
  await load();
  const second = await page.evaluate(async () => {
    const s = window.storage;
    const opened = await s.openContentStorage({ legacy: localStorage });
    const repo = opened.repository;
    const active = await opened.checkpoints.getActiveSession();
    const result = {
      migration: opened.migration.status,
      legacyUnchanged: localStorage.getItem("fieldline-v1"),
      waypoints: (await repo.listWaypoints()).map((w) => w.id),
      firstNotes: (await repo.getWaypoint("aaaaaaaa-0000-4000-8000-000000000001"))?.notes,
      trackPoints: (await repo.listTracks()).map((t) => t.points.length),
      trash: (await repo.listTrash()).map((e) => e.itemId),
      active: active && {
        fixCount: active.fixCount,
        segments: active.segments.map((seg) => seg.length),
        firstAltitude: active.segments[0][1].altitude,
      },
    };
    const track = await opened.checkpoints.finalizeSession("dddddddd-0000-4000-8000-000000000001");
    result.finalized = { points: track.points.length, segmentStarts: track.segmentStarts };
    result.activeAfter = await opened.checkpoints.getActiveSession();
    opened.backend.close();
    return result;
  });
  assert.equal(second.migration, "already-complete");
  assert.equal(second.legacyUnchanged, FIXTURE_V1, "fieldline-v1 is byte-identical");
  assert.deepEqual(second.waypoints, [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "cccccccc-0000-4000-8000-000000000001",
  ]);
  assert.equal(second.firstNotes, "fixture ünïcode");
  assert.deepEqual(second.trackPoints, [2000]);
  assert.deepEqual(second.trash, ["aaaaaaaa-0000-4000-8000-000000000002"]);
  assert.deepEqual(second.active, { fixCount: 602, segments: [600, 2], firstAltitude: null });
  assert.deepEqual(second.finalized, { points: 602, segmentStarts: [600] });
  assert.equal(second.activeAfter, null);

  // Session 3: restore the backup into a fresh database; refuse a future-version database.
  await load();
  const third = await page.evaluate(async (backupText) => {
    const s = window.storage;
    await new Promise((done) => {
      const req = indexedDB.deleteDatabase("fieldline-content");
      req.onsuccess = req.onerror = req.onblocked = done;
    });
    localStorage.removeItem("fieldline-v1");
    const opened = await s.openContentStorage({ legacy: localStorage });
    const parsed = await s.parseBackup(backupText);
    const report = await s.restoreBackup(opened.repository, parsed.backup);
    const counts = await opened.repository.counts();
    opened.backend.close();

    await new Promise((done, fail) => {
      const req = indexedDB.open("fieldline-content-future", 9);
      req.onsuccess = () => {
        req.result.close();
        done();
      };
      req.onerror = () => fail(req.error);
    });
    let futureCode = null;
    try {
      await s.openIndexedDbBackend({ name: "fieldline-content-future" });
    } catch (error) {
      futureCode = error.code;
    }
    indexedDB.deleteDatabase("fieldline-content-future");
    const persistence = await s.requestPersistentStorage();
    return {
      migration: opened.migration.status,
      parsedOk: parsed.ok,
      add: report.add,
      counts,
      futureCode,
      persistence,
    };
  }, first.backup);
  assert.equal(third.migration, "nothing-to-migrate");
  assert.equal(third.parsedOk, true);
  assert.deepEqual(third.add, { waypoints: 2, tracks: 1, trash: 1 });
  assert.deepEqual(third.counts, { waypoints: 2, tracks: 1, trash: 1 });
  assert.equal(third.futureCode, "future-version");

  assert.deepEqual(errors, []);

  console.log("storage browser check passed (Chromium %s)", browser.version());
  const summary = {
    first: { ...first, backup: `${first.backup.length} chars` },
    second: { ...second, legacyUnchanged: second.legacyUnchanged === FIXTURE_V1 },
    third,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  rmSync(outDir, { recursive: true, force: true });
}
