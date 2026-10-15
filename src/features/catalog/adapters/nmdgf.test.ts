import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { jurisdictionsAt, jurisdictionsInBounds, layerStatus } from "../coverage.ts";
import { providersAt, providersForView } from "../discovery.ts";
import { searchUnits } from "../search.ts";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonsContain } from "../unit-geometry.ts";
import { allowedUrl } from "./arcgis.ts";
import { AZGFD_LAYER_URL, createAzgfdAdapter } from "./azgfd.ts";
import { CPW_LAYER_URL, createCpwAdapter } from "./cpw.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import { createNmdgfAdapter, mapNmdgfAttributes, nationalForests, NMDGF_INFO, NMDGF_LAYER_URL, nmGmuCode } from "./nmdgf.ts";
import { createUdwrAdapter, UDWR_LAYER_URL } from "./udwr.ts";
import { AZ_FIELD_NAMES, azCell, azFeature, fakeArcgis, layerMetadata, squareRing, type FakeLayer } from "./fixtures/arcgis-fixtures.ts";
import { coFeature, coLayerMetadata } from "./fixtures/cpw-fixtures.ts";
import { NM_EDIT, NM_FIELD_NAMES, nmCell, nmFeature, nmFeatures, nmLayerMetadata } from "./fixtures/nmdgf-fixtures.ts";
import { utFeature, utLayerMetadata } from "./fixtures/udwr-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);
const PROVIDER = "nmdgf-gmu";

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function nmLayer(features = nmFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: nmLayerMetadata(50), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function nmAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createNmdgfAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

/** Loads a good copy at T0, then ages it past the refresh policy. */
async function withGoodCopy(n = 70) {
  const setup = nmAdapter();
  serve({ [NMDGF_LAYER_URL]: nmLayer(nmFeatures(n)) });
  const first = await setup.adapter.load();
  assert.equal(first.status, "available");
  setup.time.advance(31 * DAY_MS);
  return setup;
}

describe("NMDGF adapter: field mapping", () => {
  it("maps GMU, bear and cougar zones, national forests and SQMI", () => {
    assert.deepEqual(
      mapNmdgfAttributes({
        GMU: "16D",
        SQMI: 470.8,
        BearZone: "10",
        Cougar_Zone: "J",
        Maps: "BLM Maps: Fixture Quad. \r\nUS Forest Service Maps: Fixture National Forest.",
        GMU_Desc: "FIXTURE rule text",
      }),
      {
        code: "16D",
        regionName: "",
        speciesTags: [],
        seasonContext: "Bear zone 10 · Cougar zone J",
        landNote: "",
        forest: "Fixture National Forest",
        sqMiles: 470.8,
      },
    );
  });

  it("writes sub-unit codes as hunters do", () => {
    assert.equal(nmGmuCode("2A"), "2A");
    assert.equal(nmGmuCode(" 16d "), "16D");
    assert.equal(nmGmuCode("16 D"), "16D");
    assert.equal(nmGmuCode("16-D"), "16D");
    assert.equal(nmGmuCode("02A"), "2A");
    assert.equal(nmGmuCode(34), "34");
    assert.equal(nmGmuCode("034"), "34");
    for (const bad of [null, undefined, "", "  ", "0", "N/A", "Portion of GMU 10", "16DD", "A16", 3.5, "1234"]) {
      assert.equal(nmGmuCode(bad), "", String(bad));
    }
  });

  it("keeps missing values unknown instead of inventing them", () => {
    const sparse = mapNmdgfAttributes({ GMU: "1", SQMI: null, BearZone: "0", Cougar_Zone: " ", Maps: " " });
    assert.ok(sparse);
    assert.equal(sparse.seasonContext, null, "bear zone 0 is undefined by the source, so it is not shown");
    assert.equal(sparse.forest, "");
    assert.equal(sparse.sqMiles, null);
    assert.equal(mapNmdgfAttributes({ GMU: "47", BearZone: null, Cougar_Zone: "D" })?.seasonContext, "Cougar zone D");
    assert.equal(mapNmdgfAttributes({ GMU: "47", BearZone: 6, Cougar_Zone: null })?.seasonContext, "Bear zone 6");
    assert.equal(mapNmdgfAttributes({ GMU: "47", SQMI: 0 })?.sqMiles, null, "zero area is unknown, not 0");
    assert.equal(mapNmdgfAttributes({ GMU: "47", SQMI: "abc" })?.sqMiles, null);
    assert.equal(mapNmdgfAttributes({ GMU: null }), null);
    assert.equal(mapNmdgfAttributes({ GMU: "N/A" }), null);
    assert.equal(mapNmdgfAttributes({}), null);
  });

  it("reads national forest names from the map list, without repeats or other text", () => {
    assert.equal(
      nationalForests(
        "BLM Maps: Alpha Quad.\nUS Forest Service Maps: Fixture One National Forest, Beta District, Gamma Wilderness, Fixture One National Forest, Delta District.",
      ),
      "Fixture One National Forest",
    );
    assert.equal(
      nationalForests("BLM: Alpha Quad. // U.S. Forest Service: Fixture National Forest, Kiowa Grasslands. Other Fe National Forest"),
      "Fixture National Forest, Other Fe National Forest",
    );
    // A quad name before the forest stays out of it.
    assert.equal(nationalForests("BLM Maps: Wheeler Peak Quad. Fixture National Forest"), "Fixture National Forest");
    assert.equal(nationalForests("BLM Maps: Alpha Quad and Beta Quad."), "");
    assert.equal(nationalForests(null), "");
  });

  it("builds namespaced ids that do not collide with Arizona's 2A", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "2A", azCell(0, 0))] },
      [NMDGF_LAYER_URL]: nmLayer([nmFeature(1, "2A", nmCell(0, 0)), nmFeature(2, "16D", nmCell(1, 0))]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const nm = await nmAdapter(clock(), storage).adapter.load();
    assert.equal(nm.status, "available");
    const ids = [...az.units, ...nm.units].map((unit) => unit.id);
    assert.deepEqual(ids, ["us-az:azgfd-gmu:2A", "us-nm:nmdgf-gmu:2A", "us-nm:nmdgf-gmu:16D"]);
    const [twoA] = nm.units;
    assert.equal(twoA.jurisdictionId, "us-nm");
    assert.equal(twoA.providerId, PROVIDER);
    assert.equal(twoA.sourceFeatureId, "2A");
    assert.equal(twoA.label, "GMU 2A");
    assert.equal(twoA.seasonContext, "Bear zone 99 · Cougar zone ZZ");
    assert.equal(twoA.forest, "Fixture National Forest");
    assert.equal(twoA.sqMiles, 401);
    assert.ok(nm.units.every((unit) => polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat)));
  });

  it("puts the label point inside a concave unit, not at its vertex average", async () => {
    const [w, s] = nmCell(2, 2);
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
    serve({ [NMDGF_LAYER_URL]: nmLayer([nmFeature(1, "16C", [w, s], {}, u)]) });
    const [unit] = (await nmAdapter().adapter.load()).units;
    assert.ok(polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
  });
});

