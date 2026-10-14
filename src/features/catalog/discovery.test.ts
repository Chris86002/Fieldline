import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bounds, ProviderInfo } from "@/features/catalog/types";
import { providersAt, providersForView } from "./discovery.ts";

// Test fixtures, not the real provider registry.
function fixtureProvider(
  id: string,
  category: ProviderInfo["category"],
  coverage: Bounds[],
): ProviderInfo {
  return {
    id,
    title: `Fixture ${id}`,
    category,
    jurisdictionIds: [],
    coverage,
    attribution: "fixture",
    sourceUrl: "https://example.test/",
    licenseUrl: null,
    capabilities: { view: true, identify: true, search: false, download: "unknown", redistribution: "unknown" },
    caveat: "",
  };
}

const AZ_UNITS = fixtureProvider("az-units", "hunt-units", [
  { west: -114.82, south: 31.33, east: -109.04, north: 37.01 },
]);
const ID_UNITS = fixtureProvider("id-units", "hunt-units", [
  { west: -117.25, south: 41.98, east: -111.04, north: 49.01 },
]);
const LAND = fixtureProvider("land", "land-management", [
  { west: -124.85, south: 24.39, east: -66.88, north: 49.39 },
  { west: 172.34, south: 51.29, east: 179.86, north: 53.07 },
  { west: -179.24, south: 51.17, east: -129.97, north: 71.44 },
  { west: -178.45, south: 18.86, east: -154.75, north: 28.52 },
]);
// One box stored crossing the antimeridian.
const ALEUTIAN_UNITS = fixtureProvider("aleutian-units", "hunt-units", [
  { west: 172, south: 51, east: -165, north: 56 },
]);
const ALL = [AZ_UNITS, ID_UNITS, LAND, ALEUTIAN_UNITS];
const ids = (list: ProviderInfo[]) => list.map((p) => p.id);

describe("providersForView", () => {
  it("returns providers whose coverage intersects the view, in input order", () => {
    const phoenix = { west: -112.5, south: 33, east: -111.5, north: 34 };
    assert.deepEqual(ids(providersForView(phoenix, ALL)), ["az-units", "land"]);
  });

  it("filters by category", () => {
    const phoenix = { west: -112.5, south: 33, east: -111.5, north: 34 };
    assert.deepEqual(ids(providersForView(phoenix, ALL, "hunt-units")), ["az-units"]);
    assert.deepEqual(ids(providersForView(phoenix, ALL, "land-management")), ["land"]);
    assert.deepEqual(providersForView(phoenix, ALL, "parcels"), []);
  });

  it("finds providers in a view crossing the antimeridian", () => {
    const view = { west: 170, south: 50, east: -170, north: 55 };
    assert.deepEqual(ids(providersForView(view, ALL)), ["land", "aleutian-units"]);
    const wrapped = { west: 170, south: 50, east: 190, north: 55 };
    assert.deepEqual(ids(providersForView(wrapped, ALL)), ["land", "aleutian-units"]);
  });

  it("matches a crossing provider box from a plain view on either side", () => {
    assert.deepEqual(
      ids(providersForView({ west: -168, south: 52, east: -166, north: 54 }, ALL, "hunt-units")),
      ["aleutian-units"],
    );
    assert.deepEqual(
      ids(providersForView({ west: 173, south: 52, east: 174, north: 53 }, ALL, "hunt-units")),
      ["aleutian-units"],
    );
    assert.deepEqual(
      providersForView({ west: -150, south: 52, east: -140, north: 54 }, ALL, "hunt-units"),
      [],
    );
  });

  it("covers Hawaii and returns nothing for open ocean or a broken view", () => {
    assert.deepEqual(
      ids(providersForView({ west: -158.5, south: 20.5, east: -157.5, north: 21.8 }, ALL)),
      ["land"],
    );
    assert.deepEqual(providersForView({ west: -140, south: 0, east: -130, north: 10 }, ALL), []);
    assert.deepEqual(providersForView({ west: 0, south: 10, east: 1, north: 5 }, ALL), []);
  });

  it("returns both states' unit providers for a view across the Idaho line", () => {
    const view = { west: -114.3, south: 45.5, east: -113.6, north: 45.9 };
    assert.deepEqual(ids(providersForView(view, ALL, "hunt-units")), ["id-units"]);
    const azId = { west: -118, south: 30, east: -108, north: 50 };
    assert.deepEqual(ids(providersForView(azId, ALL, "hunt-units")), ["az-units", "id-units"]);
  });
});

describe("providersAt", () => {
  it("finds providers at a point, on both sides of 180", () => {
    assert.deepEqual(ids(providersAt({ lng: 179.5, lat: 51.8 }, ALL)), ["land", "aleutian-units"]);
    assert.deepEqual(ids(providersAt({ lng: -112, lat: 33.5 }, ALL, "hunt-units")), ["az-units"]);
    assert.deepEqual(providersAt({ lng: -135, lat: 5 }, ALL), []);
  });
});
