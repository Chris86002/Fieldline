import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { jurisdictionsAt, jurisdictionsInBounds, layerStatus } from "../coverage.ts";
import { providersAt, providersForView } from "../discovery.ts";
import { searchUnits } from "../search.ts";
import type { UnitAdapter } from "../types.ts";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonsContain } from "../unit-geometry.ts";
import { allowedUrl } from "./arcgis.ts";
import { CPW_LAYER_URL, createCpwAdapter } from "./cpw.ts";
import { createIdfgAdapter, IDFG_LAYER_URL } from "./idfg.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import { createMtfwpAdapter, MTFWP_LAYER_URL } from "./mtfwp.ts";
import { createUdwrAdapter, UDWR_LAYER_URL } from "./udwr.ts";
import { createWgfdAdapter, mapWgfdAttributes, WGFD_INFO, WGFD_LAYER_URL } from "./wgfd.ts";
import { fakeArcgis, ID_FIELD_NAMES, idCell, idFeature, layerMetadata, squareRing, type FakeLayer } from "./fixtures/arcgis-fixtures.ts";
import { coFeature, coLayerMetadata } from "./fixtures/cpw-fixtures.ts";
import { mtFeature, mtLayerMetadata } from "./fixtures/mtfwp-fixtures.ts";
import { utFeature, utLayerMetadata } from "./fixtures/udwr-fixtures.ts";
import { WY_EDIT, WY_FIELD_NAMES, wyCell, wyFeature, wyFeatures, wyLayerMetadata } from "./fixtures/wgfd-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);
const PROVIDER = "wgfd-elk-areas";
const unitProviders = UNIT_ADAPTERS.map((adapter) => adapter.info);

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function wyLayer(features = wyFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: wyLayerMetadata(50), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function wyAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createWgfdAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

async function withGoodCopy(n = 105) {
  const made = wyAdapter();
  serve({ [WGFD_LAYER_URL]: wyLayer(wyFeatures(n)) });
  const first = await made.adapter.load();
  assert.equal(first.status, "available");
  made.time.advance(31 * DAY_MS);
  return made;
}

describe("WGFD adapter: field mapping", () => {
  it("uses the hunt area number as the code and keeps the source's name, herd unit, region and area", () => {
    assert.deepEqual(
      mapWgfdAttributes({
        HUNTAREA: 7,
        HUNTNAME: " Fixture  Peak ",
        HERDUNIT: 741,
        HERDNAME: "Fixture Peak/Fixture Mountain",
        Region: "Eastern",
        SqMiles: 4041.86,
      }),
      {
        code: "7",
        regionName: "Eastern nonresident region",
        speciesTags: ["Elk"],
        seasonContext: "Area name: Fixture Peak · Herd unit 741 (Fixture Peak/Fixture Mountain)",
        landNote: "",
        forest: "",
        sqMiles: 4041.86,
      },
    );
    // Doubles and numeric strings that are whole numbers are the same code.
    assert.equal(mapWgfdAttributes({ HUNTAREA: "130" })?.code, "130");
    assert.equal(mapWgfdAttributes({ HUNTAREA: "007" })?.code, "7");
    assert.equal(mapWgfdAttributes({ HUNTAREA: "12.0" })?.code, "12");
  });

  it("keeps missing values unknown instead of inventing them", () => {
    // An area outside any herd unit: HERDUNIT 0 and a blank HERDNAME (as the live layer has).
    const noHerd = mapWgfdAttributes({ HUNTAREA: 126, HERDUNIT: 0, HERDNAME: " ", HUNTNAME: "Fixture Springs", Region: "Eastern", SqMiles: 10 });
    assert.equal(noHerd?.seasonContext, "Area name: Fixture Springs");
    const bare = mapWgfdAttributes({ HUNTAREA: 5, HUNTNAME: null, HERDUNIT: null, Region: "", SqMiles: 0 });
    assert.ok(bare);
    assert.equal(bare.seasonContext, null);
    assert.equal(bare.regionName, "");
    assert.equal(bare.sqMiles, null, "a zero area is unknown, not 0");
    assert.equal(mapWgfdAttributes({ HUNTAREA: 5, SqMiles: "n/a" })?.sqMiles, null);
    assert.equal(mapWgfdAttributes({ HUNTAREA: 5, HERDUNIT: 321 })?.seasonContext, "Herd unit 321");
    // Rows without a usable area number are not hunt areas.
    for (const HUNTAREA of [null, 0, -3, 7.5, "", "  ", "7A", "N/A", Number.NaN]) {
      assert.equal(mapWgfdAttributes({ HUNTAREA, HUNTNAME: "Fixture" }), null, String(HUNTAREA));
    }
    assert.equal(mapWgfdAttributes({}), null);
  });

  it("builds namespaced, species-labelled ids that do not collide with other states' codes", async () => {
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "7", idCell(0, 0))] },
      [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 7, wyCell(0, 0)), wyFeature(2, 10, wyCell(1, 0), { HERDUNIT: 0, HERDNAME: "" })]),
    });
    const storage = memoryUnitStorage();
    const id = await createIdfgAdapter({ storage, now: () => T0 }).load();
    const wy = await wyAdapter(clock(), storage).adapter.load();
    assert.equal(wy.status, "available");
    const ids = [...id.units, ...wy.units].map((unit) => unit.id);
    assert.deepEqual(ids, ["us-id:idfg-gmu:7", "us-wy:wgfd-elk-areas:7", "us-wy:wgfd-elk-areas:10"]);
    const [seven, ten] = wy.units;
    assert.equal(seven.jurisdictionId, "us-wy");
    assert.equal(seven.providerId, PROVIDER);
    assert.equal(seven.sourceFeatureId, "7");
    assert.equal(seven.label, "Elk hunt area 7", "the label names the species");
    assert.deepEqual(seven.speciesTags, ["Elk"]);
    assert.equal(seven.regionName, "Fixture nonresident region");
    assert.equal(seven.seasonContext, "Area name: Fixture Ridge 1 · Herd unit 901 (Fixture Herd)");
    assert.equal(seven.sqMiles, 201.25);
    assert.equal(ten.seasonContext, "Area name: Fixture Ridge 2");
    assert.ok(wy.units.every((unit) => polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat)));
  });

  it("puts the label point inside a concave area and merges multipart rows of one area", async () => {
    const [w, s] = wyCell(2, 2);
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
    serve({ [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 3, [w, s], {}, u), wyFeature(2, 3, wyCell(6, 0))]) });
    const { units } = await wyAdapter().adapter.load();
    assert.equal(units.length, 1);
    assert.equal(units[0].polygons.length, 2);
    assert.ok(polygonsContain(units[0].polygons, units[0].labelPoint.lng, units[0].labelPoint.lat));
  });
});

