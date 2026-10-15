import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { jurisdictionsInBounds, layerStatus } from "../coverage.ts";
import { providersForView } from "../discovery.ts";
import { searchUnits } from "../search.ts";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonsContain } from "../unit-geometry.ts";
import { allowedUrl } from "./arcgis.ts";
import { AZGFD_LAYER_URL, createAzgfdAdapter } from "./azgfd.ts";
import { createIdfgAdapter, IDFG_LAYER_URL } from "./idfg.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import { createMtfwpAdapter, MTFWP_LAYER_URL } from "./mtfwp.ts";
import { createUdwrAdapter, mapUdwrAttributes, UDWR_INFO, UDWR_LAYER_URL } from "./udwr.ts";
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
import { mtCell, mtFeature, mtLayerMetadata } from "./fixtures/mtfwp-fixtures.ts";
import { UT_EDIT, UT_FIELD_NAMES, utCell, utFeature, utFeatures, utLayerMetadata } from "./fixtures/udwr-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);
const PROVIDER = "udwr-deer-general";

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function utLayer(features = utFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: utLayerMetadata(50), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function utAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createUdwrAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

async function withGoodCopy(n = 31) {
  const made = utAdapter();
  serve({ [UDWR_LAYER_URL]: utLayer(utFeatures(n)) });
  const first = await made.adapter.load();
  assert.equal(first.status, "available");
  made.time.advance(31 * DAY_MS);
  return made;
}

describe("UDWR adapter: field mapping", () => {
  it("uses the boundary name as the code and keeps the source's hunt type, season and species", () => {
    assert.deepEqual(
      mapUdwrAttributes({ boundary_name: "  Fixture  Ridge, West ", hunt_type: "General Season", species: "Deer", season: "Fall 2099" }),
      {
        code: "Fixture Ridge, West",
        regionName: "",
        speciesTags: ["Deer"],
        seasonContext: "General Season · Fall 2099",
        landNote: "",
        forest: "",
        sqMiles: null,
      },
    );
  });

  it("keeps missing values unknown instead of inventing them", () => {
    const sparse = mapUdwrAttributes({ boundary_name: "Fixture 1", hunt_type: null, species: "", season: " " });
    assert.ok(sparse);
    assert.deepEqual(sparse.speciesTags, [], "no species is claimed when the source gives none");
    assert.equal(sparse.seasonContext, null);
    assert.equal(mapUdwrAttributes({ boundary_name: "Fixture 1", season: "Fall 2099" })?.seasonContext, "Fall 2099");
    // SHAPE__Area is Web Mercator planar area, so it never becomes square miles.
    assert.equal(mapUdwrAttributes({ boundary_name: "Fixture 1", SHAPE__Area: 8.5e9 })?.sqMiles, null);
    // Rows without a name are not units.
    assert.equal(mapUdwrAttributes({ boundary_name: null }), null);
    assert.equal(mapUdwrAttributes({ boundary_name: "   " }), null);
    assert.equal(mapUdwrAttributes({}), null);
  });

  it("builds namespaced ids that do not collide with AZ, ID or MT codes", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "Cache", azCell(0, 0))] },
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "Cache", idCell(0, 0))] },
      [MTFWP_LAYER_URL]: { meta: mtLayerMetadata(50), features: [mtFeature(1, "Cache", mtCell(0, 0))] },
      [UDWR_LAYER_URL]: utLayer([utFeature(1, "Cache", utCell(0, 0)), utFeature(2, "Fixture Valley", utCell(1, 0), { season: null })]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const id = await createIdfgAdapter({ storage, now: () => T0 }).load();
    const mt = await createMtfwpAdapter({ storage, now: () => T0 }).load();
    const ut = await utAdapter(clock(), storage).adapter.load();
    assert.equal(ut.status, "available");
    const ids = [...az.units, ...id.units, ...mt.units, ...ut.units].map((unit) => unit.id);
    assert.deepEqual(ids, [
      "us-az:azgfd-gmu:Cache",
      "us-id:idfg-gmu:Cache",
      "us-mt:mtfwp-deer-elk-lion:Cache",
      "us-ut:udwr-deer-general:Cache",
      "us-ut:udwr-deer-general:Fixture Valley",
    ]);
    assert.equal(new Set(ids).size, ids.length);
    const [cache, valley] = ut.units;
    assert.equal(cache.jurisdictionId, "us-ut");
    assert.equal(cache.providerId, PROVIDER);
    assert.equal(cache.sourceFeatureId, "Cache");
    assert.equal(cache.label, "Deer unit Cache");
    assert.deepEqual(cache.speciesTags, ["Deer"]);
    assert.equal(cache.seasonContext, "General Season · Fall 2099");
    assert.equal(cache.sqMiles, null);
    assert.equal(valley.seasonContext, "General Season");
    assert.ok(ut.units.every((unit) => polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat)));
  });

  it("puts the label point inside a concave unit, not at its vertex average", async () => {
    const [w, s] = utCell(2, 2);
    // A "U" shape whose vertex average falls in the notch.
    const u = {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [w + 0.3, s],
          [w + 0.3, s + 0.3],
          [w + 0.2, s + 0.3],
          [w + 0.2, s + 0.05],
          [w + 0.1, s + 0.05],
          [w + 0.1, s + 0.3],
          [w, s + 0.3],
          [w, s],
        ],
      ],
    };
    serve({ [UDWR_LAYER_URL]: utLayer([utFeature(1, "Fixture U", [w, s], {}, u)]) });
    const [unit] = (await utAdapter().adapter.load()).units;
    assert.ok(polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
  });
});

