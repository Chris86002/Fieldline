import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { jurisdictionsAt, jurisdictionsInBounds, layerStatus } from "../coverage.ts";
import { providersAt, providersForView } from "../discovery.ts";
import { searchUnits } from "../search.ts";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonsContain } from "../unit-geometry.ts";
import { allowedUrl } from "./arcgis.ts";
import { AZGFD_LAYER_URL, createAzgfdAdapter } from "./azgfd.ts";
import { CPW_INFO, CPW_LAYER_URL, createCpwAdapter, mapCpwAttributes } from "./cpw.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import { createMtfwpAdapter, MTFWP_LAYER_URL } from "./mtfwp.ts";
import { AZ_FIELD_NAMES, azCell, azFeature, fakeArcgis, layerMetadata, squareRing, type FakeLayer } from "./fixtures/arcgis-fixtures.ts";
import { CO_EDIT, coCell, coFeature, coFeatures, coLayerMetadata } from "./fixtures/cpw-fixtures.ts";
import { mtCell, mtFeature, mtLayerMetadata } from "./fixtures/mtfwp-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function coLayer(features = coFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: coLayerMetadata(50), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function coAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createCpwAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

/** Loads a good copy at T0, then ages it past the refresh policy. */
async function withGoodCopy(n = 20) {
  const setup = coAdapter();
  serve({ [CPW_LAYER_URL]: coLayer(coFeatures(n)) });
  const first = await setup.adapter.load();
  assert.equal(first.status, "available");
  setup.time.advance(31 * DAY_MS);
  return setup;
}

describe("CPW adapter: field mapping", () => {
  it("maps GMUID, herd units (DAU) and SqMilesGIS as specified", () => {
    assert.deepEqual(
      mapCpwAttributes({
        GMUID: 201,
        COUNTY: "FIXTURE",
        DEERDAU: "D-1",
        ELKDAU: " E-1 ",
        ANTDAU: "A-11",
        MOOSEDAU: "M-10",
        BEARDAU: "B-15",
        LIONDAU: "L-NW",
        SqMilesGIS: 240.5,
      }),
      {
        code: "201",
        regionName: "",
        speciesTags: [],
        seasonContext: "Herd units (DAU): deer D-1, elk E-1, pronghorn A-11, moose M-10, bear B-15, lion L-NW",
        landNote: "",
        forest: "",
        sqMiles: 240.5,
      },
    );
  });

  it("leaves out undocumented -99 herd codes and keeps missing values unknown", () => {
    const sparse = mapCpwAttributes({ GMUID: 92, DEERDAU: "D-44", ELKDAU: "E-99", ANTDAU: null, MOOSEDAU: "", LIONDAU: "L-99" });
    assert.ok(sparse);
    assert.equal(sparse.seasonContext, "Herd units (DAU): deer D-44");
    assert.equal(sparse.sqMiles, null, "an absent SqMilesGIS is not zero");
    const none = mapCpwAttributes({ GMUID: 93, DEERDAU: "D-99", ELKDAU: "E-99", SqMilesGIS: 0 });
    assert.equal(none?.seasonContext, null);
    assert.equal(none?.sqMiles, null, "a zero SqMilesGIS is not an area");
    assert.equal(mapCpwAttributes({ GMUID: 5, SqMilesGIS: null })?.sqMiles, null);
    assert.equal(mapCpwAttributes({ GMUID: 5, SqMilesGIS: "" })?.sqMiles, null);
  });

  it("accepts GMUID as an integer or digit string and rejects anything else", () => {
    assert.equal(mapCpwAttributes({ GMUID: " 044 " })?.code, "44");
    assert.equal(mapCpwAttributes({ GMUID: "851" })?.code, "851");
    for (const bad of [null, undefined, "", "  ", 0, -3, 3.5, "6A", "N/A", Number.NaN, {}]) {
      assert.equal(mapCpwAttributes({ GMUID: bad }), null, String(bad));
    }
  });

  it("builds namespaced ids that do not collide with AZ or MT codes", async () => {
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "22", azCell(0, 0))] },
      [MTFWP_LAYER_URL]: { meta: mtLayerMetadata(), features: [mtFeature(1, "22", mtCell(0, 0))] },
      [CPW_LAYER_URL]: coLayer([coFeature(1, 22, coCell(0, 0)), coFeature(2, 201, coCell(1, 0), { SqMilesGIS: null })]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const mt = await createMtfwpAdapter({ storage, now: () => T0 }).load();
    const co = await coAdapter(clock(), storage).adapter.load();
    assert.equal(co.status, "available");
    const ids = [...az.units, ...mt.units, ...co.units].map((unit) => unit.id);
    assert.deepEqual(ids, ["us-az:azgfd-gmu:22", "us-mt:mtfwp-deer-elk-lion:22", "us-co:cpw-gmu:22", "us-co:cpw-gmu:201"]);
    assert.equal(new Set(ids).size, ids.length);
    const [g22, g201] = co.units;
    assert.equal(g22.label, "GMU 22");
    assert.equal(g22.jurisdictionId, "us-co");
    assert.equal(g22.providerId, "cpw-gmu");
    assert.equal(g22.sourceFeatureId, "22");
    assert.equal(g22.seasonContext, "Herd units (DAU): deer D-90, elk E-91, bear B-92, lion L-ZZ");
    assert.equal(g22.sqMiles, 301);
    assert.equal(g201.sqMiles, null);
    assert.ok(co.units.every((unit) => polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat)));
  });
});