describe("NMDGF adapter: loading through the shared store", () => {
  it("assembles a 70-unit paginated download, sorted with sub-units in place", async () => {
    const fake = serve({ [NMDGF_LAYER_URL]: { meta: nmLayerMetadata(25), features: nmFeatures(70) } });
    const { adapter, storage } = nmAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 70);
    assert.equal(result.sourceVersion, new Date(NM_EDIT).toISOString());
    assert.equal(result.retrievedAt, T0);
    assert.deepEqual(
      result.units.slice(0, 8).map((unit) => unit.code),
      ["1", "2A", "2B", "2C", "3", "4", "5", "6A"],
    );
    assert.equal(fake.count("page"), 3, "maxRecordCount 25 → three pages");
    const pages = fake.calls.filter((url) => url.searchParams.has("resultOffset"));
    assert.deepEqual(
      pages.map((url) => [url.searchParams.get("resultOffset"), url.searchParams.get("resultRecordCount")]),
      [
        ["0", "25"],
        ["25", "25"],
        ["50", "25"],
      ],
    );
    assert.equal(pages[0].searchParams.get("outFields"), "OBJECTID,GMU,SQMI,BearZone,Cougar_Zone,Maps");
    assert.equal(pages[0].searchParams.get("orderByFields"), "OBJECTID");
    assert.equal(pages[0].searchParams.get("outSR"), "4326");
    assert.equal(pages[0].searchParams.get("maxAllowableOffset"), "0.002");
    assert.equal(pages[0].searchParams.get("geometryPrecision"), "4");
    assert.ok(fake.calls.every((url) => url.hostname === "services2.arcgis.com"));
    const stored = storage.snapshots.get(PROVIDER) as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 70);
    assert.equal(stored.manifest.expectedCount, 70);
  });

  it("renews an old copy without re-downloading when the edit date and count are unchanged", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [NMDGF_LAYER_URL]: nmLayer(nmFeatures(70)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0, "features were not re-downloaded");
    assert.equal(fake.count("page"), 0);
  });

  it("re-downloads when the agency publishes a new edit date", async () => {
    const { adapter } = await withGoodCopy();
    const fake = serve({ [NMDGF_LAYER_URL]: { meta: nmLayerMetadata(50, NM_EDIT + DAY_MS), features: nmFeatures(70) } });
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.sourceVersion, new Date(NM_EDIT + DAY_MS).toISOString());
    assert.equal(result.retrievedAt, T0 + 31 * DAY_MS);
    assert.ok(fake.count("page") >= 1);
  });

  it("rejects truncated paging: unavailable without a copy, stale with one", async () => {
    const truncated = () =>
      nmLayer(nmFeatures(70), {
        meta: nmLayerMetadata(25, NM_EDIT + 1),
        // The server counts 70 but stops after 50 without flagging more.
        page: (offset, size, all) => {
          const slice = all.slice(offset, Math.min(offset + size, 50));
          return offset + size < 50
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
      });
    serve({ [NMDGF_LAYER_URL]: truncated() });
    const none = await nmAdapter().adapter.load();
    assert.equal(none.status, "unavailable");
    assert.match(none.message ?? "", /50 of 70 features/);

    const { adapter } = await withGoodCopy();
    serve({ [NMDGF_LAYER_URL]: truncated() });
    const stale = await adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 70);
    assert.match(stale.message ?? "", /50 of 70 features/);
  });

  it("keeps an empty success, an outage, a malformed response and an unsupported state distinct", async () => {
    // Empty HTTP-200: the provider says there are no units.
    serve({ [NMDGF_LAYER_URL]: nmLayer([], { count: { count: 0 } }) });
    const empty = await nmAdapter().adapter.load();
    assert.equal(empty.status, "unavailable");
    assert.match(empty.message ?? "", /no features/);

    // Outage: the provider cannot be reached.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const down = await nmAdapter().adapter.load();
    assert.equal(down.status, "unavailable");
    assert.match(down.message ?? "", /HTTP 503/);

    // Malformed: an ArcGIS error body inside HTTP 200.
    serve({ [NMDGF_LAYER_URL]: nmLayer(nmFeatures(3), { meta: { error: { code: 400, message: "Invalid URL" } } }) });
    const broken = await nmAdapter().adapter.load();
    assert.equal(broken.status, "unavailable");
    assert.match(broken.message ?? "", /reported an error: Invalid URL/);

    assert.equal(new Set([empty.message, down.message, broken.message]).size, 3);

    // Unsupported: Texas and Oklahoma have no unit source; the register says so,
    // and the NM provider is not asked outside its box.
    for (const id of ["us-tx", "us-ok"] as const) {
      const status = layerStatus(id, "hunt-units");
      assert.equal(status.status, "unavailable", id);
      assert.match(status.note, /No hunt-unit source in Fieldline yet/);
    }
    const fake = serve({});
    const panhandle = await nmAdapter().adapter.identify({ lng: -102.5, lat: 36.8 });
    assert.deepEqual(panhandle, { status: "available", hits: [], message: null });
    assert.equal(fake.calls.length, 0);

    // With a good copy an empty success never erases it.
    const { adapter } = await withGoodCopy();
    serve({ [NMDGF_LAYER_URL]: nmLayer([], { meta: nmLayerMetadata(50, NM_EDIT + 1), count: { count: 0 } }) });
    const kept = await adapter.load();
    assert.equal(kept.status, "stale");
    assert.equal(kept.units.length, 70);
  });

  it("rejects a renamed GMU field, in the schema or in the rows", async () => {
    serve({
      [NMDGF_LAYER_URL]: nmLayer(nmFeatures(5), {
        meta: layerMetadata({ fields: NM_FIELD_NAMES.map((f) => (f === "GMU" ? "GMU_NAME" : f)) }),
      }),
    });
    const bySchema = await nmAdapter().adapter.load();
    assert.equal(bySchema.status, "unavailable");
    assert.match(bySchema.message ?? "", /"GMU".*renamed or removed/);

    const renamed = nmFeatures(5).map((feature) => {
      const { GMU, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, GMU_NAME: GMU } };
    });
    serve({ [NMDGF_LAYER_URL]: nmLayer(renamed) });
    const byRows = await nmAdapter().adapter.load();
    assert.equal(byRows.status, "unavailable");
    assert.match(byRows.message ?? "", /required field "GMU"/);
  });

  it("rejects malformed geometry, duplicate features and units outside New Mexico", async () => {
    const lines = nmFeatures(5);
    lines[2] = nmFeature(3, "2B", nmCell(2, 0), {}, { type: "LineString", coordinates: [[-107, 34], [-106, 34]] });
    serve({ [NMDGF_LAYER_URL]: nmLayer(lines) });
    const malformed = await nmAdapter().adapter.load();
    assert.equal(malformed.status, "unavailable");
    assert.match(malformed.message ?? "", /unit 2B has malformed geometry/);

    const badCoords = nmFeatures(5);
    badCoords[1] = nmFeature(2, "2A", nmCell(1, 0), {}, { type: "Polygon", coordinates: [[[-107, "34"], [-106, 34], [-106, 35], [-107, 34]]] });
    serve({ [NMDGF_LAYER_URL]: nmLayer(badCoords) });
    assert.match((await nmAdapter().adapter.load()).message ?? "", /unit 2A has malformed geometry/);

    const dupes = [...nmFeatures(3), nmFeature(2, "99", nmCell(5, 0))];
    serve({ [NMDGF_LAYER_URL]: nmLayer(dupes) });
    const twice = await nmAdapter().adapter.load();
    assert.equal(twice.status, "unavailable");
    assert.match(twice.message ?? "", /same feature twice/);

    const far = nmFeatures(5);
    far[0] = nmFeature(1, "1", [-111.5, 39.5]);
    serve({ [NMDGF_LAYER_URL]: nmLayer(far) });
    const outside = await nmAdapter().adapter.load();
    assert.equal(outside.status, "unavailable");
    assert.match(outside.message ?? "", /outside the provider's coverage/);
  });

  it("skips rows that are not GMU codes instead of inventing a unit", async () => {
    const features = [...nmFeatures(3), nmFeature(4, "Portion of GMU 10", nmCell(5, 0)), nmFeature(5, null, nmCell(6, 0))];
    serve({ [NMDGF_LAYER_URL]: nmLayer(features) });
    const result = await nmAdapter().adapter.load();
    assert.equal(result.status, "available");
    assert.deepEqual(result.units.map((unit) => unit.code), ["1", "2A", "2B"]);
  });
});

