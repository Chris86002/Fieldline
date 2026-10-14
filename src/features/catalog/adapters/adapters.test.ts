import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DAY_MS, memoryUnitStorage } from "../unit-store.ts";
import { polygonContains } from "../unit-geometry.ts";
import { AZGFD_LAYER_URL, createAzgfdAdapter } from "./azgfd.ts";
import { createIdfgAdapter, IDFG_LAYER_URL } from "./idfg.ts";
import { UNIT_ADAPTERS, unitAdapterById } from "./index.ts";
import {
  AZ_FIELD_NAMES,
  azCell,
  azFeature,
  azFeatures,
  fakeArcgis,
  ID_FIELD_NAMES,
  idCell,
  idFeature,
  layerMetadata,
  squareRing,
  type FakeLayer,
} from "./fixtures/arcgis-fixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const T0 = Date.UTC(2026, 9, 1);
const EDIT = Date.UTC(2020, 3, 28);

function clock(start = T0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

function azLayer(features = azFeatures(5), extra: Partial<FakeLayer> = {}): FakeLayer {
  return { meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2, editDate: EDIT }), features, ...extra };
}

function serve(layers: Record<string, FakeLayer>) {
  const fake = fakeArcgis(layers);
  globalThis.fetch = fake.fetch;
  return fake;
}

function azAdapter(time = clock(), storage = memoryUnitStorage()) {
  return { adapter: createAzgfdAdapter({ storage, now: time.now, retryMs: 0 }), storage, time };
}

/** Loads a good 10-unit AZ copy at T0, then ages it past the refresh policy. */
async function withGoodCopy(units = 10) {
  const setup = azAdapter();
  serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(units)) });
  const first = await setup.adapter.load();
  assert.equal(first.status, "available");
  assert.equal(first.units.length, units);
  setup.time.advance(31 * DAY_MS);
  return setup;
}