describe("CPW adapter: loading through the shared store", () => {
  it("assembles a 186-GMU paginated download and reports the edit date as source version", async () => {
    const fake = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(186)) });
    const { adapter, storage } = coAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 186);
    assert.equal(result.sourceVersion, new Date(CO_EDIT).toISOString());
    assert.equal(result.retrievedAt, T0);
    assert.equal(fake.count("page"), 4, "maxRecordCount 50 → four pages");
    assert.equal(fake.count("count"), 1);
    const pages = fake.calls.filter((url) => url.searchParams.has("resultOffset"));
    assert.deepEqual(
      pages.map((url) => [url.searchParams.get("resultOffset"), url.searchParams.get("resultRecordCount")]),
      [["0", "50"], ["50", "50"], ["100", "50"], ["150", "50"]],
    );
    assert.equal(pages[0].searchParams.get("outFields"), "FID,GMUID,DEERDAU,ELKDAU,ANTDAU,MOOSEDAU,BEARDAU,LIONDAU,SqMilesGIS");
    assert.equal(pages[0].searchParams.get("orderByFields"), "FID");
    assert.equal(pages[0].searchParams.get("outSR"), "4326");
    assert.equal(pages[0].searchParams.get("maxAllowableOffset"), "0.002");
    assert.equal(pages[0].searchParams.get("geometryPrecision"), "4");
    assert.ok(fake.calls.every((url) => url.hostname === "services5.arcgis.com" && url.protocol === "https:"));
    const stored = storage.snapshots.get("cpw-gmu") as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 186);
    assert.equal(stored.manifest.expectedCount, 186);
  });

  it("never asks for more than maxRecordCount per page, even if told to", async () => {
    const fake = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(30)) });
    const adapter = createCpwAdapter({ storage: memoryUnitStorage(), now: () => T0, pageSize: 5000 });
    assert.equal((await adapter.load()).units.length, 30);
    const sizes = fake.calls.filter((url) => url.searchParams.has("resultRecordCount")).map((url) => url.searchParams.get("resultRecordCount"));
    assert.deepEqual(sizes, ["50"]);
  });

  it("renews an old copy without re-downloading when the edit date and count are unchanged", async () => {
    const { adapter, time } = await withGoodCopy(20);
    const fake = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(20)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0, "features were not re-downloaded");
    assert.equal(fake.count("page"), 0);
    // A new edit date triggers a full download.
    time.advance(31 * DAY_MS);
    const edited = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(20), { meta: coLayerMetadata(50, CO_EDIT + 1) }) });
    const updated = await adapter.load();
    assert.equal(updated.status, "available");
    assert.equal(updated.sourceVersion, new Date(CO_EDIT + 1).toISOString());
    assert.ok(edited.count("page") >= 1);
  });

  it("keeps empty, outage and truncated results distinct and never throws", async () => {
    // Empty HTTP-200 layer, no saved copy: unavailable "no features".
    serve({ [CPW_LAYER_URL]: coLayer([], { count: { count: 0 } }) });
    const empty = await coAdapter().adapter.load();
    assert.equal(empty.status, "unavailable");
    assert.deepEqual(empty.units, []);
    assert.match(empty.message ?? "", /no features/);

    // Outage, no saved copy: unavailable, saying why.
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const down = await coAdapter().adapter.load();
    assert.equal(down.status, "unavailable");
    assert.match(down.message ?? "", /could not be reached/);
    assert.doesNotMatch(down.message ?? "", /no features/);

    // Outage with an old saved copy: stale, units kept.
    const { adapter } = await withGoodCopy(20);
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const stale = await adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 20);
    assert.match(stale.message ?? "", /HTTP 503/);

    // Truncated: the server counts 186 but stops at 120 without flagging more.
    serve({
      [CPW_LAYER_URL]: coLayer(coFeatures(186), {
        page: (offset, size, all) => {
          const slice = all.slice(offset, Math.min(offset + size, 120));
          return offset + size < 120
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
      }),
    });
    const cut = await coAdapter().adapter.load();
    assert.equal(cut.status, "unavailable");
    assert.match(cut.message ?? "", /120 of 186 features/);
  });

  it("rejects malformed data: renamed field, bad geometry, repeated features, out-of-state units", async () => {
    const renamed = coFeatures(5).map((feature) => {
      const { GMUID, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, GMU: GMUID } };
    });
    serve({ [CPW_LAYER_URL]: coLayer(renamed) });
    const byRows = await coAdapter().adapter.load();
    assert.equal(byRows.status, "unavailable");
    assert.match(byRows.message ?? "", /required field "GMUID"/);

    serve({ [CPW_LAYER_URL]: coLayer(coFeatures(5), { meta: layerMetadata({ fields: ["FID", "GMU_ID", "SqMilesGIS"] }) }) });
    const bySchema = await coAdapter().adapter.load();
    assert.equal(bySchema.status, "unavailable");
    assert.match(bySchema.message ?? "", /"GMUID".*renamed or removed/);

    const broken = coFeatures(5);
    broken[2] = coFeature(3, 502, coCell(2, 0), {}, { type: "Polygon", coordinates: [[[-106, "x"], [-105.9, 39], [-106, 39.1], [-106, "x"]]] });
    serve({ [CPW_LAYER_URL]: coLayer(broken) });
    const geometry = await coAdapter().adapter.load();
    assert.equal(geometry.status, "unavailable");
    assert.match(geometry.message ?? "", /unit 502 has malformed geometry/);

    const lineString = coFeatures(5);
    lineString[0] = coFeature(1, 500, coCell(0, 0), {}, { type: "LineString", coordinates: [[-106, 39], [-105, 39]] });
    serve({ [CPW_LAYER_URL]: coLayer(lineString) });
    assert.equal((await coAdapter().adapter.load()).status, "unavailable");

    // The same FID on two pages (an unstable server ordering).
    const repeated = coFeatures(6);
    repeated[5] = coFeature(1, 599, coCell(5, 0));
    serve({ [CPW_LAYER_URL]: coLayer(repeated, { meta: coLayerMetadata(3) }) });
    const twice = await coAdapter().adapter.load();
    assert.equal(twice.status, "unavailable");
    assert.match(twice.message ?? "", /same feature twice/);

    // A unit placed in Kansas is outside the provider's coverage.
    const far = coFeatures(5);
    far[0] = coFeature(1, 500, [-99.5, 38.5]);
    serve({ [CPW_LAYER_URL]: coLayer(far) });
    const outside = await coAdapter().adapter.load();
    assert.equal(outside.status, "unavailable");
    assert.match(outside.message ?? "", /outside the provider's coverage/);

    // Not a FeatureCollection at all.
    serve({ [CPW_LAYER_URL]: coLayer(coFeatures(5), { page: () => ({ features: "nope" }) }) });
    assert.equal((await coAdapter().adapter.load()).status, "unavailable");

    // Rows without a usable GMUID are skipped, not invented.
    const blanks = [...coFeatures(4), coFeature(5, null, coCell(4, 0))];
    serve({ [CPW_LAYER_URL]: coLayer(blanks, { count: { count: 5 } }) });
    const skipped = await coAdapter().adapter.load();
    assert.deepEqual(
      skipped.units.map((unit) => unit.code),
      ["500", "501", "502", "503"],
    );
  });
});