describe("NMDGF adapter: identify", () => {
  it("returns the GMU at a point from the provider's query, without downloading the layer", async () => {
    const [w, s] = nmCell(3, 1);
    const fake = serve({ [NMDGF_LAYER_URL]: nmLayer(nmFeatures(20)) });
    const result = await nmAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.hits.length, 1);
    const [hit] = result.hits;
    assert.equal(hit.approximate, false);
    assert.equal(hit.unit.id, "us-nm:nmdgf-gmu:10A");
    assert.equal(hit.unit.label, "GMU 10A");
    assert.equal(hit.unit.seasonContext, "Bear zone 99 · Cougar zone ZZ");
    assert.equal(hit.unit.forest, "Fixture National Forest");
    assert.equal(fake.count("identify"), 1);
    assert.equal(fake.count("page"), 0);
    const asked = fake.calls.find((url) => url.searchParams.has("geometry"));
    assert.equal(asked?.searchParams.get("outFields"), "GMU,SQMI,BearZone,Cougar_Zone,Maps");
    assert.equal(asked?.searchParams.get("returnGeometry"), "false");
  });

  it("falls back to the saved copy (approximate) when the provider fails, and says unavailable without one", async () => {
    const [w, s] = nmCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    const features = [nmFeature(1, "6B", [w, s], {}, holed), nmFeature(2, "6C", nmCell(1, 0))];
    serve({ [NMDGF_LAYER_URL]: nmLayer(features) });
    const { adapter } = nmAdapter();
    await adapter.load();
    serve({ [NMDGF_LAYER_URL]: nmLayer(features, { identify: () => new Response("err", { status: 500 }) }) });
    const inside = await adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(inside.status, "available");
    assert.deepEqual(
      inside.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [["us-nm:nmdgf-gmu:6B", true]],
    );
    assert.match(inside.message ?? "", /HTTP 500.*saved copy/);
    assert.deepEqual((await adapter.identify({ lng: w + 0.12, lat: s + 0.12 })).hits, [], "a hole is not part of the GMU");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const noCopy = await nmAdapter().adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(noCopy.status, "unavailable");
    assert.deepEqual(noCopy.hits, []);
    assert.match(noCopy.message ?? "", /no saved copy/);
  });
});