describe("WGFD adapter: loading through the shared store", () => {
  it("assembles a 105-area paginated download with the edit date as source version", async () => {
    const fake = serve({ [WGFD_LAYER_URL]: { meta: wyLayerMetadata(40), features: wyFeatures(105) } });
    const { adapter, storage } = wyAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 105);
    assert.deepEqual(result.units.slice(0, 3).map((unit) => unit.code), ["1", "2", "3"], "sorted numerically");
    assert.equal(result.sourceVersion, new Date(WY_EDIT).toISOString());
    assert.equal(result.retrievedAt, T0);
    assert.equal(fake.count("page"), 3, "maxRecordCount 40 → three pages");
    assert.equal(fake.count("count"), 1);
    const pages = fake.calls.filter((url) => url.searchParams.has("resultOffset"));
    assert.deepEqual(
      pages.map((url) => [url.searchParams.get("resultOffset"), url.searchParams.get("resultRecordCount")]),
      [
        ["0", "40"],
        ["40", "40"],
        ["80", "40"],
      ],
    );
    assert.equal(pages[0].searchParams.get("outFields"), "OBJECTID,HUNTAREA,HUNTNAME,HERDUNIT,HERDNAME,Region,SqMiles");
    assert.equal(pages[0].searchParams.get("orderByFields"), "OBJECTID");
    assert.equal(pages[0].searchParams.get("outSR"), "4326");
    assert.equal(pages[0].searchParams.get("maxAllowableOffset"), "0.002");
    assert.equal(pages[0].searchParams.get("geometryPrecision"), "4");
    assert.ok(fake.calls.every((url) => url.hostname === "services6.arcgis.com"));
    const stored = storage.snapshots.get(PROVIDER) as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 105);
    assert.equal(stored.manifest.expectedCount, 105);
  });

  it("renews an old copy without re-downloading when the edit date and count are unchanged", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [WGFD_LAYER_URL]: wyLayer(wyFeatures(105)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0, "features were not re-downloaded");
    assert.equal(fake.count("page"), 0);
    assert.equal(fake.count("meta"), 1);
    assert.equal(fake.count("count"), 1);
  });

  it("re-downloads when WGFD publishes a new edit date", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [WGFD_LAYER_URL]: { meta: wyLayerMetadata(50, WY_EDIT + DAY_MS), features: wyFeatures(105) } });
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.sourceVersion, new Date(WY_EDIT + DAY_MS).toISOString());
    assert.equal(result.retrievedAt, T0 + 31 * DAY_MS);
    assert.ok(fake.count("page") >= 1);
  });

  it("rejects truncated paging: unavailable without a copy, stale with one", async () => {
    const truncated = () =>
      wyLayer(wyFeatures(105), {
        meta: wyLayerMetadata(40, WY_EDIT + 1),
        // The server counts 105 but stops after 80 without flagging more.
        page: (offset, size, all) => {
          const slice = all.slice(offset, Math.min(offset + size, 80));
          return offset + size < 80
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
      });
    serve({ [WGFD_LAYER_URL]: truncated() });
    const none = await wyAdapter().adapter.load();
    assert.equal(none.status, "unavailable");
    assert.match(none.message ?? "", /80 of 105 features/);

    const { adapter } = await withGoodCopy();
    serve({ [WGFD_LAYER_URL]: truncated() });
    const stale = await adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 105);
    assert.match(stale.message ?? "", /80 of 105 features/);
  });

  it("keeps an empty success, an outage, a malformed response and an unsupported layer distinct", async () => {
    // Empty HTTP-200: the provider says there are no hunt areas.
    serve({ [WGFD_LAYER_URL]: wyLayer([], { count: { count: 0 } }) });
    const empty = await wyAdapter().adapter.load();
    assert.equal(empty.status, "unavailable");
    assert.match(empty.message ?? "", /no features/);

    // Outage: the provider cannot be reached.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const down = await wyAdapter().adapter.load();
    assert.equal(down.status, "unavailable");
    assert.match(down.message ?? "", /HTTP 503/);

    // Malformed: an ArcGIS error body inside HTTP 200.
    serve({ [WGFD_LAYER_URL]: wyLayer(wyFeatures(3), { meta: { error: { code: 400, message: "Invalid URL" } } }) });
    const broken = await wyAdapter().adapter.load();
    assert.equal(broken.status, "unavailable");
    assert.match(broken.message ?? "", /reported an error: Invalid URL/);

    // Unsupported: the layer stops advertising pagination and cuts the answer short.
    serve({
      [WGFD_LAYER_URL]: wyLayer(wyFeatures(105), {
        meta: layerMetadata({ fields: WY_FIELD_NAMES, editDate: WY_EDIT, supportsPagination: false }),
        page: (_offset, _size, all) => ({ type: "FeatureCollection", features: all.slice(0, 50), properties: { exceededTransferLimit: true } }),
      }),
    });
    const cannotPage = await wyAdapter().adapter.load();
    assert.equal(cannotPage.status, "unavailable");
    assert.match(cannotPage.message ?? "", /cannot page/);

    assert.equal(new Set([empty.message, down.message, broken.message, cannotPage.message]).size, 4);

    // With a good copy an empty success never erases it.
    const { adapter } = await withGoodCopy();
    serve({ [WGFD_LAYER_URL]: wyLayer([], { meta: wyLayerMetadata(50, WY_EDIT + 1), count: { count: 0 } }) });
    const kept = await adapter.load();
    assert.equal(kept.status, "stale");
    assert.equal(kept.units.length, 105);
  });

  it("rejects a renamed HUNTAREA field, in the schema or in the rows", async () => {
    serve({
      [WGFD_LAYER_URL]: wyLayer(wyFeatures(5), {
        meta: layerMetadata({ fields: WY_FIELD_NAMES.map((f) => (f === "HUNTAREA" ? "HUNT_AREA" : f)) }),
      }),
    });
    const bySchema = await wyAdapter().adapter.load();
    assert.equal(bySchema.status, "unavailable");
    assert.match(bySchema.message ?? "", /"HUNTAREA".*renamed or removed/);

    const renamed = wyFeatures(5).map((feature) => {
      const { HUNTAREA, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, HUNT_AREA: HUNTAREA } };
    });
    serve({ [WGFD_LAYER_URL]: wyLayer(renamed) });
    const byRows = await wyAdapter().adapter.load();
    assert.equal(byRows.status, "unavailable");
    assert.match(byRows.message ?? "", /required field "HUNTAREA"/);
  });

  it("rejects malformed geometry, duplicate features, bad pages and areas outside Wyoming", async () => {
    const lines = wyFeatures(5);
    lines[2] = wyFeature(3, 3, wyCell(2, 0), {}, { type: "LineString", coordinates: [[-108, 43], [-107, 43]] });
    serve({ [WGFD_LAYER_URL]: wyLayer(lines) });
    const lineString = await wyAdapter().adapter.load();
    assert.equal(lineString.status, "unavailable");
    assert.match(lineString.message ?? "", /unit 3 has malformed geometry/);

    const text = wyFeatures(5);
    text[1] = wyFeature(2, 2, wyCell(1, 0), {}, { type: "Polygon", coordinates: [[[-108, "x"], [-107.9, 43], [-108, 43.1], [-108, "x"]]] });
    serve({ [WGFD_LAYER_URL]: wyLayer(text) });
    const nonNumeric = await wyAdapter().adapter.load();
    assert.equal(nonNumeric.status, "unavailable");
    assert.match(nonNumeric.message ?? "", /unit 2 has malformed geometry/);

    const dupes = [...wyFeatures(3), wyFeature(2, 99, wyCell(5, 0))];
    serve({ [WGFD_LAYER_URL]: wyLayer(dupes) });
    const twice = await wyAdapter().adapter.load();
    assert.equal(twice.status, "unavailable");
    assert.match(twice.message ?? "", /same feature twice/);

    serve({ [WGFD_LAYER_URL]: wyLayer(wyFeatures(5), { page: () => ({ features: "nope" }) }) });
    const notGeojson = await wyAdapter().adapter.load();
    assert.equal(notGeojson.status, "unavailable");
    assert.match(notGeojson.message ?? "", /not a GeoJSON FeatureCollection/);

    const far = wyFeatures(5);
    // Somewhere in Kansas.
    far[0] = wyFeature(1, 1, [-99.5, 38.5]);
    serve({ [WGFD_LAYER_URL]: wyLayer(far) });
    const outside = await wyAdapter().adapter.load();
    assert.equal(outside.status, "unavailable");
    assert.match(outside.message ?? "", /outside the provider's coverage/);
  });
});