describe("AZGFD / IDFG adapters: loading", () => {
  it("assembles features across 2+ pages and matches the returnCountOnly count", async () => {
    const fake = serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5)) });
    const { adapter, storage } = azAdapter();
    const result = await adapter.load();
    assert.equal(result.status, "available");
    assert.equal(result.message, null);
    assert.equal(result.units.length, 5);
    assert.equal(fake.count("page"), 3, "maxRecordCount 2 → three pages");
    assert.equal(fake.count("count"), 1);
    assert.equal(result.sourceVersion, new Date(EDIT).toISOString());
    assert.equal(result.retrievedAt, T0);
    const stored = storage.snapshots.get("azgfd-gmu") as { manifest: Record<string, unknown> };
    assert.equal(stored.manifest.featureCount, 5);
    assert.equal(stored.manifest.expectedCount, 5);
    assert.equal(stored.manifest.schemaVersion, 3);
    assert.equal(stored.manifest.providerId, "azgfd-gmu");
  });

  it("maps AZ fields without inventing values", async () => {
    serve({
      [AZGFD_LAYER_URL]: azLayer([
        azFeature(1, "22", azCell(0, 0)),
        azFeature(2, "6A", azCell(1, 0), { SQ_MILES: null, REG_NAME: null, HUNT: "", USFSName: null, LANDOWN: null }),
        azFeature(3, "N/A", azCell(2, 0)),
      ]),
    });
    const { units } = await azAdapter().adapter.load();
    assert.deepEqual(
      units.map((unit) => unit.code),
      ["6A", "22"],
    );
    const full = units.find((unit) => unit.code === "22");
    assert.ok(full);
    assert.equal(full.id, "us-az:azgfd-gmu:22");
    assert.equal(full.label, "Unit 22");
    assert.equal(full.sourceFeatureId, "22");
    assert.equal(full.regionName, "FIXTURE Region");
    assert.deepEqual(full.speciesTags, ["Elk", "Mule Deer", "Javelina"]);
    assert.equal(full.landNote, "FIXTURE National Forest, Private");
    assert.equal(full.forest, "FIXTURE National Forest");
    assert.equal(full.sqMiles, 101);
    assert.equal(full.seasonContext, null);
    const sparse = units.find((unit) => unit.code === "6A");
    assert.ok(sparse);
    assert.equal(sparse.sqMiles, null, "a null SQ_MILES is not zero");
    assert.equal(sparse.regionName, "");
    assert.deepEqual(sparse.speciesTags, []);
    assert.equal(sparse.forest, "");
  });

  it("maps ID fields: NAME is the code and Elk_Zone becomes season context", async () => {
    serve({
      [IDFG_LAYER_URL]: {
        meta: layerMetadata({ fields: ID_FIELD_NAMES }),
        features: [idFeature(1, "39", idCell(0, 0), "Boise River"), idFeature(2, "40", idCell(1, 0), null)],
      },
    });
    const result = await createIdfgAdapter({ storage: memoryUnitStorage(), now: () => T0 }).load();
    assert.equal(result.status, "available");
    assert.equal(result.sourceVersion, null, "IDFG publishes no edit date");
    const [a, b] = result.units;
    assert.equal(a.id, "us-id:idfg-gmu:39");
    assert.equal(a.seasonContext, "Elk zone: Boise River");
    assert.equal(a.regionName, "");
    assert.equal(b.seasonContext, null);
    assert.equal(b.sqMiles, null);
  });

  it("groups multipart features by code and preserves holes", async () => {
    const [w, s] = azCell(0, 0);
    const holed = { type: "Polygon", coordinates: [squareRing(w, s, 0.25), squareRing(w + 0.1, s + 0.1, 0.05)] };
    serve({ [AZGFD_LAYER_URL]: azLayer([azFeature(1, "1", azCell(0, 0), {}, holed), azFeature(2, "1", azCell(3, 3))]) });
    const { units } = await azAdapter().adapter.load();
    assert.equal(units.length, 1);
    const [unit] = units;
    assert.equal(unit.polygons.length, 2);
    assert.equal(unit.polygons[0].length, 2, "hole kept");
    const [lw, ls] = azCell(3, 3);
    assert.equal(polygonContains(unit.polygons[1], lw + 0.1, ls + 0.1), true);
    assert.ok(unit.polygons.some((polygon) => polygonContains(polygon, unit.labelPoint.lng, unit.labelPoint.lat)));
  });

  it("rejects truncated pagination, keeps the last good copy and reports stale", async () => {
    const { adapter, storage } = await withGoodCopy(10);
    // The server counts 10 but the last page is missing (no exceededTransferLimit after 8).
    serve({
      [AZGFD_LAYER_URL]: azLayer(azFeatures(10), {
        page: (offset, size, features) => {
          const slice = features.slice(offset, Math.min(offset + size, 8));
          return offset + size < 8
            ? { type: "FeatureCollection", features: slice, properties: { exceededTransferLimit: true } }
            : { type: "FeatureCollection", features: slice };
        },
        meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2, editDate: EDIT + 1 }),
      }),
    });
    const result = await adapter.load();
    assert.equal(result.status, "stale");
    assert.equal(result.units.length, 10);
    assert.equal(result.retrievedAt, T0);
    assert.match(result.message ?? "", /8 of 10 features/);
    assert.equal(storage.rejections.length, 1);
    assert.equal(storage.rejections[0].featureCount, 8);
    assert.equal((storage.snapshots.get("azgfd-gmu") as { units: unknown[] }).units.length, 10, "stored copy untouched");
  });

  it("handles an empty HTTP-200 response: stale with a good copy, unavailable without; never throws", async () => {
    const empty = () => azLayer([], { count: { count: 0 }, meta: layerMetadata({ fields: AZ_FIELD_NAMES, editDate: EDIT + 1 }) });
    const { adapter } = await withGoodCopy(10);
    serve({ [AZGFD_LAYER_URL]: empty() });
    const kept = await adapter.load();
    assert.equal(kept.status, "stale");
    assert.equal(kept.units.length, 10);
    assert.match(kept.message ?? "", /no features/);

    serve({ [AZGFD_LAYER_URL]: empty() });
    const none = await azAdapter().adapter.load();
    assert.equal(none.status, "unavailable");
    assert.deepEqual(none.units, []);
    assert.equal(none.retrievedAt, null);
    assert.match(none.message ?? "", /no features/);

    // Count says 5 but the page is an empty FeatureCollection.
    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5), { page: () => ({ type: "FeatureCollection", features: [] }) }) });
    const blank = await azAdapter().adapter.load();
    assert.equal(blank.status, "unavailable");
  });

  it("rejects a renamed or missing required field", async () => {
    // Service schema no longer lists GMU.
    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5), { meta: layerMetadata({ fields: AZ_FIELD_NAMES.map((f) => (f === "GMU" ? "GMU_CODE" : f)) }) }) });
    const bySchema = azAdapter();
    const schema = await bySchema.adapter.load();
    assert.equal(schema.status, "unavailable");
    assert.match(schema.message ?? "", /"GMU".*renamed or removed/);
    assert.equal(bySchema.storage.rejections.length, 1);

    // Schema lists GMU but features arrive without it.
    const renamed = azFeatures(5).map((feature) => {
      const { GMU, ...rest } = feature.properties;
      return { ...feature, properties: { ...rest, GMU_CODE: GMU } };
    });
    serve({ [AZGFD_LAYER_URL]: azLayer(renamed) });
    const byRows = await azAdapter().adapter.load();
    assert.equal(byRows.status, "unavailable");
    assert.match(byRows.message ?? "", /required field "GMU"/);

    // With a good copy the rename is quarantined and the copy kept.
    const { adapter } = await withGoodCopy(10);
    serve({ [AZGFD_LAYER_URL]: azLayer(renamed, { meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2, editDate: EDIT + 1 }) }) });
    const kept = await adapter.load();
    assert.equal(kept.status, "stale");
    assert.equal(kept.units.length, 10);
  });

  it("rejects malformed geometry", async () => {
    const features = azFeatures(5);
    features[3] = azFeature(4, "4", azCell(3, 0), {}, { type: "Polygon", coordinates: [[["x", 1], [2, 2], [3, 3], ["x", 1]]] });
    serve({ [AZGFD_LAYER_URL]: azLayer(features) });
    const result = await azAdapter().adapter.load();
    assert.equal(result.status, "unavailable");
    assert.match(result.message ?? "", /unit 4 has malformed geometry/);

    const outside = azFeatures(5);
    outside[0] = azFeature(1, "1", [10, 10]);
    serve({ [AZGFD_LAYER_URL]: azLayer(outside) });
    const far = await azAdapter().adapter.load();
    assert.equal(far.status, "unavailable");
    assert.match(far.message ?? "", /outside the provider's coverage/);
  });

  it("quarantines a large drop versus the last good copy but accepts a small one", async () => {
    const { adapter, storage } = await withGoodCopy(10);
    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(7), { meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2, editDate: EDIT + 1 }) }) });
    const dropped = await adapter.load();
    assert.equal(dropped.status, "stale");
    assert.equal(dropped.units.length, 10);
    assert.match(dropped.message ?? "", /fell from 10 to 7/);
    assert.equal(adapter.store.lastRejection()?.unitCount, 7);
    assert.equal(storage.rejections.length, 1);

    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(9), { meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2, editDate: EDIT + 2 }) }) });
    const accepted = await adapter.load();
    assert.equal(accepted.status, "available");
    assert.equal(accepted.units.length, 9);
  });

  it("returns an old copy as stale when refresh fails, and fresh copies without any request", async () => {
    const { adapter, time } = await withGoodCopy(10);
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const stale = await adapter.load();
    assert.equal(stale.status, "stale");
    assert.equal(stale.units.length, 10);
    assert.match(stale.message ?? "", /saved copy .* from 2026-10-01/);
    assert.match(stale.message ?? "", /could not be reached/);

    // A fresh copy (inside 30 days) is served without touching the network.
    const fresh = azAdapter(clock(T0));
    const fake = serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(10)) });
    await fresh.adapter.load();
    const callsAfterFirst = fake.calls.length;
    fresh.time.advance(29 * DAY_MS);
    const again = await fresh.adapter.load();
    assert.equal(again.status, "available");
    assert.equal(fake.calls.length, callsAfterFirst);
    void time;
  });

  it("renews an old copy with only metadata and count requests when the edit date and count are unchanged", async () => {
    const { adapter, time } = await withGoodCopy(10);
    const fake = serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(10)) });
    const renewed = await adapter.load();
    assert.equal(renewed.status, "available");
    assert.equal(renewed.retrievedAt, T0, "features were not re-downloaded");
    assert.equal(fake.count("page"), 0);
    assert.equal(fake.count("meta"), 1);
    assert.equal(fake.count("count"), 1);
    time.advance(DAY_MS);
    await adapter.load();
    assert.equal(fake.calls.length, 2, "renewed copy counts as fresh");
  });

  it("dedupes concurrent loads and does not cache failures", async () => {
    const fake = serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5)) });
    const { adapter } = azAdapter();
    const [a, b] = await Promise.all([adapter.load(), adapter.load()]);
    assert.equal(a, b);
    assert.equal(fake.count("meta"), 1);

    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const retry = azAdapter();
    const failed = await retry.adapter.load();
    assert.equal(failed.status, "unavailable");
    assert.match(failed.message ?? "", /HTTP 503/);
    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5)) });
    const recovered = await retry.adapter.load();
    assert.equal(recovered.status, "available");
  });

  it("rejects with AbortError when the caller aborts", async () => {
    serve({ [AZGFD_LAYER_URL]: azLayer(azFeatures(5)) });
    const { adapter } = azAdapter();
    const controller = new AbortController();
    const pending = adapter.load(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(adapter.identify({ lng: -112, lat: 34 }, controller.signal), { name: "AbortError" });
  });
});