describe("UDWR adapter: loading through the shared store", () => {
  it("assembles a 31-unit paginated download with the edit date as source version", async () => {
    const fake = serve({ [UDWR_LAYER_URL]: { meta: utLayerMetadata(10), features: utFeatures(31) } });
    const { adapter, storage } = utAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 31);
    assert.equal(result.sourceVersion, new Date(UT_EDIT).toISOString());
    assert.equal(result.retrievedAt, T0);
    assert.equal(fake.count("page"), 4, "maxRecordCount 10 → four pages");
    assert.equal(fake.count("count"), 1);
    const pages = fake.calls.filter((url) => url.searchParams.has("resultOffset"));
    assert.deepEqual(
      pages.map((url) => [url.searchParams.get("resultOffset"), url.searchParams.get("resultRecordCount")]),
      [
        ["0", "10"],
        ["10", "10"],
        ["20", "10"],
        ["30", "10"],
      ],
    );
    assert.equal(pages[0].searchParams.get("outFields"), "OBJECTID,boundary_name,hunt_type,species,season");
    assert.equal(pages[0].searchParams.get("outSR"), "4326");
    assert.equal(pages[0].searchParams.get("maxAllowableOffset"), "0.002");
    assert.equal(pages[0].searchParams.get("geometryPrecision"), "4");
    assert.ok(fake.calls.every((url) => url.hostname === "services.arcgis.com"));
    const stored = storage.snapshots.get(PROVIDER) as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 31);
    assert.equal(stored.manifest.expectedCount, 31);
  });

  it("renews an old copy without re-downloading when the edit date and count are unchanged", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [UDWR_LAYER_URL]: utLayer(utFeatures(31)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0, "features were not re-downloaded");
    assert.equal(fake.count("page"), 0);
    assert.equal(fake.count("meta"), 1);
    assert.equal(fake.count("count"), 1);
  });

  it("re-downloads when DWR publishes a new edit date", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [UDWR_LAYER_URL]: { meta: utLayerMetadata(50, UT_EDIT + DAY_MS), features: utFeatures(31) } });
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.sourceVersion, new Date(UT_EDIT + DAY_MS).toISOString());
    assert.equal(result.retrievedAt, T0 + 31 * DAY_MS);
    assert.ok(fake.count("page") >= 1);
  });

  it("rejects truncated paging: unavailable without a copy, stale with one", async () => {
    const truncated = () =>
      utLayer(utFeatures(31), {
        meta: utLayerMetadata(10, UT_EDIT + 1),
        // The server counts 31 but stops after 20 without flagging more.
        page: (offset, size, all) => {
          const slice = all.slice(offset, Math.min(offset + size, 20));
          return offset + size < 20
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
      });
    serve({ [UDWR_LAYER_URL]: truncated() });
    const none = await utAdapter().adapter.load();
    assert.equal(none.status, "unavailable");
    assert.match(none.message ?? "", /20 of 31 features/);

    const { adapter } = await withGoodCopy();
    serve({ [UDWR_LAYER_URL]: truncated() });
    const stale = await adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 31);
    assert.match(stale.message ?? "", /20 of 31 features/);
  });

  it("keeps an empty success, an outage and a malformed response distinct", async () => {
    // Empty HTTP-200: the provider says there are no units.
    serve({ [UDWR_LAYER_URL]: utLayer([], { count: { count: 0 } }) });
    const empty = await utAdapter().adapter.load();
    assert.equal(empty.status, "unavailable");
    assert.match(empty.message ?? "", /no features/);

    // Outage: the provider cannot be reached.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const down = await utAdapter().adapter.load();
    assert.equal(down.status, "unavailable");
    assert.match(down.message ?? "", /HTTP 503/);

    // Malformed: an ArcGIS error body inside HTTP 200.
    serve({ [UDWR_LAYER_URL]: utLayer(utFeatures(3), { meta: { error: { code: 400, message: "Invalid URL" } } }) });
    const broken = await utAdapter().adapter.load();
    assert.equal(broken.status, "unavailable");
    assert.match(broken.message ?? "", /reported an error: Invalid URL/);

    assert.equal(new Set([empty.message, down.message, broken.message]).size, 3);

    // With a good copy an empty success never erases it.
    const { adapter } = await withGoodCopy();
    serve({ [UDWR_LAYER_URL]: utLayer([], { meta: utLayerMetadata(50, UT_EDIT + 1), count: { count: 0 } }) });
    const kept = await adapter.load();
    assert.equal(kept.status, "stale");
    assert.equal(kept.units.length, 31);
  });

  it("rejects a renamed boundary_name field, in the schema or in the rows", async () => {
    serve({
      [UDWR_LAYER_URL]: utLayer(utFeatures(5), {
        meta: layerMetadata({ fields: UT_FIELD_NAMES.map((f) => (f === "boundary_name" ? "BoundaryName" : f)) }),
      }),
    });
    const bySchema = await utAdapter().adapter.load();
    assert.equal(bySchema.status, "unavailable");
    assert.match(bySchema.message ?? "", /"boundary_name".*renamed or removed/);

    const renamed = utFeatures(5).map((feature) => {
      const { boundary_name, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, BoundaryName: boundary_name } };
    });
    serve({ [UDWR_LAYER_URL]: utLayer(renamed) });
    const byRows = await utAdapter().adapter.load();
    assert.equal(byRows.status, "unavailable");
    assert.match(byRows.message ?? "", /required field "boundary_name"/);
  });

  it("rejects malformed geometry, duplicate features and units outside Utah", async () => {
    const lines = utFeatures(5);
    lines[2] = utFeature(3, "Fixture 102", utCell(2, 0), {}, { type: "LineString", coordinates: [[-112, 39], [-111, 39]] });
    serve({ [UDWR_LAYER_URL]: utLayer(lines) });
    const malformed = await utAdapter().adapter.load();
    assert.equal(malformed.status, "unavailable");
    assert.match(malformed.message ?? "", /unit Fixture 102 has malformed geometry/);

    const dupes = [...utFeatures(3), utFeature(2, "Fixture 999", utCell(5, 0))];
    serve({ [UDWR_LAYER_URL]: utLayer(dupes) });
    const twice = await utAdapter().adapter.load();
    assert.equal(twice.status, "unavailable");
    assert.match(twice.message ?? "", /same feature twice/);

    const far = utFeatures(5);
    far[0] = utFeature(1, "Fixture 100", azCell(0, 0));
    serve({ [UDWR_LAYER_URL]: utLayer(far) });
    const outside = await utAdapter().adapter.load();
    assert.equal(outside.status, "unavailable");
    assert.match(outside.message ?? "", /outside the provider's coverage/);
  });
});