describe("CPW adapter: identify", () => {
  it("returns the GMU at a point from the provider's query, without downloading", async () => {
    const [w, s] = coCell(3, 1);
    const fake = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(40)) });
    const result = await coAdapter().adapter.identify({ lng: w + 0.1, lat: s + 0.1 });
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.hits.length, 1);
    const [hit] = result.hits;
    assert.equal(hit.approximate, false);
    assert.equal(hit.unit.id, "us-co:cpw-gmu:523");
    assert.equal(hit.unit.label, "GMU 523");
    assert.deepEqual(hit.unit.speciesTags, []);
    assert.match(hit.unit.seasonContext ?? "", /^Herd units \(DAU\): deer D-90/);
    assert.equal(fake.count("identify"), 1);
    assert.equal(fake.count("page"), 0);
    const query = fake.calls.find((url) => url.searchParams.has("geometry"));
    assert.equal(query?.searchParams.get("inSR"), "4326");
    assert.equal(query?.searchParams.get("returnGeometry"), "false");
  });

  it("answers outside Colorado's coverage without a request, and invalid points as unknown", async () => {
    const fake = serve({});
    const { adapter } = coAdapter();
    // Casper, Wyoming.
    assert.deepEqual(await adapter.identify({ lng: -106.3, lat: 42.85 }), { status: "available", hits: [], message: null });
    const invalid = await adapter.identify({ lng: Number.NaN, lat: 39 });
    assert.equal(invalid.status, "unknown");
    assert.equal(fake.calls.length, 0);
  });

  it("falls back to the saved copy (approximate) when the provider fails, holes respected", async () => {
    const [w, s] = coCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    const features = [coFeature(1, 500, [w, s], {}, holed), coFeature(2, 501, coCell(1, 0))];
    serve({ [CPW_LAYER_URL]: coLayer(features) });
    const { adapter } = coAdapter();
    await adapter.load();
    serve({ [CPW_LAYER_URL]: coLayer(features, { identify: () => new Response("err", { status: 500 }) }) });
    const inside = await adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(inside.status, "available");
    assert.deepEqual(
      inside.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [["us-co:cpw-gmu:500", true]],
    );
    assert.match(inside.message ?? "", /HTTP 500.*saved copy/);
    assert.deepEqual((await adapter.identify({ lng: w + 0.12, lat: s + 0.12 })).hits, [], "a hole is not part of the GMU");

    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const noCopy = await coAdapter().adapter.identify({ lng: w + 0.05, lat: s + 0.05 });
    assert.equal(noCopy.status, "unavailable");
    assert.deepEqual(noCopy.hits, []);
    assert.match(noCopy.message ?? "", /no saved copy/);
  });
});

