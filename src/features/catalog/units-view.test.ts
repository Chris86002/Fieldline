import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HuntUnit } from "./types.ts";
import { hitsTag, unitLabels, unitsAt, unitShapes } from "./units-view.ts";

// Test fixtures: two square units that overlap near a shared border, from different states.
function square(id: string, jurisdictionId: `us-${string}`, code: string, west: number, south: number): HuntUnit {
  const east = west + 1;
  const north = south + 1;
  return {
    id,
    jurisdictionId,
    providerId: `${jurisdictionId}-fixture`,
    sourceFeatureId: code,
    code,
    label: `Unit ${code}`,
    regionName: "",
    speciesTags: [],
    seasonContext: null,
    landNote: "",
    forest: "",
    sqMiles: null,
    bounds: { west, south, east, north },
    labelPoint: { lng: west + 0.5, lat: south + 0.5 },
    polygons: [[[[west, south], [east, south], [east, north], [west, north], [west, south]]]],
  };
}

const ID_UNIT = square("us-id:a:1", "us-id", "1", -115, 45);
const MT_UNIT = square("us-mt:b:1", "us-mt", "1", -114.5, 45);

describe("units from every provider", () => {
  it("returns every overlapping unit at a point, across jurisdictions", () => {
    const hits = unitsAt([ID_UNIT, MT_UNIT], { lng: -114.2, lat: 45.5 });
    assert.deepEqual(
      hits.map((hit) => hit.unit.id),
      ["us-id:a:1", "us-mt:b:1"],
    );
    assert.ok(hits.every((hit) => hit.approximate));
  });

  it("returns nothing outside every unit", () => {
    assert.deepEqual(unitsAt([ID_UNIT, MT_UNIT], { lng: -110, lat: 45.5 }), []);
  });

  it("keeps namespaced ids in map features so equal codes stay distinct", () => {
    const ids = unitShapes([ID_UNIT, MT_UNIT]).features.map((feature) => feature.properties.id);
    assert.deepEqual(ids, ["us-id:a:1", "us-mt:b:1"]);
    assert.deepEqual(unitLabels([ID_UNIT]), [{ id: "us-id:a:1", code: "1", lng: -114.5, lat: 45.5 }]);
  });

  it("names the state when equal codes from two states overlap", () => {
    assert.equal(hitsTag([]), null);
    assert.equal(hitsTag(unitsAt([ID_UNIT, MT_UNIT], { lng: -114.2, lat: 45.5 })), "Unit 1 ID · Unit 1 MT");
    assert.equal(hitsTag(unitsAt([ID_UNIT], { lng: -114.8, lat: 45.5 })), "Unit 1");
  });
});