describe("WGFD adapter: identify", () => {
  it("returns the hunt area at a point from the provider's query, without downloading the layer", async () => {
    const [w, s] = wyCell(3, 1);
    const fake = serve({ [WGFD_LAYER_URL]: wyLayer(wyFeatures(40)) });
    const result = await wyAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.hits.length, 1);
    const [hit] = result.hits;
    assert.equal(hit.approximate, false);
    assert.equal(hit.unit.id, "us-wy:wgfd-elk-areas:19");
    assert.equal(hit.unit.label, "Elk hunt area 19");
    assert.deepEqual(hit.unit.speciesTags, ["Elk"]);
    assert.equal(hit.unit.regionName, "Fixture nonresident region");
    assert.equal(hit.unit.seasonContext, "Area name: Fixture Ridge 19 · Herd unit 904 (Fixture Herd)");
    assert.equal(fake.count("identify"), 1);
    assert.equal(fake.count("page"), 0);
    const query = fake.calls.find((url) => url.searchParams.has("geometry"));
    assert.equal(query?.searchParams.get("inSR"), "4326");
    assert.equal(query?.searchParams.get("returnGeometry"), "false");
  });

  it("answers outside Wyoming's coverage without a request, and invalid points as unknown", async () => {
    const fake = serve({});
    const { adapter } = wyAdapter();
    // Rapid City, South Dakota.
    assert.deepEqual(await adapter.identify({ lng: -103.23, lat: 44.08 }), { status: "available", hits: [], message: null });
    const invalid = await adapter.identify({ lng: -107, lat: Number.NaN });
    assert.equal(invalid.status, "unknown");
    assert.equal(fake.calls.length, 0);
  });

  it("falls back to the saved copy (approximate) when the provider fails, and says unavailable without one", async () => {
    const [w, s] = wyCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    const features = [wyFeature(1, 60, [w, s], {}, holed), wyFeature(2, 61, wyCell(1, 0))];
    serve({ [WGFD_LAYER_URL]: wyLayer(features) });
    const { adapter } = wyAdapter();
    await adapter.load();
    serve({ [WGFD_LAYER_URL]: wyLayer(features, { identify: () => new Response("err", { status: 500 }) }) });
    const inside = await adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(inside.status, "available");
    assert.deepEqual(
      inside.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [["us-wy:wgfd-elk-areas:60", true]],
    );
    assert.match(inside.message ?? "", /HTTP 500.*saved copy/);
    assert.deepEqual((await adapter.identify({ lng: w + 0.12, lat: s + 0.12 })).hits, [], "a hole is not part of the area");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const noCopy = await wyAdapter().adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(noCopy.status, "unavailable");
    assert.deepEqual(noCopy.hits, []);
    assert.match(noCopy.message ?? "", /no saved copy/);
  });
});

