import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HuntUnit, JurisdictionId, LngLat } from "@/features/catalog/types";
import { normalizeUnitCode, parseUnitQuery, searchUnits } from "./search.ts";

// Test fixtures, not real provider data: codes mirror real AZ/ID unit names,
// geometry is a token square around a rough label point.
function fixtureUnit(
  jurisdictionId: JurisdictionId,
  providerId: string,
  code: string,
  labelPoint: LngLat,
): HuntUnit {
  const { lng, lat } = labelPoint;
  return {
    id: `${jurisdictionId}:${providerId}:${code}`,
    jurisdictionId,
    providerId,
    sourceFeatureId: code,
    code,
    label: `Unit ${code}`,
    regionName: "",
    speciesTags: [],
    seasonContext: null,
    landNote: "",
    forest: "",
    sqMiles: null,
    bounds: { west: lng - 0.1, south: lat - 0.1, east: lng + 0.1, north: lat + 0.1 },
    labelPoint,
    polygons: [
      [
        [
          [lng - 0.1, lat - 0.1],
          [lng + 0.1, lat - 0.1],
          [lng + 0.1, lat + 0.1],
          [lng - 0.1, lat + 0.1],
          [lng - 0.1, lat - 0.1],
        ],
      ],
    ],
  };
}

const AZ22 = fixtureUnit("us-az", "azgfd-gmu", "22", { lng: -111.3, lat: 34.0 });
const AZ6A = fixtureUnit("us-az", "azgfd-gmu", "6A", { lng: -111.7, lat: 34.9 });
const AZ10 = fixtureUnit("us-az", "azgfd-gmu", "10", { lng: -113.0, lat: 35.2 });
const ID22 = fixtureUnit("us-id", "idfg-gmu", "22", { lng: -116.6, lat: 44.6 });
const ID2 = fixtureUnit("us-id", "idfg-gmu", "2", { lng: -116.9, lat: 47.9 });
const ID10A = fixtureUnit("us-id", "idfg-gmu", "10A", { lng: -115.5, lat: 46.4 });
const UNITS = [ID22, AZ22, AZ6A, AZ10, ID2, ID10A];

const labels = (q: string, opts?: Parameters<typeof searchUnits>[2]) =>
  searchUnits(UNITS, q, opts).map((r) => r.label);

describe("searchUnits", () => {
  it("returns every jurisdiction's match with a disambiguating label", () => {
    assert.deepEqual(labels("22"), ["Unit 22 · Arizona", "Unit 22 · Idaho"]);
    const [first] = searchUnits(UNITS, "22");
    assert.equal(first.jurisdictionName, "Arizona");
    assert.equal(first.jurisdictionMatch, false);
    assert.equal(first.distanceMeters, null);
  });

  it("accepts unit words and any case", () => {
    for (const q of ["unit 22", "Unit 22", "GMU 22", "gmu 22", "  22  ", "Game Management Unit 22"]) {
      assert.deepEqual(labels(q), ["Unit 22 · Arizona", "Unit 22 · Idaho"], q);
    }
  });

  it("ranks the jurisdiction named in the query first", () => {
    for (const q of ["az 22", "AZ 22", "22 az", "Arizona 22", "arizona unit 22", "unit 22 Arizona"]) {
      const results = searchUnits(UNITS, q);
      assert.deepEqual(results.map((r) => r.label), ["Unit 22 · Arizona", "Unit 22 · Idaho"], q);
      assert.deepEqual(results.map((r) => r.jurisdictionMatch), [true, false], q);
    }
    assert.deepEqual(labels("id 22"), ["Unit 22 · Idaho", "Unit 22 · Arizona"]);
    assert.deepEqual(labels("22 Idaho"), ["Unit 22 · Idaho", "Unit 22 · Arizona"]);
  });

  it("honors the jurisdiction filter, with a named jurisdiction taking priority", () => {
    assert.deepEqual(labels("22", { jurisdictionId: "us-id" }), [
      "Unit 22 · Idaho",
      "Unit 22 · Arizona",
    ]);
    assert.deepEqual(labels("az 22", { jurisdictionId: "us-id" }), [
      "Unit 22 · Arizona",
      "Unit 22 · Idaho",
    ]);
  });

  it("orders by geodesic distance to a nearby point", () => {
    const boise = { lng: -116.2, lat: 43.6 };
    const results = searchUnits(UNITS, "22", { near: boise });
    assert.deepEqual(results.map((r) => r.label), ["Unit 22 · Idaho", "Unit 22 · Arizona"]);
    assert.ok(results[0].distanceMeters !== null && results[0].distanceMeters < 150_000);
    assert.ok(results[1].distanceMeters !== null && results[1].distanceMeters > 700_000);
    // The jurisdiction filter still outranks distance.
    assert.deepEqual(labels("22", { near: boise, jurisdictionId: "us-az" }), [
      "Unit 22 · Arizona",
      "Unit 22 · Idaho",
    ]);
  });

  it("handles letter-suffixed codes", () => {
    assert.deepEqual(labels("6A"), ["Unit 6A · Arizona"]);
    assert.deepEqual(labels("unit 6a"), ["Unit 6A · Arizona"]);
    assert.deepEqual(labels("az 6a"), ["Unit 6A · Arizona"]);
    assert.deepEqual(labels("10A"), ["Unit 10A · Idaho"]);
    assert.deepEqual(labels("10"), ["Unit 10 · Arizona"]);
  });

  it("matches whole codes only", () => {
    assert.deepEqual(labels("2"), ["Unit 2 · Idaho"]);
    assert.deepEqual(labels("6"), []);
    assert.deepEqual(labels("1"), []);
  });

  it("returns nothing for an empty or code-less query", () => {
    assert.deepEqual(labels(""), []);
    assert.deepEqual(labels("unit"), []);
    assert.deepEqual(labels("arizona"), []);
  });
});