describe("UDWR adapter: identify", () => {
  it("returns the unit at a point from the provider's query, without downloading the layer", async () => {
    const [w, s] = utCell(2, 1);
    const fake = serve({ [UDWR_LAYER_URL]: utLayer(utFeatures(20)) });
    const result = await utAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.hits.length, 1);
    const [hit] = result.hits;
    assert.equal(hit.approximate, false);
    assert.equal(hit.unit.id, "us-ut:udwr-deer-general:Fixture 112");
    assert.equal(hit.unit.label, "Deer unit Fixture 112");
    assert.deepEqual(hit.unit.speciesTags, ["Deer"]);
    assert.equal(hit.unit.seasonContext, "General Season · Fall 2099");
    assert.equal(fake.count("identify"), 1);
    assert.equal(fake.count("page"), 0);
  });

  it("answers available with no hits in a limited-entry-only gap, and skips the request outside Utah", async () => {
    // Two general-season units with a gap between them (like Paunsaugunt).
    serve({ [UDWR_LAYER_URL]: utLayer([utFeature(1, "Fixture West", utCell(0, 0)), utFeature(2, "Fixture East", utCell(2, 0))]) });
    const [w, s] = utCell(1, 0);
    const gap = await utAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.deepEqual(gap, { status: "available", hits: [], message: null });

    const fake = serve({});
    const reno = await utAdapter().adapter.identify({ lng: -119.8, lat: 39.5 });
    assert.deepEqual(reno, { status: "available", hits: [], message: null });
    assert.equal(fake.calls.length, 0);
  });

  it("falls back to the saved copy (approximate) when the provider fails, and says unavailable without one", async () => {
    const [w, s] = utCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    const features = [utFeature(1, "Fixture Holed", [w, s], {}, holed), utFeature(2, "Fixture Next", utCell(1, 0))];
    serve({ [UDWR_LAYER_URL]: utLayer(features) });
    const { adapter } = utAdapter();
    await adapter.load();
    serve({ [UDWR_LAYER_URL]: utLayer(features, { identify: () => new Response("err", { status: 500 }) }) });
    const inside = await adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(inside.status, "available");
    assert.deepEqual(
      inside.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [["us-ut:udwr-deer-general:Fixture Holed", true]],
    );
    assert.match(inside.message ?? "", /HTTP 500.*saved copy/);
    const inHole = await adapter.identify({ lng: w + 0.12, lat: s + 0.12 });
    assert.deepEqual(inHole.hits, [], "a hole is not part of the unit");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const noCopy = await utAdapter().adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(noCopy.status, "unavailable");
    assert.deepEqual(noCopy.hits, []);
    assert.match(noCopy.message ?? "", /no saved copy/);
  });
});

