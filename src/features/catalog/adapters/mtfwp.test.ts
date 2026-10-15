import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { layerStatus, jurisdictionsInBounds } from "../coverage.ts";
import { providersForView } from "../discovery.ts";
import { searchUnits } from "../search.ts";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonsContain } from "../unit-geometry.ts";
import { allowedUrl } from "./arcgis.ts";
import { AZGFD_LAYER_URL, createAzgfdAdapter } from "./azgfd.ts";
import { createIdfgAdapter, IDFG_LAYER_URL } from "./idfg.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import { createMtfwpAdapter, mapMtfwpAttributes, MTFWP_INFO, MTFWP_LAYER_URL } from "./mtfwp.ts";
import {
  AZ_FIELD_NAMES,
  azCell,
  azFeature,
  fakeArcgis,
  ID_FIELD_NAMES,
  idCell,
  idFeature,
  layerMetadata,
  squareRing,
  type FakeLayer,
} from "./fixtures/arcgis-fixtures.ts";
import { mtCell, mtFeature, mtFeatures, mtLayerMetadata } from "./fixtures/mtfwp-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function mtLayer(features = mtFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: mtLayerMetadata(50), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function mtAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createMtfwpAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

describe("MTFWP adapter: field mapping", () => {
  it("maps DISTRICT, REG, REGYEAR and AREA_MI as specified", () => {
    assert.deepEqual(mapMtfwpAttributes({ DISTRICT: " 261 ", REG: "2", REGYEAR: "2099", AREA_MI: 812.4 }), {
      code: "261",
      regionName: "Region 2",
      speciesTags: ["Deer", "Elk", "Mountain lion"],
      seasonContext: "Regulation year 2099",
      landNote: "",
      forest: "",
      sqMiles: 812.4,
    });
  });

  it("keeps missing values unknown instead of inventing them", () => {
    const sparse = mapMtfwpAttributes({ DISTRICT: "300", REG: null, REGYEAR: "", AREA_MI: null });
    assert.ok(sparse);
    assert.equal(sparse.regionName, "");
    assert.equal(sparse.seasonContext, null);
    assert.equal(sparse.sqMiles, null, "a null AREA_MI is not zero");
    assert.equal(mapMtfwpAttributes({ DISTRICT: "300" })?.sqMiles, null, "an absent AREA_MI is not zero");
    assert.equal(mapMtfwpAttributes({ DISTRICT: "300", AREA_MI: 0 })?.sqMiles, null, "a zero AREA_MI is not an area");
    assert.equal(mapMtfwpAttributes({ DISTRICT: "300", AREA_MI: "" })?.sqMiles, null);
    // Numeric REG / REGYEAR from a server that types them differently.
    const numeric = mapMtfwpAttributes({ DISTRICT: 410, REG: 4, REGYEAR: 2099 });
    assert.equal(numeric?.code, "410");
    assert.equal(numeric?.regionName, "Region 4");
    assert.equal(numeric?.seasonContext, "Regulation year 2099");
    // Rows without a district are not units.
    assert.equal(mapMtfwpAttributes({ DISTRICT: null }), null);
    assert.equal(mapMtfwpAttributes({ DISTRICT: "  " }), null);
  });

  it("builds namespaced ids that do not collide with AZ or ID codes", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "22", azCell(0, 0))] },
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "22", idCell(0, 0))] },
      [MTFWP_LAYER_URL]: mtLayer([mtFeature(1, "22", mtCell(0, 0)), mtFeature(2, "261", mtCell(1, 0), { REG: null, AREA_MI: null })]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const id = await createIdfgAdapter({ storage, now: () => T0 }).load();
    const mt = await mtAdapter(clock(), storage).adapter.load();
    assert.equal(mt.status, "available");
    const ids = [...az.units, ...id.units, ...mt.units].map((unit) => unit.id);
    assert.deepEqual(ids, [
      "us-az:azgfd-gmu:22",
      "us-id:idfg-gmu:22",
      "us-mt:mtfwp-deer-elk-lion:22",
      "us-mt:mtfwp-deer-elk-lion:261",
    ]);
    assert.equal(new Set(ids).size, ids.length);
    const [d22, d261] = mt.units;
    assert.equal(d22.jurisdictionId, "us-mt");
    assert.equal(d22.providerId, "mtfwp-deer-elk-lion");
    assert.equal(d22.sourceFeatureId, "22");
    assert.equal(d22.regionName, "Region 2");
    assert.equal(d22.seasonContext, "Regulation year 2099");
    assert.equal(d22.sqMiles, 501);
    assert.equal(d261.regionName, "");
    assert.equal(d261.sqMiles, null);
    assert.ok(mt.units.every((unit) => polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat)));
  });
});

