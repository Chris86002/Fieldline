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
 *   3. Online: plans and downloads a package into real IndexedDB, verifies it.
 *   4. context.setOffline(true), reload, and render a MapLibre map whose
 *      sources all go through fltile:// (raster, OFM TileJSON + vector tiles,
 *      glyphs, raster-dem). Confirms every tile came from the package and the
 *      network was never used.
 *
 * Usage: node scripts/offline-browser-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORIGIN = "http://fieldline.test";
const outDir = mkdtempSync(join(tmpdir(), "fieldline-offline-check-"));
const entry = join(outDir, "entry.ts");
const src = (path) => JSON.stringify(join(root, "src", path).replaceAll("\\", "/"));
writeFileSync(
  entry,
  `export * as maplibregl from ${JSON.stringify(join(root, "node_modules/maplibre-gl/dist/maplibre-gl.mjs").replaceAll("\\", "/"))};
export * from ${src("lib/offline/index.ts")};
export { openIndexedDbBackend, requestPersistentStorage } from ${src("lib/storage/indexeddb.ts")};
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

  // ---- Online: plan and download ----
  await load();
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
  console.log(JSON.stringify({ online, fetchedDuringDownload, offline }, null, 2));
} finally {
  await browser?.close();
  rmSync(outDir, { recursive: true, force: true });
}