describe("Arizona–Utah cross-border", () => {
  // Arizona Strip / St. George area on the 37th parallel.
  const VIEW = { west: -114.0, south: 36.8, east: -113.2, north: 37.2 };
  // FIXTURE units: one on each side of the line, sharing the edge at 37°N.
  const utNorth = utFeature(1, "Fixture North", [-113.7, 37.0]);
  const azSouth = azFeature(1, "Fixture 12", [-113.7, 36.75]);

  it("discovers both states' unit providers for a view on the line", () => {
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    assert.ok(states.includes("us-az") && states.includes("us-ut"), states.join());
    const fromRegister = states.flatMap((id) => layerStatus(id, "hunt-units").providerIds);
    assert.deepEqual(fromRegister.sort(), ["azgfd-gmu", PROVIDER]);
    const discovered = providersForView(
      VIEW,
      UNIT_ADAPTERS.map((adapter) => adapter.info),
      "hunt-units",
    ).map((info) => info.id);
    assert.deepEqual(discovered.sort(), ["azgfd-gmu", PROVIDER]);
    for (const id of discovered) assert.ok(unitAdapterById(id), id);
  });

  it("answers a point on each side from its own state's provider only", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azSouth] },
      [UDWR_LAYER_URL]: utLayer([utNorth]),
    });
    const az = createAzgfdAdapter({ storage: memoryUnitStorage(), now: () => T0 });
    const ut = utAdapter().adapter;
    const north = { lng: -113.6, lat: 37.05 };
    const south = { lng: -113.6, lat: 36.95 };
    const [azN, utN, azS, utS] = await Promise.all([az.identify(north), ut.identify(north), az.identify(south), ut.identify(south)]);
    assert.deepEqual(azN, { status: "available", hits: [], message: null });
    assert.deepEqual(utN.hits.map((hit) => hit.unit.id), ["us-ut:udwr-deer-general:Fixture North"]);
    assert.deepEqual(azS.hits.map((hit) => hit.unit.id), ["us-az:azgfd-gmu:Fixture 12"]);
    assert.deepEqual(utS, { status: "available", hits: [], message: null });
  });

  it("loads both states' units for the view", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azSouth] },
      [UDWR_LAYER_URL]: utLayer([utNorth]),
    });
    const storage = memoryUnitStorage();
    const [az, ut] = await Promise.all([
      createAzgfdAdapter({ storage, now: () => T0 }).load(),
      utAdapter(clock(), storage).adapter.load(),
    ]);
    assert.equal(az.status, "available");
    assert.equal(ut.status, "available");
    assert.deepEqual([...az.units, ...ut.units].map((unit) => unit.id), [
      "us-az:azgfd-gmu:Fixture 12",
      "us-ut:udwr-deer-general:Fixture North",
    ]);
  });
});