describe("Colorado cross-border", () => {
  const unitProviders = UNIT_ADAPTERS.map((adapter) => adapter.info);

  it("Four Corners: discovers Arizona and Colorado providers; Utah and New Mexico follow the register", () => {
    const VIEW = { west: -109.3, south: 36.8, east: -108.8, north: 37.2 };
    const states = jurisdictionsInBounds(VIEW).map((j) => j.id);
    for (const id of ["us-az", "us-co", "us-nm", "us-ut"] as const) assert.ok(states.includes(id), id);
    const fromRegister = states.flatMap((id) => layerStatus(id, "hunt-units").providerIds);
    const discovered = providersForView(VIEW, unitProviders, "hunt-units").map((info) => info.id);
    assert.ok(discovered.includes("azgfd-gmu") && discovered.includes("cpw-gmu"), discovered.join());
    assert.deepEqual([...discovered].sort(), [...fromRegister].sort());
    for (const id of discovered) assert.ok(unitAdapterById(id), id);
    assert.equal(layerStatus("us-nm", "hunt-units").status, "available");
  });

  it("a point in Colorado near the Four Corners gets the CO GMU; Arizona's provider answers empty, not unavailable", async () => {
    // FIXTURE GMU covering the corner of Colorado; real GMU numbers differ.
    const corner = { type: "Polygon", coordinates: [squareRing(-109.05, 37.0, 0.3)] };
    serve({
      [CPW_LAYER_URL]: coLayer([coFeature(1, 711, [-109.05, 37.0], {}, corner), ...coFeatures(4).slice(1)]),
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "12A", azCell(0, 0))] },
    });
    const point = { lng: -108.95, lat: 37.05 };
    const asked = providersAt(point, unitProviders, "hunt-units").map((info) => info.id);
    assert.ok(asked.includes("azgfd-gmu") && asked.includes("cpw-gmu"), asked.join());
    const co = await coAdapter().adapter.identify(point);
    const az = await createAzgfdAdapter({ storage: memoryUnitStorage(), now: () => T0 }).identify(point);
    assert.deepEqual(co.hits.map((hit) => hit.unit.label), ["GMU 711"]);
    assert.deepEqual(az, { status: "available", hits: [], message: null });
  });

  it("a point just across the Utah or Wyoming line inside CPW's coverage box returns no GMU, status available", async () => {
    const fake = serve({ [CPW_LAYER_URL]: coLayer(coFeatures(20)) });
    const { adapter } = coAdapter();
    // Utah, ~1.5 km west of the Colorado line near Dinosaur.
    const utah = { lng: -109.07, lat: 40.25 };
    assert.ok(jurisdictionsAt(utah).some((j) => j.id === "us-ut"));
    assert.deepEqual(await adapter.identify(utah), { status: "available", hits: [], message: null });
    // Wyoming, just north of the Colorado line (inside the box, rounded outward).
    assert.deepEqual(await adapter.identify({ lng: -106.5, lat: 41.05 }), { status: "available", hits: [], message: null });
    assert.equal(fake.count("identify"), 2, "both points were asked, because boxes are not boundaries");
    // Farther into Wyoming the provider is not asked at all.
    await adapter.identify({ lng: -106.5, lat: 41.3 });
    assert.equal(fake.count("identify"), 2);
  });

  it("search for a code shared with another state returns both, disambiguated", async () => {
    // FIXTURE code 22 in Arizona and Colorado.
    serve({
      [AZGFD_LAYER_URL]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: [azFeature(1, "22", azCell(0, 0))] },
      [CPW_LAYER_URL]: coLayer([coFeature(1, 22, coCell(5, 5)), coFeature(2, 23, coCell(6, 5))]),
    });
    const storage = memoryUnitStorage();
    const az = await createAzgfdAdapter({ storage, now: () => T0 }).load();
    const co = await coAdapter(clock(), storage).adapter.load();
    const units = [...az.units, ...co.units];
    assert.deepEqual(
      searchUnits(units, "22").map((r) => r.label),
      ["Unit 22 · Arizona", "GMU 22 · Colorado"],
    );
    for (const q of ["co 22", "colorado 22", "GMU 22 CO", "unit 22 colorado"]) {
      assert.deepEqual(
        searchUnits(units, q).map((r) => r.unit.id),
        ["us-co:cpw-gmu:22", "us-az:azgfd-gmu:22"],
        q,
      );
    }
  });
});