describe("New Mexico cross-border", () => {
  const unitProviders = UNIT_ADAPTERS.map((adapter) => adapter.info);
  // FIXTURE units, one per state around the Four Corners monument (-109.045, 36.999);
  // the real lines are 109°02'48"W and 37°N, approximated here as -109.045 and 37.0.
  const nmSE = nmFeature(1, "2A", [-109.045, 36.75], {}, { type: "Polygon", coordinates: [squareRing(-109.045, 36.75, 0.25)] });
  const azSW = azFeature(1, "12A", [-109.295, 36.75]);
  const coNE = coFeature(1, 711, [-109.045, 37.0]);
  const utNW = utFeature(1, "Fixture San Juan", [-109.295, 37.0]);

  function serveFourCorners() {
    return serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azSW] },
      [CPW_LAYER_URL]: { meta: coLayerMetadata(50), features: [coNE] },
      [UDWR_LAYER_URL]: { meta: utLayerMetadata(50), features: [utNW] },
      [NMDGF_LAYER_URL]: nmLayer([nmSE]),
    });
  }

  function fourAdapters() {
    const storage = memoryUnitStorage();
    return {
      az: createAzgfdAdapter({ storage, now: () => T0 }),
      co: createCpwAdapter({ storage, now: () => T0 }),
      ut: createUdwrAdapter({ storage, now: () => T0 }),
      nm: createNmdgfAdapter({ storage, now: () => T0 }),
    };
  }

  it("Four Corners: discovers all four states' providers, matching the register", () => {
    const VIEW = { west: -109.3, south: 36.8, east: -108.8, north: 37.2 };
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    for (const id of ["us-az", "us-co", "us-nm", "us-ut"] as const) assert.ok(states.includes(id), id);
    const fromRegister = states.flatMap((id) => layerStatus(id, "hunt-units").providerIds);
    const discovered = providersForView(VIEW, unitProviders, "hunt-units").map((info) => info.id);
    assert.deepEqual([...discovered].sort(), ["azgfd-gmu", "cpw-gmu", PROVIDER, "udwr-deer-general"]);
    assert.deepEqual([...discovered].sort(), [...fromRegister].sort());
    for (const id of discovered) assert.ok(unitAdapterById(id), id);
    assert.equal(layerStatus("us-nm", "hunt-units").status, "available");
  });

  it("Four Corners: each quadrant is answered by its own state's provider only", async () => {
    serveFourCorners();
    const { az, co, ut, nm } = fourAdapters();
    const points = {
      ne: { lng: -108.95, lat: 37.05 },
      se: { lng: -108.95, lat: 36.95 },
      sw: { lng: -109.15, lat: 36.95 },
      nw: { lng: -109.15, lat: 37.05 },
    };
    // Boxes are discovery hints, not boundaries: east of the line, Arizona's and
    // Colorado's providers are asked too and must answer empty, not unavailable.
    for (const point of [points.ne, points.se]) {
      const asked = providersAt(point, unitProviders, "hunt-units").map((info) => info.id);
      for (const id of ["azgfd-gmu", "cpw-gmu", PROVIDER]) assert.ok(asked.includes(id), `${id}: ${asked.join()}`);
    }
    const answer = async (point: { lng: number; lat: number }) => {
      const results = await Promise.all([az, co, ut, nm].map((adapter) => adapter.identify(point)));
      assert.ok(results.every((result) => result.status === "available"));
      return results.flatMap((result) => result.hits.map((hit) => hit.unit.id));
    };
    assert.deepEqual(await answer(points.se), ["us-nm:nmdgf-gmu:2A"]);
    assert.deepEqual(await answer(points.sw), ["us-az:azgfd-gmu:12A"]);
    assert.deepEqual(await answer(points.ne), ["us-co:cpw-gmu:711"]);
    assert.deepEqual(await answer(points.nw), ["us-ut:udwr-deer-general:Fixture San Juan"]);
  });

  it("Four Corners: loads all four states' units for the view", async () => {
    serveFourCorners();
    const { az, co, ut, nm } = fourAdapters();
    const results = await Promise.all([az.load(), co.load(), ut.load(), nm.load()]);
    assert.deepEqual(results.map((result) => result.status), ["available", "available", "available", "available"]);
    assert.deepEqual(results.flatMap((result) => result.units.map((unit) => unit.id)), [
      "us-az:azgfd-gmu:12A",
      "us-co:cpw-gmu:711",
      "us-ut:udwr-deer-general:Fixture San Juan",
      "us-nm:nmdgf-gmu:2A",
    ]);
  });

  it("Arizona–New Mexico line near Luna: each side from its own provider, one outage hides nothing", async () => {
    const VIEW = { west: -109.4, south: 33.6, east: -108.7, north: 34.1 };
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    assert.ok(states.includes("us-az") && states.includes("us-nm"), states.join());
    assert.deepEqual(
      providersForView(VIEW, unitProviders, "hunt-units").map((info) => info.id).sort(),
      ["azgfd-gmu", PROVIDER],
    );
    // FIXTURE units sharing the edge at -109.045.
    const azWest = azFeature(1, "1", [-109.295, 33.7]);
    const nmEast = nmFeature(1, "15", [-109.045, 33.7]);
    const west = { lng: -109.1, lat: 33.8 };
    const east = { lng: -109.0, lat: 33.8 };
    assert.ok(jurisdictionsAt(east).some((j) => j.id === "us-nm"));
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azWest] },
      [NMDGF_LAYER_URL]: nmLayer([nmEast]),
    });
    const az = createAzgfdAdapter({ storage: memoryUnitStorage(), now: () => T0 });
    const nm = nmAdapter().adapter;
    const [azW, nmW, azE, nmE] = await Promise.all([az.identify(west), nm.identify(west), az.identify(east), nm.identify(east)]);
    assert.deepEqual(azW.hits.map((hit) => hit.unit.id), ["us-az:azgfd-gmu:1"]);
    assert.deepEqual(nmW, { status: "available", hits: [], message: null }, "Arizona ground inside NM's box: no GMU, not unavailable");
    assert.deepEqual(azE, { status: "available", hits: [], message: null });
    assert.deepEqual(nmE.hits.map((hit) => hit.unit.id), ["us-nm:nmdgf-gmu:15"]);

    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azWest], identify: () => new Response("down", { status: 503 }) },
      [NMDGF_LAYER_URL]: nmLayer([nmEast]),
    });
    const [azDown, nmUp] = await Promise.all([
      createAzgfdAdapter({ storage: memoryUnitStorage(), now: () => T0 }).identify(east),
      nmAdapter().adapter.identify(east),
    ]);
    assert.equal(azDown.status, "unavailable", "Arizona is down with no saved copy");
    assert.equal(nmUp.status, "available");
    assert.deepEqual(nmUp.hits.map((hit) => hit.unit.code), ["15"]);
  });

  it("Colorado–New Mexico line near Chama: a point just north is Colorado's, just south is New Mexico's", async () => {
    const coNorth = coFeature(1, 80, [-106.6, 37.0]);
    const nmSouth = nmFeature(1, "4", [-106.6, 36.75]);
    serve({
      [CPW_LAYER_URL]: { meta: coLayerMetadata(50), features: [coNorth] },
      [NMDGF_LAYER_URL]: nmLayer([nmSouth]),
    });
    const co = createCpwAdapter({ storage: memoryUnitStorage(), now: () => T0 });
    const nm = nmAdapter().adapter;
    const north = { lng: -106.5, lat: 37.03 };
    const south = { lng: -106.5, lat: 36.97 };
    const [coN, nmN, coS, nmS] = await Promise.all([co.identify(north), nm.identify(north), co.identify(south), nm.identify(south)]);
    assert.deepEqual(coN.hits.map((hit) => hit.unit.label), ["GMU 80"]);
    assert.deepEqual(nmN, { status: "available", hits: [], message: null });
    assert.deepEqual(coS, { status: "available", hits: [], message: null });
    assert.deepEqual(nmS.hits.map((hit) => hit.unit.label), ["GMU 4"]);
  });
});