describe("AZGFD / IDFG adapters: identify", () => {
  it("returns every overlapping unit from the provider's point query", async () => {
    serve({
      [AZGFD_LAYER_URL]: azLayer([], {
        identify: { features: [{ attributes: { GMU: "6A", REG_NAME: "FIXTURE" } }, { attributes: { GMU: "6B", SQ_MILES: 12 } }] },
      }),
    });
    const result = await azAdapter().adapter.identify({ lng: -111.7, lat: 35 });
    assert.equal(result.status, "available");
    assert.deepEqual(
      result.hits.map((hit) => [hit.unit.id, hit.approximate]),
      [
        ["us-az:azgfd-gmu:6A", false],
        ["us-az:azgfd-gmu:6B", false],
      ],
    );
    assert.equal(result.hits[1].unit.sqMiles, 12);
  });

  it("falls back to the local copy (approximate) when the provider fails", async () => {
    const [w, s] = azCell(0, 0);
    const overlapping = [azFeature(1, "1", [w, s]), azFeature(2, "2", [w + 0.1, s + 0.1])];
    serve({ [AZGFD_LAYER_URL]: azLayer(overlapping) });
    const { adapter } = azAdapter();
    await adapter.load();
    serve({ [AZGFD_LAYER_URL]: azLayer(overlapping, { identify: () => new Response("err", { status: 500 }) }) });
    const result = await adapter.identify({ lng: w + 0.15, lat: s + 0.15 });
    assert.equal(result.status, "available");
    assert.deepEqual(
      result.hits.map((hit) => [hit.unit.code, hit.approximate]),
      [
        ["1", true],
        ["2", true],
      ],
    );
    assert.match(result.message ?? "", /saved copy/);
  });

  it("reports unavailable with no hits when the provider fails and there is no local copy", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const result = await azAdapter().adapter.identify({ lng: -112, lat: 34 });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.hits, []);
    assert.ok(result.message);
  });

  it("answers outside coverage without a request", async () => {
    const fake = serve({});
    const result = await azAdapter().adapter.identify({ lng: -100, lat: 40 });
    assert.deepEqual(result, { status: "available", hits: [], message: null });
    assert.equal(fake.calls.length, 0);
  });
});