describe("CPW registry entry", () => {
  it("is registered with honest info and an allowlisted host", () => {
    assert.ok(UNIT_ADAPTERS.some((adapter) => adapter.info.id === "cpw-gmu"));
    const info = unitAdapterById("cpw-gmu")?.info;
    assert.equal(info, CPW_INFO);
    assert.deepEqual(CPW_INFO.jurisdictionIds, ["us-co"]);
    assert.equal(CPW_INFO.category, "hunt-units");
    assert.equal(CPW_INFO.attribution, "Colorado Parks and Wildlife");
    assert.equal(CPW_INFO.sourceUrl, "https://cpw.state.co.us/");
    assert.equal(CPW_INFO.licenseUrl, null);
    assert.equal(CPW_INFO.capabilities.download, "unknown", "no license granted by the provider");
    assert.equal(CPW_INFO.capabilities.redistribution, "unknown", "no license granted by the provider");
    assert.match(CPW_INFO.caveat, /Reference boundaries, not the legal description/);
    assert.equal(allowedUrl(CPW_LAYER_URL).hostname, "services5.arcgis.com");
    const register = layerStatus("us-co", "hunt-units");
    assert.equal(register.status, "available");
    assert.deepEqual(register.providerIds, ["cpw-gmu"]);
    assert.match(register.note, /big-game .* bighorn sheep and mountain goat units are not included/);
  });
});