describe("MTFWP adapter: loading through the shared store", () => {
  it("assembles a 139-district paginated download and reports available", async () => {
    const fake = serve({ [MTFWP_LAYER_URL]: mtLayer(mtFeatures(139)) });
    const { adapter, storage } = mtAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 139);
    assert.equal(result.sourceVersion, null, "the layer publishes no edit date");
    assert.equal(result.retrievedAt, T0);
    assert.equal(fake.count("page"), 3, "maxRecordCount 50 → three pages");
    assert.equal(fake.count("count"), 1);
    const page = fake.calls.find((url) => url.searchParams.has("resultOffset"));
    assert.equal(page?.searchParams.get("outFields"), "OBJECTID,DISTRICT,REG,REGYEAR,AREA_MI");
    assert.equal(page?.searchParams.get("maxAllowableOffset"), "0.002");
    assert.equal(page?.searchParams.get("geometryPrecision"), "4");
    const stored = storage.snapshots.get("mtfwp-deer-elk-lion") as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 139);
    assert.equal(stored.manifest.expectedCount, 139);
  });

  it("rejects a truncated download: unavailable without a copy, stale with one", async () => {
    const truncated = (features = mtFeatures(139)) =>
      mtLayer(features, {
        // The server counts 139 but stops after 100 without flagging more.
        page: (offset, size, all) => {
          const slice = all.slice(offset, Math.min(offset + size, 100));
          return offset + size < 100
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
      });

    serve({ [MTFWP_LAYER_URL]: truncated() });
    const fresh = mtAdapter();
    const none = await fresh.adapter.load();
    assert.equal(none.status, "unavailable");
    assert.deepEqual(none.units, []);
    assert.match(none.message ?? "", /100 of 139 features/);
    assert.equal(fresh.storage.rejections.length, 1);

    const kept = mtAdapter();
    serve({ [MTFWP_LAYER_URL]: mtLayer(mtFeatures(139)) });
    assert.equal((await kept.adapter.load()).status, "available");
    kept.time.advance(31 * DAY_MS);
    serve({ [MTFWP_LAYER_URL]: truncated() });
    const stale = await kept.adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 139);
    assert.equal(stale.retrievedAt, T0);
    assert.match(stale.message ?? "", /100 of 139 features/);
  });

  it("re-downloads an old copy because the layer has no edit date to compare", async () => {
    const { adapter, time } = mtAdapter();
    serve({ [MTFWP_LAYER_URL]: mtLayer(mtFeatures(12)) });
    await adapter.load();
    time.advance(31 * DAY_MS);
    const fake = serve({ [MTFWP_LAYER_URL]: mtLayer(mtFeatures(12)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0 + 31 * DAY_MS);
    assert.ok(fake.count("page") >= 1);
  });

  it("rejects a renamed DISTRICT field", async () => {
    const renamed = mtFeatures(5).map((feature) => {
      const { DISTRICT, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, HD: DISTRICT } };
    });
    serve({ [MTFWP_LAYER_URL]: mtLayer(renamed) });
    const result = await mtAdapter().adapter.load();
    assert.equal(result.status, "unavailable");
    assert.match(result.message ?? "", /required field "DISTRICT"/);
  });
});

describe("MTFWP adapter: identify", () => {
  it("returns the district at a point from the provider's query", async () => {
    const [w, s] = mtCell(2, 3);
    const fake = serve({ [MTFWP_LAYER_URL]: mtLayer(mtFeatures(40)) });
    const result = await mtAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.hits.length, 1);
    const [hit] = result.hits;
    assert.equal(hit.approximate, false);
    assert.equal(hit.unit.id, "us-mt:mtfwp-deer-elk-lion:132");
    assert.deepEqual(hit.unit.speciesTags, ["Deer", "Elk", "Mountain lion"]);
    assert.equal(hit.unit.seasonContext, "Regulation year 2099");
    assert.equal(fake.count("identify"), 1);
    assert.equal(fake.count("page"), 0, "identify does not download the layer");
  });

  it("returns every overlapping district, and none between districts", async () => {
    const [w, s] = mtCell(0, 0);
    const features = [mtFeature(1, "100", [w, s]), mtFeature(2, "101", [w + 0.1, s + 0.1])];
    serve({ [MTFWP_LAYER_URL]: mtLayer(features) });
    const { adapter } = mtAdapter();
    const both = await adapter.identify({ lng: w + 0.15, lat: s + 0.15 });
    assert.deepEqual(
      both.hits.map((hit) => hit.unit.code),
      ["100", "101"],
    );
    const gap = await adapter.identify({ lng: w + 0.5, lat: s + 0.5 });
    assert.deepEqual(gap, { status: "available", hits: [], message: null });
  });

  it("answers outside Montana's coverage without a request", async () => {
    const fake = serve({});
    const result = await mtAdapter().adapter.identify({ lng: -112, lat: 34 });
    assert.deepEqual(result, { status: "available", hits: [], message: null });
    assert.equal(fake.calls.length, 0);
  });

  it("falls back to the local copy (approximate) when the provider fails", async () => {
    const [w, s] = mtCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    const features = [mtFeature(1, "100", [w, s], {}, holed), mtFeature(2, "101", mtCell(1, 0))];
    serve({ [MTFWP_LAYER_URL]: mtLayer(features) });
    const { adapter } = mtAdapter();
    await adapter.load();
    serve({ [MTFWP_LAYER_URL]: mtLayer(features, { identify: () => new Response("err", { status: 500 }) }) });
    const inside = await adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(inside.status, "available");
    assert.deepEqual(
      inside.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [["us-mt:mtfwp-deer-elk-lion:100", true]],
    );
    assert.match(inside.message ?? "", /HTTP 500.*saved copy/);
    const inHole = await adapter.identify({ lng: w + 0.12, lat: s + 0.12 });
    assert.deepEqual(inHole.hits, [], "a hole is not part of the district");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const noCopy = await mtAdapter().adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(noCopy.status, "unavailable");
    assert.deepEqual(noCopy.hits, []);
  });
});