/**
 * Cross-border: for each neighbour already supported, a view on the line
 * discovers both providers, and a point on each side is answered only by its
 * own state's provider. FIXTURE areas share the state line as an edge.
 */
describe("Wyoming cross-border", () => {
  type Neighbour = {
    name: string;
    jurisdictionId: `us-${string}`;
    providerId: string;
    view: { west: number; south: number; east: number; north: number };
    layerUrl: string;
    layer: FakeLayer;
    adapter: () => UnitAdapter;
    wyCorner: [number, number];
    wyPoint: { lng: number; lat: number };
    theirPoint: { lng: number; lat: number };
    theirId: string;
  };
  const opts = () => ({ storage: memoryUnitStorage(), now: () => T0 });
  const NEIGHBOURS: Neighbour[] = [
    {
      // Teton Pass / Victor: the Idaho line at -111.05.
      name: "Idaho",
      jurisdictionId: "us-id",
      providerId: "idfg-gmu",
      view: { west: -111.4, south: 43.4, east: -110.8, north: 43.9 },
      layerUrl: IDFG_LAYER_URL,
      layer: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "Fixture 62", [-111.3, 43.5])] },
      adapter: () => createIdfgAdapter(opts()),
      wyCorner: [-111.05, 43.5],
      wyPoint: { lng: -110.95, lat: 43.6 },
      theirPoint: { lng: -111.15, lat: 43.6 },
      theirId: "us-id:idfg-gmu:Fixture 62",
    },
    {
      // Bighorn Canyon: the Montana line at 45°N.
      name: "Montana",
      jurisdictionId: "us-mt",
      providerId: "mtfwp-deer-elk-lion",
      view: { west: -108.5, south: 44.8, east: -107.8, north: 45.2 },
      layerUrl: MTFWP_LAYER_URL,
      layer: { meta: mtLayerMetadata(), features: [mtFeature(1, "Fixture 502", [-108.3, 45.0])] },
      adapter: () => createMtfwpAdapter(opts()),
      wyCorner: [-108.3, 44.75],
      wyPoint: { lng: -108.2, lat: 44.9 },
      theirPoint: { lng: -108.2, lat: 45.1 },
      theirId: "us-mt:mtfwp-deer-elk-lion:Fixture 502",
    },
    {
      // Evanston: the Utah line at 41°N.
      name: "Utah",
      jurisdictionId: "us-ut",
      providerId: "udwr-deer-general",
      view: { west: -111.0, south: 40.8, east: -110.4, north: 41.2 },
      layerUrl: UDWR_LAYER_URL,
      layer: { meta: utLayerMetadata(), features: [utFeature(1, "Fixture North Slope", [-110.9, 40.75])] },
      adapter: () => createUdwrAdapter(opts()),
      wyCorner: [-110.9, 41.0],
      wyPoint: { lng: -110.8, lat: 41.1 },
      theirPoint: { lng: -110.8, lat: 40.9 },
      theirId: "us-ut:udwr-deer-general:Fixture North Slope",
    },
    {
      // Medicine Bow / Walden: the Colorado line at 41°N.
      name: "Colorado",
      jurisdictionId: "us-co",
      providerId: "cpw-gmu",
      view: { west: -106.2, south: 40.8, east: -105.6, north: 41.2 },
      layerUrl: CPW_LAYER_URL,
      layer: { meta: coLayerMetadata(), features: [coFeature(1, 6, [-106.1, 40.75])] },
      adapter: () => createCpwAdapter(opts()),
      wyCorner: [-106.1, 41.0],
      wyPoint: { lng: -106.0, lat: 41.1 },
      theirPoint: { lng: -106.0, lat: 40.9 },
      theirId: "us-co:cpw-gmu:6",
    },
  ];

  for (const n of NEIGHBOURS) {
    it(`${n.name}–Wyoming: discovers both states' unit providers for a view on the line`, () => {
      const states = jurisdictionsInBounds(n.view).map((j) => j.id);
      assert.ok(states.includes("us-wy") && states.includes(n.jurisdictionId), states.join());
      const discovered = providersForView(n.view, unitProviders, "hunt-units").map((info) => info.id);
      assert.deepEqual([...discovered].sort(), [n.providerId, PROVIDER].sort());
      const fromRegister = states.flatMap((id) => layerStatus(id, "hunt-units").providerIds);
      assert.deepEqual([...fromRegister].sort(), [n.providerId, PROVIDER].sort());
      for (const id of discovered) assert.ok(unitAdapterById(id), id);
      assert.ok(providersAt(n.wyPoint, unitProviders, "hunt-units").some((info) => info.id === PROVIDER));
    });

    it(`${n.name}–Wyoming: answers a point on each side from its own state's provider only`, async () => {
      serve({
        [n.layerUrl]: n.layer,
        [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 77, n.wyCorner)]),
      });
      const wy = wyAdapter().adapter;
      const them = n.adapter();
      const [wyHere, themHere, wyThere, themThere] = await Promise.all([
        wy.identify(n.wyPoint),
        them.identify(n.wyPoint),
        wy.identify(n.theirPoint),
        them.identify(n.theirPoint),
      ]);
      assert.deepEqual(wyHere.hits.map((hit) => hit.unit.id), ["us-wy:wgfd-elk-areas:77"]);
      assert.deepEqual(themHere, { status: "available", hits: [], message: null });
      assert.deepEqual(wyThere, { status: "available", hits: [], message: null });
      assert.deepEqual(themThere.hits.map((hit) => hit.unit.id), [n.theirId]);
    });
  }

  it("keeps one provider's outage from hiding the other's answer (Idaho down at Teton Pass)", async () => {
    serve({
      [IDFG_LAYER_URL]: {
        meta: layerMetadata({ fields: ID_FIELD_NAMES }),
        features: [idFeature(1, "Fixture 62", [-111.3, 43.5])],
        identify: () => new Response("down", { status: 503 }),
      },
      [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 77, [-111.05, 43.5])]),
    });
    const point = { lng: -110.95, lat: 43.6 };
    const [idHit, wyHit] = await Promise.all([createIdfgAdapter(opts()).identify(point), wyAdapter().adapter.identify(point)]);
    assert.equal(idHit.status, "unavailable", "Idaho is down with no saved copy");
    assert.equal(wyHit.status, "available");
    assert.deepEqual(wyHit.hits.map((hit) => hit.unit.code), ["77"]);
  });

  it("loads both states' units for an Idaho–Wyoming view", async () => {
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "Fixture 62", [-111.3, 43.5])] },
      [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 77, [-111.05, 43.5])]),
    });
    const storage = memoryUnitStorage();
    const [id, wy] = await Promise.all([createIdfgAdapter({ storage, now: () => T0 }).load(), wyAdapter(clock(), storage).adapter.load()]);
    assert.equal(id.status, "available");
    assert.equal(wy.status, "available");
    assert.deepEqual([...id.units, ...wy.units].map((unit) => unit.id), ["us-id:idfg-gmu:Fixture 62", "us-wy:wgfd-elk-areas:77"]);
  });

  it("an unsupported neighbour (Nebraska, South Dakota) is reported unavailable by the register, not as 'no units'", () => {
    // Torrington / the Black Hills: Wyoming's provider is discovered, its neighbours have no unit source.
    for (const view of [
      { west: -104.3, south: 41.9, east: -103.8, north: 42.2 },
      { west: -104.3, south: 43.8, east: -103.8, north: 44.25 },
    ]) {
      const states = jurisdictionsInBounds(view).map((j) => j.id);
      assert.ok(states.includes("us-wy"), states.join());
      const others = states.filter((id) => id !== "us-wy");
      assert.ok(others.length > 0, states.join());
      for (const id of others) {
        assert.equal(layerStatus(id, "hunt-units").status, "unavailable", id);
        assert.deepEqual(layerStatus(id, "hunt-units").providerIds, [], id);
      }
      assert.deepEqual(providersForView(view, unitProviders, "hunt-units").map((info) => info.id), [PROVIDER]);
    }
    assert.ok(jurisdictionsAt({ lng: -104.0, lat: 42.0 }).some((j) => j.id === "us-ne"));
  });
});

