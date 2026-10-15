#!/usr/bin/env node
/**
 * Real-browser check of offline map packages (src/lib/offline + fltile://).
 *
 * Makes a few dozen polite live requests (one small area, zooms 11–12: USGS
 * topo, BLM SMA, OpenFreeMap vector tiles + 9 glyph files, terrain), so it
 * needs network access and is NOT part of `npm test`.
 *
 *   1. Bundles the offline library, tiles.ts and MapLibre with Vite.
 *   2. Serves a harness page at http://fieldline.test (Playwright routes, no
 *      real server; /api/dem proxies AWS terrain like the app's route).
 *   3. Real layout upgrade: a populated IndexedDB version-1 database (built
 *      with the version-1 UPGRADES step) is opened by this build; every
 *      content record must be unchanged and the 4 offline stores must exist.
 *   4. Online: plans and downloads a package into real IndexedDB, verifies it.
 *   5. context.setOffline(true), reload, and render a MapLibre map whose
 *      sources all go through fltile:// (raster, OFM TileJSON + vector tiles,
 *      glyphs, raster-dem). Confirms every tile came from the package and the
 *      network was never used.
 *
 * Usage: node scripts/offline-browser-check.mjs   (env OFFLINE_CHECK_PORT names the origin's port)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Served by Playwright routes (no socket is opened); the port only names the origin.
const port = Number(process.env.OFFLINE_CHECK_PORT ?? 3301);
const ORIGIN = `http://fieldline.test:${port}`;
const outDir = mkdtempSync(join(tmpdir(), "fieldline-offline-check-"));
const entry = join(outDir, "entry.ts");
const src = (path) => JSON.stringify(join(root, "src", path).replaceAll("\\", "/"));
writeFileSync(
  entry,
  `export * as maplibregl from ${JSON.stringify(join(root, "node_modules/maplibre-gl/dist/maplibre-gl.mjs").replaceAll("\\", "/"))};
export * from ${src("lib/offline/index.ts")};
export { IDB_VERSION, openIndexedDbBackend, requestPersistentStorage, UPGRADES } from ${src("lib/storage/indexeddb.ts")};
export { cachedTile, installTileProtocol, setPackageTileSource, tileProtocolStats, TILES } from ${src("lib/hunt/tiles.ts")};
`,
);

const HARNESS = `<!doctype html><meta charset="utf-8"><title>offline check</title>
<link rel="stylesheet" href="/maplibre-gl.css">
<style>body{margin:0}#map{width:320px;height:320px}</style>
<div id="map"></div>
<script type="module">import * as lib from "/lib.js"; window.lib = lib; window.ready = true;</script>`;

const CENTER = { lng: -111.62, lat: 35.2 }; // near Flagstaff, AZ
const ZOOM = 11.3; // raster/terrain request z12 tiles, OFM vector z11

let browser;
try {
  await build({
    configFile: false,
    logLevel: "warn",
    resolve: { alias: { "@": join(root, "src") } },
    build: {
      outDir: join(outDir, "dist"),
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ["es"], fileName: () => "lib.js" },
    },
  });
  const files = {
    "/": { body: HARNESS, type: "text/html" },
    "/lib.js": { body: readFileSync(join(outDir, "dist", "lib.js")), type: "text/javascript" },
    "/maplibre-gl-worker.mjs": {
      body: readFileSync(join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs")),
      type: "text/javascript",
    },
    "/maplibre-gl.css": {
      body: readFileSync(join(root, "node_modules/maplibre-gl/dist/maplibre-gl.css")),
      type: "text/css",
    },
  };

  browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext();
  const upstream = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const dem = /^\/api\/dem\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (dem) {
      // Same behavior as src/routes/api/dem: proxy AWS Terrain Tiles.
      const target = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${dem[1]}/${dem[2]}/${dem[3]}.png`;
      upstream.push(target);
      const response = await fetch(target);
      return route.fulfill({
        status: response.status,
        contentType: "image/png",
        body: Buffer.from(await response.arrayBuffer()),
      });
    }
    const file = files[url.pathname];
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: file.type, body: file.body });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const networkLog = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(ORIGIN)) networkLog.push(request.url());
  });
  const load = async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.ready === true);
  };

  // ---- Real IndexedDB layout upgrade: a populated version-1 database opened by this build ----
  await load();
  const upgrade = await page.evaluate(async () => {
    const lib = window.lib;
    const name = "fieldline-upgrade-check";
    const done = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = resolve;
    });
    // TEST FIXTURE records (synthetic), written through the version-1 layout step.
    const fixture = {
      waypoints: {
        "aaaaaaaa-0000-4000-8000-000000000001": { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Fixture stand", kind: "stand", lng: -111.3, lat: 33.7, notes: "ünïcode", hunt: "", goodWinds: [0, 315], createdAt: 1 },
      },
      tracks: {
        "bbbbbbbb-0000-4000-8000-000000000001": { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "Fixture track", points: [{ lng: -111.3, lat: 33.7, t: 1 }, { lng: -111.31, lat: 33.71, t: 2 }], createdAt: 2, visible: true },
      },
      trash: {
        "waypoint:cccccccc-0000-4000-8000-000000000001:5": { id: "waypoint:cccccccc-0000-4000-8000-000000000001:5", kind: "waypoint", itemId: "cccccccc-0000-4000-8000-000000000001", deletedAt: 5, item: { id: "cccccccc-0000-4000-8000-000000000001", name: "Gone", kind: "pin", lng: 0, lat: 0, notes: "", hunt: "", createdAt: 3 } },
      },
      sessions: { "dddddddd-0000-4000-8000-000000000001": { id: "dddddddd-0000-4000-8000-000000000001", name: "Rec", startedAt: 9, nextSeq: 1, fixCount: 1 } },
      chunks: { "dddddddd-0000-4000-8000-000000000001:00000000": { seq: 0, fixes: [{ lng: 1, lat: 2, t: 3 }] } },
      meta: { schema: { version: 1, createdAt: 1, lastStep: "v0-v1" } },
    };
    const open1 = indexedDB.open(name, 1);
    open1.onupgradeneeded = () => lib.UPGRADES[1](open1.result);
    const v1 = await done(open1);
    const v1Stores = [...v1.objectStoreNames].sort();
    const tx = v1.transaction(Object.keys(fixture), "readwrite");
    for (const [store, records] of Object.entries(fixture))
      for (const [key, value] of Object.entries(records)) tx.objectStore(store).put(value, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    v1.close();

    // This build opens it (IDB_VERSION 2): the upgrade runs for real.
    const backend = await lib.openIndexedDbBackend({ name });
    const contentStores = Object.keys(fixture);
    const after = {};
    await backend.read(contentStores, async (t) => {
      for (const store of contentStores) {
        const keys = await t.getAllKeys(store);
        after[store] = {};
        for (const key of keys) after[store][key] = await t.get(store, key);
      }
    });
    const offlineCounts = await backend.read(
      ["packages", "packageAssets", "assets", "assetData"],
      async (t) => [await t.count("packages"), await t.count("packageAssets"), await t.count("assets"), await t.count("assetData")],
    );
    backend.close();
    const reopened = await done(indexedDB.open(name));
    const v2 = { version: reopened.version, stores: [...reopened.objectStoreNames].sort() };
    reopened.close();
    indexedDB.deleteDatabase(name);
    return {
      v1Stores,
      v2,
      intact: JSON.stringify(after) === JSON.stringify(fixture),
      offlineCounts,
      expectedVersion: lib.IDB_VERSION,
    };
  });
  assert.deepEqual(upgrade.v1Stores, ["chunks", "meta", "sessions", "tracks", "trash", "waypoints"]);
  assert.equal(upgrade.v2.version, 2);
  assert.equal(upgrade.expectedVersion, 2);
  assert.deepEqual(upgrade.v2.stores, [
    "assetData",
    "assets",
    "chunks",
    "meta",
    "packageAssets",
    "packages",
    "sessions",
    "tracks",
    "trash",
    "waypoints",
  ]);
  assert.equal(upgrade.intact, true, "every content record survived the upgrade unchanged");
  assert.deepEqual(upgrade.offlineCounts, [0, 0, 0, 0]);

  // ---- Online: plan and download ----
  const online = await page.evaluate(
    async ({ center, zoom }) => {
      const lib = window.lib;
      await new Promise((done) => {
        const req = indexedDB.deleteDatabase("fieldline-content");
        req.onsuccess = req.onerror = req.onblocked = done;
      });
      // Compute the view's bounds without loading any tiles.
      lib.maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
      const probe = new lib.maplibregl.Map({
        container: "map",
        style: { version: 8, sources: {}, layers: [] },
        center: [center.lng, center.lat],
        zoom,
        attributionControl: false,
      });
      const b = probe.getBounds();
      probe.remove();
      const pad = 0.01;
      const bounds = { west: b.getWest() - pad, south: b.getSouth() - pad, east: b.getEast() + pad, north: b.getNorth() + pad };
      const plan = lib.planPackage({
        bounds,
        minZoom: 11,
        maxZoom: 12,
        layers: ["usgs-topo", "blm-sma", "ofm-vector", "dem", "esri-imagery", "hunt-units"],
      });
      const backend = await lib.openIndexedDbBackend();
      const store = new lib.OfflinePackageStore(backend);
      const created = await store.createPackage(plan, { name: "Browser check" });
      const started = Date.now();
      const result = await lib.downloadPackage(store, created.packageId, {});
      const manifest = await store.getManifest(created.packageId);
      const usage = await store.storageUsage();
      backend.close();
      return {
        plan: { ok: plan.ok, totals: plan.totals, excluded: plan.excluded.map((e) => e.layerId), layers: plan.layers.map((l) => [l.layerId, l.assetCount]) },
        state: result.state,
        failed: result.failed,
        persistence: result.persistence,
        ms: Date.now() - started,
        manifest: {
          integrity: manifest.integrityStatus.status,
          assets: manifest.requiredAssets.length,
          checksums: Object.keys(manifest.checksums).length,
          actualBytes: manifest.actualBytes,
          sourceVersions: manifest.sourceVersions,
          layers: manifest.layers.map((l) => ({ id: l.layerId, assets: l.assetCount, verified: l.verified, absent: l.absent })),
        },
        uniqueBytes: usage.uniqueBytes,
      };
    },
    { center: CENTER, zoom: ZOOM },
  );
  assert.equal(online.state, "ready", JSON.stringify(online.failed));
  assert.deepEqual(online.plan.excluded.sort(), ["esri-imagery", "hunt-units"]);
  assert.equal(online.manifest.integrity, "ok");
  assert.equal(online.manifest.checksums, online.manifest.assets);
  const fetchedDuringDownload = networkLog.length + upstream.length;

  // ---- Offline: reload and render only from the package ----
  networkLog.length = 0;
  upstream.length = 0;
  await context.setOffline(true);
  await load();
  const offline = await page.evaluate(
    async ({ center, zoom, origin }) => {
      const lib = window.lib;
      const ml = lib.maplibregl;
      ml.setWorkerUrl("/maplibre-gl-worker.mjs");
      lib.installTileProtocol(ml);
      const backend = await lib.openIndexedDbBackend();
      const store = new lib.OfflinePackageStore(backend);
      lib.setPackageTileSource(lib.createPackageTileSource(store));
      const [status] = await store.listPackages();
      const coverage = await store.coverage({ lng: center.lng, lat: center.lat });
      const mapErrors = [];
      const map = new ml.Map({
        container: "map",
        center: [center.lng, center.lat],
        zoom,
        fadeDuration: 0,
        attributionControl: false,
        style: {
          version: 8,
          glyphs: lib.cachedTile("https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"),
          sources: {
            topo: { type: "raster", tiles: [lib.cachedTile(lib.TILES.topo)], tileSize: 256, maxzoom: 16 },
            sma: { type: "raster", tiles: [lib.cachedTile(lib.TILES.sma)], tileSize: 256, maxzoom: 16 },
            ofm: { type: "vector", url: lib.cachedTile("https://tiles.openfreemap.org/planet") },
            dem: { type: "raster-dem", tiles: [lib.cachedTile(`${origin}/api/dem/{z}/{x}/{y}`)], encoding: "terrarium", tileSize: 256, maxzoom: 14 },
          },
          layers: [
            { id: "topo", type: "raster", source: "topo" },
            { id: "sma", type: "raster", source: "sma", paint: { "raster-opacity": 0.4 } },
            { id: "shade", type: "hillshade", source: "dem" },
            { id: "roads", type: "line", source: "ofm", "source-layer": "transportation" },
            { id: "water", type: "fill", source: "ofm", "source-layer": "water" },
            {
              id: "labels",
              type: "symbol",
              source: "ofm",
              "source-layer": "transportation_name",
              layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "symbol-placement": "line" },
            },
            {
              id: "place",
              type: "symbol",
              source: "ofm",
              "source-layer": "place",
              layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"] },
            },
          ],
        },
      });
      map.on("error", (event) => mapErrors.push(String(event.error?.message ?? event.error)));
      await new Promise((done) => map.once("idle", done));
      const vectorFeatures = map.querySourceFeatures("ofm", { sourceLayer: "transportation" }).length;
      const labels = map.queryRenderedFeatures({ layers: ["labels", "place"] }).length;
      const result = {
        state: status.state,
        covered: coverage.covered,
        coverageLayers: coverage.layers,
        stats: lib.tileProtocolStats(),
        loaded: ["topo", "sma", "ofm", "dem"].map((id) => [id, map.isSourceLoaded(id)]),
        vectorFeatures,
        labels,
        mapErrors,
        online: navigator.onLine,
      };
      map.remove();
      backend.close();
      return result;
    },
    { center: CENTER, zoom: ZOOM, origin: ORIGIN },
  );
  await context.setOffline(false);

  assert.equal(offline.online, false, "the page saw itself offline");
  assert.equal(offline.state, "ready");
  assert.equal(offline.covered, true);
  assert.ok(offline.stats.package > 0, JSON.stringify(offline.stats));
  assert.equal(offline.stats.network, 0, JSON.stringify(offline.stats));
  assert.equal(offline.stats.failed, 0, JSON.stringify(offline));
  assert.deepEqual(offline.mapErrors, []);
  assert.ok(offline.loaded.every(([, loaded]) => loaded), JSON.stringify(offline.loaded));
  assert.ok(offline.vectorFeatures > 0, "vector tiles decoded from the package");
  assert.deepEqual(networkLog, [], "no external requests while offline");
  assert.deepEqual(upstream, []);
  assert.deepEqual(errors, []);

  console.log("offline browser check passed (Chromium %s)", browser.version());
  console.log(JSON.stringify({ upgrade, online, fetchedDuringDownload, offline }, null, 2));
} finally {
  await browser?.close();
  rmSync(outDir, { recursive: true, force: true });
}