describe("Idaho–Montana cross-border", () => {
  // Lost Trail Pass area on the Idaho–Montana line.
  const VIEW = { west: -114.3, south: 45.5, east: -113.6, north: 45.9 };

  it("discovers both states' unit providers for a view on the line", () => {
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    assert.ok(states.includes("us-id") && states.includes("us-mt"), states.join());
    const fromRegister = states.flatMap((id) => layerStatus(id, "hunt-units").providerIds);
    assert.deepEqual(fromRegister.sort(), ["idfg-gmu", "mtfwp-deer-elk-lion"]);
    const discovered = providersForView(
      VIEW,
      UNIT_ADAPTERS.map((adapter) => adapter.info),
      "hunt-units",
    ).map((info) => info.id);
    assert.deepEqual(discovered, ["idfg-gmu", "mtfwp-deer-elk-lion"]);
    for (const id of discovered) assert.ok(unitAdapterById(id), id);
  });

  it("search for a code in both states returns both, disambiguated", async () => {
    // FIXTURE code "22" in both states (real Idaho and Montana codes differ).
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "22", idCell(0, 0))] },
      [MTFWP_LAYER_URL]: mtLayer([mtFeature(1, "22", mtCell(5, 5)), mtFeature(2, "23", mtCell(6, 5))]),
    });
    const storage = memoryUnitStorage();
    const id = await createIdfgAdapter({ storage, now: () => T0 }).load();
    const mt = await mtAdapter(clock(), storage).adapter.load();
    const units = [...id.units, ...mt.units];
    assert.deepEqual(
      searchUnits(units, "22").map((r) => r.label),
      ["Unit 22 · Idaho", "Hunting District 22 · Montana"],
    );
    for (const q of ["montana 22", "MT 22", "22 mt", "HD 22 montana", "district 22 mt"]) {
      const results = searchUnits(units, q);
      assert.deepEqual(results.map((r) => r.unit.id), ["us-mt:mtfwp-deer-elk-lion:22", "us-id:idfg-gmu:22"], q);
      assert.deepEqual(results.map((r) => r.jurisdictionMatch), [true, false], q);
    }
    const missoula = { lng: -114.0, lat: 46.87 };
    assert.deepEqual(
      searchUnits(units, "22", { near: missoula }).map((r) => r.jurisdictionName),
      ["Montana", "Idaho"],
    );
  });
});

describe("MTFWP registry entry", () => {
  it("is registered as a third unit adapter with honest info", () => {
    assert.deepEqual(
      UNIT_ADAPTERS.map((adapter) => adapter.info.id),
      ["azgfd-gmu", "idfg-gmu", "mtfwp-deer-elk-lion", "udwr-deer-general"],
    );
    const info = unitAdapterById("mtfwp-deer-elk-lion")?.info;
    assert.ok(info);
    assert.equal(info, MTFWP_INFO);
    assert.deepEqual(info.jurisdictionIds, ["us-mt"]);
    assert.equal(info.category, "hunt-units");
    assert.equal(info.attribution, "Montana Fish, Wildlife & Parks");
    assert.equal(info.sourceUrl, "https://fwp.mt.gov/");
    assert.equal(info.licenseUrl, null);
    assert.equal(info.capabilities.download, "unknown", "no license stated by the provider");
    assert.equal(info.capabilities.redistribution, "unknown", "no license stated by the provider");
    assert.match(info.caveat, /Reference boundaries.*Montana regulations/);
    assert.equal(allowedUrl(MTFWP_LAYER_URL).hostname, "fwp-gis.mt.gov");
  });
});