describe("WGFD search and registry", () => {
  it("finds a Wyoming elk hunt area by number, with the state or 'hunt area' wording", async () => {
    serve({
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "7", idCell(0, 0))] },
      [WGFD_LAYER_URL]: wyLayer([wyFeature(1, 7, wyCell(0, 0)), wyFeature(2, 70, wyCell(1, 0)), wyFeature(3, 130, wyCell(2, 0))]),
    });
    const storage = memoryUnitStorage();
    const id = await createIdfgAdapter({ storage, now: () => T0 }).load();
    const wy = await wyAdapter(clock(), storage).adapter.load();
    const units = [...id.units, ...wy.units];
    assert.deepEqual(searchUnits(units, "7").map((r) => r.label), ["Unit 7 · Idaho", "Elk hunt area 7 · Wyoming"]);
    for (const q of ["wy 7", "WY 7", "7 wy", "wyoming 7", "Wyoming hunt area 7", "hunt area 7 wy", "wy area 7", "area 07 wyoming"]) {
      const hits = searchUnits(units, q);
      assert.deepEqual(
        hits.map((r) => [r.label, r.jurisdictionMatch]),
        [
          ["Elk hunt area 7 · Wyoming", true],
          ["Unit 7 · Idaho", false],
        ],
        q,
      );
    }
    assert.deepEqual(searchUnits(units, "wy 130").map((r) => r.unit.id), ["us-wy:wgfd-elk-areas:130"]);
    assert.deepEqual(searchUnits(units, "wy 13").map((r) => r.unit.id), [], "whole numbers only");
    // Near Jackson, the Wyoming area ranks first even without the state.
    const jackson = { lng: -110.76, lat: 43.48 };
    assert.equal(searchUnits(units, "hunt area 7", { near: jackson })[0].unit.id, "us-wy:wgfd-elk-areas:7");
  });

  it("is registered with honest info and an allowlisted host", () => {
    assert.ok(UNIT_ADAPTERS.map((adapter) => adapter.info.id).includes(PROVIDER));
    const info = unitAdapterById(PROVIDER)?.info;
    assert.equal(info, WGFD_INFO);
    assert.deepEqual(WGFD_INFO.jurisdictionIds, ["us-wy"]);
    assert.equal(WGFD_INFO.category, "hunt-units");
    assert.equal(WGFD_INFO.attribution, "Wyoming Game and Fish Department");
    assert.equal(WGFD_INFO.sourceUrl, "https://wgfd.wyo.gov/hunting-trapping");
    assert.equal(WGFD_INFO.licenseUrl, null);
    assert.equal(WGFD_INFO.capabilities.download, "unknown", "the source states a disclaimer, not a license");
    assert.equal(WGFD_INFO.capabilities.redistribution, "unknown", "the source states a disclaimer, not a license");
    assert.match(WGFD_INFO.caveat, /^Elk hunt areas only.*not the legal description.*regulations/);
    assert.equal(allowedUrl(WGFD_LAYER_URL).hostname, "services6.arcgis.com");
    const status = layerStatus("us-wy", "hunt-units");
    assert.equal(status.status, "available");
    assert.deepEqual(status.providerIds, [PROVIDER]);
    assert.match(status.note, /elk hunt areas only; deer, pronghorn.* not included/);
  });
});
