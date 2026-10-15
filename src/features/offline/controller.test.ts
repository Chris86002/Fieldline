import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _setTileEnlarger, ancestorTile, loadTile } from "../../lib/hunt/tiles.ts";
import { _resetProviderBackoff } from "../../lib/offline/download.ts";
import { planPackage } from "../../lib/offline/plan.ts";
import { downloadOptions, fakeProvider, SMALL_AREA, smallPlan } from "../../lib/offline/test-fixtures.ts";
import { MemoryBackend } from "../../lib/storage/backend.ts";
import {
  checkPackage,
  coverageAt,
  deleteArea,
  downloadArea,
  pauseDownload,
  resetOfflineForTests,
  resumePackage,
  startOfflinePackages,
  updateArea,
  useOffline,
} from "./controller.ts";
import { areaFeatures, coverageText, defaultLayers, defaultZooms, packageActions, stateLabel, unpackageableShown } from "./model.ts";

afterEach(() => {
  resetOfflineForTests();
  _resetProviderBackoff();
});

async function started(provider = fakeProvider()) {
  const backend = new MemoryBackend();
  await startOfflinePackages(backend, { download: downloadOptions(provider) });
  return { backend, provider };
}

describe("offline packages in the app", () => {
  it("stays off with the reason when storage isn't durable, and serves nothing from packages", async () => {
    await startOfflinePackages(null, { reason: "Private browsing." });
    const state = useOffline.getState();
    assert.equal(state.status, "unavailable");
    assert.match(state.reason ?? "", /durable storage\. Private browsing\./);
    assert.equal(await downloadArea(smallPlan(), "Nope"), null);
    assert.equal(await coverageAt({ lng: -111.5, lat: 34.5 }), null);
  });

  it("downloads an area to ready, lists it with its size, and covers points inside it", async () => {
    await started();
    const id = await downloadArea(smallPlan(), "Mogollon Rim");
    assert.ok(id);
    const state = useOffline.getState();
    assert.equal(state.busy, null);
    assert.equal(state.packages.length, 1);
    assert.equal(state.packages[0].state, "ready");
    assert.equal(state.packages[0].name, "Mogollon Rim");
    assert.ok(state.bytes[id] > 0);
    assert.ok(state.totalBytes > 0);
    assert.equal(state.persistence, "granted");
    assert.match(state.notice?.text ?? "", /^Ready offline: all [\d,]+ files downloaded and checked\.$/);

    const here = await coverageAt({ lng: -111.5, lat: 34.5 });
    assert.equal(here?.covered, true);
    // Shown in map zooms: the fixture's tile zooms 12–13 are map zooms 11–12 for topo, 12–13 for vector tiles.
    assert.match(coverageText(here, true) ?? "", /^Offline here: topo zooms 11–12, public land zooms 11–12, roads and labels zooms 12–13, terrain zooms 11–12 \(“Mogollon Rim”\)\.$/);
    const away = await coverageAt({ lng: -100, lat: 40 });
    assert.equal(coverageText(away, true), "Not downloaded for offline use.");
    assert.equal(coverageText(away, false), null);
  });

  it("serves downloaded tiles through fltile://, and looks in packages only while one is usable", async () => {
    await started();
    const range = smallPlan().layers.find((l) => l.layerId === "usgs-topo")!.ranges[0];
    const url = `fltile://https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/12/${range.y0}/${range.x0}`;
    const realFetch = globalThis.fetch;
    let network = 0;
    globalThis.fetch = (async () => {
      network += 1;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    try {
      await loadTile({ url }, new AbortController());
      assert.equal(network, 1, "nothing downloaded yet: the network answers");

      const id = (await downloadArea(smallPlan(), "Served"))!;
      const tile = await loadTile({ url }, new AbortController());
      assert.ok(tile.data instanceof ArrayBuffer);
      assert.equal(network, 1, "a packaged tile needs no network request");

      await deleteArea(id);
      await loadTile({ url }, new AbortController());
      assert.equal(network, 2, "after deleting, the network answers again");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("pauses mid-download, keeps what it has, and resumes to ready", async () => {
    await started(fakeProvider({ delayMs: 5 }));
    const unsubscribe = useOffline.subscribe((state) => {
      if ((state.busy?.progress?.done ?? 0) >= 3) pauseDownload();
    });
    const id = await downloadArea(smallPlan(), "Paused area");
    unsubscribe();
    assert.ok(id);
    let state = useOffline.getState();
    assert.equal(state.packages[0].state, "paused");
    assert.match(state.notice?.text ?? "", /^Paused\./);
    assert.deepEqual(packageActions(state.packages[0], false).resume, true);
    assert.equal(stateLabel(state.packages[0]).text, "Paused");

    await resumePackage(id);
    state = useOffline.getState();
    assert.equal(state.packages[0].state, "ready");
    assert.equal(stateLabel(state.packages[0]).text, "Ready offline");
  });

  it("runs one operation at a time", async () => {
    await started(fakeProvider({ delayMs: 5 }));
    const first = downloadArea(smallPlan(), "First");
    // Wait until the first download is running.
    while (!useOffline.getState().busy) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await downloadArea(smallPlan({ minZoom: 13 }), "Second");
    assert.equal(second, null);
    assert.match(useOffline.getState().notice?.text ?? "", /Another download is running/);
    await first;
    assert.equal(useOffline.getState().packages.length, 1);
  });

  it("checks, updates and deletes an area", async () => {
    await started();
    const id = (await downloadArea(smallPlan(), "Unit 6A"))!;
    await checkPackage(id);
    assert.match(useOffline.getState().notice?.text ?? "", /^Checked: all [\d,]+ files are intact\.$/);

    await updateArea(id);
    let state = useOffline.getState();
    assert.match(state.notice?.text ?? "", /^Updated:/);
    assert.equal(state.packages[0].activeVersion, 2);

    await deleteArea(id);
    state = useOffline.getState();
    assert.equal(state.packages.length, 0);
    assert.equal(state.totalBytes, 0);
    assert.match(state.notice?.text ?? "", /^Deleted “Unit 6A” \([\d,]+ files\)/);
  });

  it("reports a provider failure with the files that didn't download", async () => {
    const provider = fakeProvider();
    provider.override = (url) => (url.includes("USGSTopo") ? new Response("nope", { status: 500 }) : null);
    await started(provider);
    const id = (await downloadArea(smallPlan(), "Flaky"))!;
    const state = useOffline.getState();
    assert.equal(state.packages[0].state, "failed");
    assert.equal(state.notice?.tone, "error");
    assert.equal(stateLabel(state.packages[0]).text, "Didn't finish");
    assert.equal(packageActions(state.packages[0], false).resume, true);

    provider.override = null;
    await resumePackage(id);
    assert.equal(useOffline.getState().packages[0].state, "ready");
  });
});

describe("map zooms and enlarging offline", () => {
  const USGS_TOPO = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/";

  it("plans each layer at the tile zooms the map requests for it", () => {
    const plan = planPackage({ ...SMALL_AREA, minZoom: 11, maxZoom: 12, zoomBasis: "map", layers: ["usgs-topo", "ofm-vector", "dem"] });
    const zooms = Object.fromEntries(plan.layers.map((l) => [l.layerId, [l.minZoom, l.maxZoom]]));
    // 256-pixel rasters and terrain are one zoom deeper than the map; 512-pixel vector tiles aren't.
    assert.deepEqual(zooms, { "usgs-topo": [12, 13], "ofm-vector": [11, 12], dem: [12, 13], glyphs: [0, 0] });
    assert.equal(plan.minZoom, 11);
    assert.equal(plan.maxZoom, 12);
    // The default stays tile zooms for every layer.
    const tile = planPackage({ ...SMALL_AREA, minZoom: 11, maxZoom: 12, layers: ["usgs-topo"] });
    assert.deepEqual([tile.layers[0].minZoom, tile.layers[0].maxZoom], [11, 12]);
    // Clamped to each layer's deepest tiles.
    const deep = planPackage({ ...SMALL_AREA, minZoom: 14, maxZoom: 15, zoomBasis: "map", layers: ["dem", "usgs-topo"] });
    assert.deepEqual(deep.layers.map((l) => [l.layerId, l.minZoom, l.maxZoom]).slice(0, 2), [["usgs-topo", 15, 16], ["dem", 14, 14]]);
  });

  it("finds a raster tile's ancestor and the square of it to enlarge", () => {
    // USGS paths are z/y/x.
    assert.deepEqual(ancestorTile(`${USGS_TOPO}15/6481/3109`, 2), { url: `${USGS_TOPO}13/1620/777`, sx: 64, sy: 64, size: 64, terrain: false });
    // Terrain paths are z/x/y.
    const grids = [{ prefix: "http://localhost:8080/api/dem/", order: "zxy" as const, terrain: true }];
    assert.deepEqual(ancestorTile("http://localhost:8080/api/dem/14/3111/6479", 1, grids), {
      url: "http://localhost:8080/api/dem/13/1555/3239",
      sx: 128,
      sy: 128,
      size: 128,
      terrain: true,
    });
    assert.equal(ancestorTile("https://tiles.openfreemap.org/planet/v/12/1/2.pbf", 1), null);
    assert.equal(ancestorTile(`${USGS_TOPO}1/0/0`, 2), null);
  });

  it("offline, enlarges a tile from the deepest downloaded level instead of leaving it blank", async () => {
    await started();
    // Map zoom 12 → topo tiles at zoom 13.
    const plan = planPackage({ ...SMALL_AREA, minZoom: 12, maxZoom: 12, zoomBasis: "map", layers: ["usgs-topo"] });
    await downloadArea(plan, "Enlarge");
    const range = plan.layers[0].ranges[0];
    const crops: unknown[] = [];
    _setTileEnlarger(async (image, crop) => {
      crops.push({ bytes: image.data.byteLength > 0, ...crop });
      return new Uint8Array([9]).buffer;
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    try {
      // Two zooms deeper than the package: the child at (x0*4+1, y0*4+2).
      const tile = await loadTile({ url: `fltile://${USGS_TOPO}15/${range.y0 * 4 + 2}/${range.x0 * 4 + 1}` }, new AbortController());
      assert.deepEqual([...new Uint8Array(tile.data as ArrayBuffer)], [9]);
      assert.deepEqual(crops, [{ bytes: true, sx: 64, sy: 128, size: 64, smooth: true }]);
      // Outside every package there's nothing to enlarge: the failure stands.
      await assert.rejects(loadTile({ url: `fltile://${USGS_TOPO}15/100/100` }, new AbortController()));
    } finally {
      globalThis.fetch = realFetch;
      _setTileEnlarger(null);
    }
  });
});

describe("offline screen helpers", () => {
  it("preselects storable layers from what the map shows", () => {
    assert.deepEqual(defaultLayers({ basemap: "hybrid", showPublic: true, terrain: false, showShade: true }), ["usgs-imagery", "blm-sma", "ofm-vector", "dem"]);
    assert.deepEqual(defaultLayers({ basemap: "topo", showPublic: false, terrain: false, showShade: false }), ["usgs-topo", "ofm-vector"]);
    assert.deepEqual(defaultLayers({ basemap: "street", showPublic: false, terrain: true, showShade: false }), ["ofm-vector", "dem"]);
    assert.deepEqual(unpackageableShown({ basemap: "satellite", showUnits: true }), ["esri-imagery", "hunt-units"]);
    assert.deepEqual(unpackageableShown({ basemap: "usgs", showUnits: false }), []);
  });

  it("lists Esri imagery and hunt units as excluded with a reason when they're on the map", () => {
    const plan = planPackage({ ...SMALL_AREA, layers: ["usgs-imagery", ...unpackageableShown({ basemap: "hybrid", showUnits: true })] });
    assert.deepEqual(plan.excluded.map((e) => e.layerId), ["esri-imagery", "hunt-units"]);
    assert.ok(plan.ok);
  });

  it("picks a zoom range around the view", () => {
    assert.deepEqual(defaultZooms(11.6), { minZoom: 11, maxZoom: 13 });
    assert.deepEqual(defaultZooms(2), { minZoom: 4, maxZoom: 6 });
    assert.deepEqual(defaultZooms(15.2), { minZoom: 14, maxZoom: 15 });
    assert.deepEqual(defaultZooms(Number.NaN), { minZoom: 10, maxZoom: 12 });
  });

  it("draws area outlines, across the antimeridian in one piece", () => {
    const fc = areaFeatures([], { west: 179, south: 50, east: -179, north: 51 });
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].properties.kind, "preview");
    const ring = fc.features[0].geometry.coordinates[0];
    assert.deepEqual(ring[1], [181, 50]);
  });
});