describe("Idaho–Utah cross-border", () => {
  // Cache Valley on the 42nd parallel.
  const VIEW = { west: -112.2, south: 41.8, east: -111.4, north: 42.2 };
  const utSouth = utFeature(1, "Fixture Cache", [-112.0, 41.75]);
  const idNorth = idFeature(1, "Fixture 73", [-112.0, 42.0]);

  it("discovers both states' unit providers for a view on the line", () => {
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    assert.ok(states.includes("us-id") && states.includes("us-ut"), states.join());
    const discovered = providersForView(
      VIEW,
      UNIT_ADAPTERS.map((adapter) => adapter.info),
      "hunt-units",
    ).map((info) => info.id);
    assert.deepEqual(discovered.sort(), ["idfg-gmu", PROVIDER]);
  });

  it("answers a point on each side from its own state's provider only", async () => {
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idNorth] },
      [UDWR_LAYER_URL]: utLayer([utSouth]),
    });
    const id = createIdfgAdapter({ storage: memoryUnitStorage(), now: () => T0 });
    const ut = utAdapter().adapter;
    const north = { lng: -111.9, lat: 42.05 };
    const south = { lng: -111.9, lat: 41.95 };
    const [idN, utN, idS, utS] = await Promise.all([id.identify(north), ut.identify(north), id.identify(south), ut.identify(south)]);
    assert.deepEqual(idN.hits.map((hit) => hit.unit.id), ["us-id:idfg-gmu:Fixture 73"]);
    assert.deepEqual(utN, { status: "available", hits: [], message: null });
    assert.deepEqual(idS, { status: "available", hits: [], message: null });
    assert.deepEqual(utS.hits.map((hit) => hit.unit.id), ["us-ut:udwr-deer-general:Fixture Cache"]);
  });

  it("keeps one provider's outage from hiding the other's answer", async () => {
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idNorth], identify: () => new Response("down", { status: 503 }) },
      [UDWR_LAYER_URL]: utLayer([utSouth]),
    });
    const point = { lng: -111.9, lat: 41.95 };
    const [idHit, utHit] = await Promise.all([
      createIdfgAdapter({ storage: memoryUnitStorage(), now: () => T0 }).identify(point),
      utAdapter().adapter.identify(point),
    ]);
    assert.equal(idHit.status, "unavailable", "Idaho is down with no saved copy");
    assert.equal(utHit.status, "available");
    assert.deepEqual(utHit.hits.map((hit) => hit.unit.code), ["Fixture Cache"]);
  });
});

describe("UDWR search and registry", () => {
  it("finds a Utah unit by its name, with or without the state", async () => {
    serve({ [UDWR_LAYER_URL]: utLayer([utFeature(1, "Fixture Valley", utCell(0, 0)), utFeature(2, "Box Fixture", utCell(1, 0))]) });
    const { units } = await utAdapter().adapter.load();
    for (const q of ["Fixture Valley", "fixture valley", "utah fixture valley", "fixture valley ut", "unit fixture valley"]) {
      assert.deepEqual(
        searchUnits(units, q).map((r) => r.label),
        ["Deer unit Fixture Valley · Utah"],
        q,
      );
    }
    assert.deepEqual(searchUnits(units, "fixture").map((r) => r.unit.code), [], "a partial name is not a match");
  });

  it("is registered with honest info and an allowlisted host", () => {
    assert.ok(UNIT_ADAPTERS.map((adapter) => adapter.info.id).includes(PROVIDER));
    const info = unitAdapterById(PROVIDER)?.info;
    assert.equal(info, UDWR_INFO);
    assert.deepEqual(UDWR_INFO.jurisdictionIds, ["us-ut"]);
    assert.equal(UDWR_INFO.category, "hunt-units");
    assert.equal(UDWR_INFO.attribution, "Utah Division of Wildlife Resources");
    assert.equal(UDWR_INFO.licenseUrl, null);
    assert.equal(UDWR_INFO.capabilities.download, "unknown", "the source states a disclaimer, not a license");
    assert.equal(UDWR_INFO.capabilities.redistribution, "unknown", "the source states a disclaimer, not a license");
    assert.match(UDWR_INFO.caveat, /General-season buck deer boundaries only.*Guidebook/);
    assert.equal(allowedUrl(UDWR_LAYER_URL).hostname, "services.arcgis.com");
    const status = layerStatus("us-ut", "hunt-units");
    assert.equal(status.status, "available");
    assert.deepEqual(status.providerIds, [PROVIDER]);
    assert.match(status.note, /general-season buck deer .* only; .* not included/);
  });
});