describe("NMDGF search and registry", () => {
  async function loadedUnits() {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "2A", azCell(0, 0))] },
      [NMDGF_LAYER_URL]: nmLayer([
        nmFeature(1, "2A", nmCell(0, 0)),
        nmFeature(2, "2B", nmCell(1, 0)),
        nmFeature(3, "16", nmCell(2, 0)),
        nmFeature(4, "16D", nmCell(3, 0)),
        nmFeature(5, "6C", nmCell(4, 0)),
      ]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const nm = await nmAdapter(clock(), storage).adapter.load();
    return [...az.units, ...nm.units];
  }

  it("finds a lettered sub-unit by its code, in any case or spacing, and only that sub-unit", async () => {
    const units = await loadedUnits();
    for (const q of ["16D", "16d", "16 D", "gmu 16d", "GMU 16-D", "unit 16d", "nm 16d", "16D New Mexico"]) {
      assert.deepEqual(searchUnits(units, q).map((r) => r.label), ["GMU 16D · New Mexico"], q);
    }
    assert.deepEqual(searchUnits(units, "16").map((r) => r.unit.id), ["us-nm:nmdgf-gmu:16"], "16 is not 16D");
    assert.deepEqual(searchUnits(units, "new mexico 6c").map((r) => r.unit.id), ["us-nm:nmdgf-gmu:6C"]);
  });

  it("disambiguates a code shared with Arizona, ranking the named state first", async () => {
    const units = await loadedUnits();
    assert.deepEqual(searchUnits(units, "2a").map((r) => r.label), ["Unit 2A · Arizona", "GMU 2A · New Mexico"]);
    for (const q of ["nm 2a", "NM 2A", "new mexico 2a", "2a nm", "gmu 2a new mexico"]) {
      const results = searchUnits(units, q);
      assert.deepEqual(results.map((r) => r.unit.id), ["us-nm:nmdgf-gmu:2A", "us-az:azgfd-gmu:2A"], q);
      assert.deepEqual(results.map((r) => r.jurisdictionMatch), [true, false], q);
    }
    assert.deepEqual(searchUnits(units, "az 2a").map((r) => r.unit.id), ["us-az:azgfd-gmu:2A", "us-nm:nmdgf-gmu:2A"]);
  });

  it("is registered with honest info and an allowlisted host", () => {
    assert.ok(UNIT_ADAPTERS.map((adapter) => adapter.info.id).includes(PROVIDER));
    const info = unitAdapterById(PROVIDER)?.info;
    assert.equal(info, NMDGF_INFO);
    assert.deepEqual(NMDGF_INFO.jurisdictionIds, ["us-nm"]);
    assert.equal(NMDGF_INFO.category, "hunt-units");
    assert.equal(NMDGF_INFO.attribution, "New Mexico Department of Wildlife");
    assert.equal(NMDGF_INFO.sourceUrl, "https://wildlife.dgf.nm.gov/");
    assert.equal(NMDGF_INFO.licenseUrl, null);
    assert.equal(NMDGF_INFO.capabilities.download, "unknown", "the source states a disclaimer, not a license");
    assert.equal(NMDGF_INFO.capabilities.redistribution, "unknown", "the source states a disclaimer, not a license");
    assert.match(NMDGF_INFO.caveat, /not the legal description \(19\.30\.4 NMAC\)/);
    assert.equal(allowedUrl(NMDGF_LAYER_URL).hostname, "services2.arcgis.com");
    const status = layerStatus("us-nm", "hunt-units");
    assert.equal(status.status, "available");
    assert.deepEqual(status.providerIds, [PROVIDER]);
    assert.match(status.note, /big-game game management units.*elk management zones.* not included/);
  });
});
