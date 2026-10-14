import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ArcgisError, fetchCount, fetchLayerMetadata, queryAllFeatures, queryPoint } from "./arcgis.ts";
import { AZ_FIELD_NAMES, azFeatures, fakeArcgis, layerMetadata } from "./fixtures/arcgis-fixtures.ts";

const LAYER = "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function install(fake: ReturnType<typeof fakeArcgis>) {
  globalThis.fetch = fake.fetch;
  return fake;
}

const query = { where: "1=1", outFields: ["OBJECTID", "GMU"], orderByField: "OBJECTID", pageSize: 2 };

describe("arcgis query helper", () => {
  it("assembles every feature across pages and matches the server count", async () => {
    const fake = install(fakeArcgis({ [LAYER]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES }), features: azFeatures(5) } }));
    const count = await fetchCount(LAYER, "1=1");
    const { features, pages } = await queryAllFeatures(LAYER, query);
    assert.equal(count, 5);
    assert.equal(features.length, count);
    assert.equal(pages, 3);
    const offsets = fake.calls.filter((url) => url.searchParams.has("resultOffset")).map((url) => url.searchParams.get("resultOffset"));
    assert.deepEqual(offsets, ["0", "2", "4"]);
    const page = fake.calls.find((url) => url.searchParams.has("resultOffset"));
    assert.equal(page?.searchParams.get("orderByFields"), "OBJECTID");
    assert.equal(page?.searchParams.get("outSR"), "4326");
    assert.equal(page?.searchParams.get("f"), "geojson");
  });

  it("never asks for more than 2000 records per page and stops at the page cap", async () => {
    const fake = install(fakeArcgis({ [LAYER]: { meta: {}, features: azFeatures(5) } }));
    await queryAllFeatures(LAYER, { ...query, pageSize: 50_000 });
    assert.equal(fake.calls[0].searchParams.get("resultRecordCount"), "2000");
    await assert.rejects(queryAllFeatures(LAYER, { ...query, maxPages: 2 }), (error: unknown) => {
      return error instanceof ArcgisError && error.code === "limit";
    });
  });

  it("refuses hosts outside the allowlist without making a request", async () => {
    const fake = install(fakeArcgis({}));
    for (const url of ["https://example.com/arcgis/rest/services/x/FeatureServer/0", "http://services8.arcgis.com/x/FeatureServer/0"]) {
      await assert.rejects(fetchCount(url, "1=1"), (error: unknown) => error instanceof ArcgisError && error.code === "blocked-host");
    }
    assert.equal(fake.calls.length, 0);
  });

  it("turns an HTTP-200 ArcGIS error body into a service error", async () => {
    install(fakeArcgis({ [LAYER]: { meta: {}, features: [], count: { error: { code: 400, message: "Invalid field: GMU" } } } }));
    await assert.rejects(fetchCount(LAYER, "1=1"), (error: unknown) => error instanceof ArcgisError && error.code === "service");
  });

  it("times out a request that never answers", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    await assert.rejects(fetchCount(LAYER, "1=1", { timeoutMs: 20 }), (error: unknown) => {
      return error instanceof ArcgisError && error.code === "timeout";
    });
  });

  it("passes caller aborts through as AbortError", async () => {
    install(fakeArcgis({ [LAYER]: { meta: {}, features: [] } }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchCount(LAYER, "1=1", { signal: controller.signal }), { name: "AbortError" });
  });

  it("reads layer metadata and rejects malformed metadata", async () => {
    install(fakeArcgis({ [LAYER]: { meta: layerMetadata({ fields: AZ_FIELD_NAMES, maxRecordCount: 2000, editDate: 1588084347257 }), features: [] } }));
    const meta = await fetchLayerMetadata(LAYER);
    assert.equal(meta.maxRecordCount, 2000);
    assert.equal(meta.editDate, 1588084347257);
    assert.equal(meta.supportsPagination, true);
    assert.ok(meta.fields.includes("GMU"));
    install(fakeArcgis({ [LAYER]: { meta: { fields: [] }, features: [] } }));
    await assert.rejects(fetchLayerMetadata(LAYER), (error: unknown) => error instanceof ArcgisError && error.code === "shape");
  });

  it("returns every attribute row from a point query", async () => {
    install(
      fakeArcgis({
        [LAYER]: { meta: {}, features: [], identify: { features: [{ attributes: { GMU: "1" } }, { attributes: { GMU: "2" } }] } },
      }),
    );
    const rows = await queryPoint(LAYER, { lng: -112, lat: 34 }, { where: "1=1", outFields: ["GMU"] });
    assert.deepEqual(rows, [{ GMU: "1" }, { GMU: "2" }]);
  });
});