describe("unit adapter registry", () => {
  it("namespaces ids so AZ and ID codes that collide stay unique", async () => {
    serve({
      [AZGFD_LAYER_URL]: azLayer([azFeature(1, "1", azCell(0, 0)), azFeature(2, "10", azCell(1, 0))]),
      [IDFG_LAYER_URL]: { meta: layerMetadata({ fields: ID_FIELD_NAMES }), features: [idFeature(1, "1", idCell(0, 0)), idFeature(2, "10", idCell(1, 0))] },
    });
    const az = await azAdapter().adapter.load();
    const id = await createIdfgAdapter({ storage: memoryUnitStorage(), now: () => T0 }).load();
    const ids = [...az.units, ...id.units].map((unit) => unit.id);
    assert.deepEqual(ids, ["us-az:azgfd-gmu:1", "us-az:azgfd-gmu:10", "us-id:idfg-gmu:1", "us-id:idfg-gmu:10"]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("registers both providers with complete info", () => {
    assert.deepEqual(
      UNIT_ADAPTERS.map((adapter) => adapter.info.id),
      ["azgfd-gmu", "idfg-gmu"],
    );
    const az = unitAdapterById("azgfd-gmu")?.info;
    const id = unitAdapterById("idfg-gmu")?.info;
    assert.ok(az && id);
    assert.deepEqual(az.jurisdictionIds, ["us-az"]);
    assert.deepEqual(id.jurisdictionIds, ["us-id"]);
    assert.equal(az.capabilities.download, "unknown");
    // The live layer's copyright text no longer says CC BY (2026-10-14), so storage rights are unverified.
    assert.equal(id.capabilities.redistribution, "unknown");
    assert.match(az.caveat, /R12-4-108/);
    assert.match(id.caveat, /not the legal boundary/);
    assert.equal(unitAdapterById("nope"), null);
  });
});