describe("query parsing", () => {
  it("separates the code from a jurisdiction name", () => {
    assert.deepEqual(parseUnitQuery("New Mexico unit 34"), { code: "34", jurisdictionId: "us-nm", wholeCode: "newmexico34" });
    assert.deepEqual(parseUnitQuery("34 new mexico"), { code: "34", jurisdictionId: "us-nm", wholeCode: "34newmexico" });
    assert.deepEqual(parseUnitQuery("GMU 6A"), { code: "6a", jurisdictionId: null, wholeCode: "6a" });
  });

  it("normalizes codes without merging different ones", () => {
    assert.equal(normalizeUnitCode("06A"), "6a");
    assert.equal(normalizeUnitCode("6-A"), "6a");
    assert.equal(normalizeUnitCode("0"), "0");
    assert.notEqual(normalizeUnitCode("2"), normalizeUnitCode("22"));
    // Punctuation in named units, as the query parser treats it.
    assert.equal(normalizeUnitCode("Beaver, East"), "beavereast");
    assert.equal(normalizeUnitCode("San Juan, Abajo Mtns"), parseUnitQuery("san juan, abajo mtns").code);
  });
});

describe("named units (Utah-style names)", () => {
  // Test fixtures: names as Utah DWR writes them; geometry is a token square.
  const named = (code: string, lng: number, lat: number) => ({ ...fixtureUnit("us-ut", "udwr-deer-general", code, { lng, lat }), label: `Deer unit ${code}` });
  const UT = [
    named("Beaver, East", -112.4, 38.3),
    named("Wasatch Mtns, West", -111.6, 40.4),
    named("La Sal Mtns", -109.3, 38.5),
    named("Mt Dutton", -112.2, 38.0),
    named("Cache", -111.7, 41.7),
  ];
  const MT_DUTTON = fixtureUnit("us-mt", "mtfwp-deer-elk-lion", "Dutton", { lng: -111.7, lat: 47.8 });

  it("finds names with commas, typed with or without them", () => {
    for (const query of ["Beaver, East", "beaver east", "ut beaver, east", "Wasatch Mtns, West"]) {
      const hits = searchUnits(UT, query);
      assert.equal(hits.length, 1, query);
    }
    assert.equal(searchUnits(UT, "beaver east")[0].label, "Deer unit Beaver, East · Utah");
  });

  it("reads a leading state code as part of the name when the state reading finds nothing", () => {
    assert.equal(searchUnits(UT, "La Sal Mtns")[0]?.unit.code, "La Sal Mtns");
    assert.equal(searchUnits(UT, "mt dutton")[0]?.unit.code, "Mt Dutton");
    assert.equal(searchUnits(UT, "ut la sal mtns")[0]?.unit.code, "La Sal Mtns");
  });

  it("ranks the state reading first and still offers the whole-name match", () => {
    // "mt dutton" with a Montana unit named "Dutton": Montana's Dutton first (state match), Utah's Mt Dutton next.
    const hits = searchUnits([...UT, MT_DUTTON], "mt dutton");
    assert.deepEqual(hits.map((h) => [h.unit.id, h.jurisdictionMatch]), [
      [MT_DUTTON.id, true],
      ["us-ut:udwr-deer-general:Mt Dutton", false],
    ]);
    // Codes elsewhere are unchanged: "az 22" is still Arizona's 22 first.
    assert.equal(searchUnits(UNITS, "az 22")[0].unit.id, AZ22.id);
  });
});
