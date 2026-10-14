/**
 * Turns loaded hunt units from every provider into what the map and the spot
 * panel need. Pure functions; the React hook lives in use-hunt-units.ts.
 */
import type { HuntUnit, LngLat, UnitHit } from "./types.ts";
import { boundsContain, polygonsContain } from "./unit-geometry.ts";

export function toHit(unit: HuntUnit, approximate: boolean): UnitHit {
  const { id, jurisdictionId, providerId, code, label, regionName, speciesTags, seasonContext, landNote, forest, sqMiles } = unit;
  return { unit: { id, jurisdictionId, providerId, code, label, regionName, speciesTags, seasonContext, landNote, forest, sqMiles }, approximate };
}

/**
 * Every loaded unit containing the point, from every provider. Overlapping
 * systems (two states near a border, or two unit systems in one state) all
 * come back; nothing is silently dropped.
 */
export function unitsAt(units: readonly HuntUnit[], point: LngLat): UnitHit[] {
  const hits: UnitHit[] = [];
  for (const unit of units) {
    if (!boundsContain(unit.bounds, point.lng, point.lat)) continue;
    if (polygonsContain(unit.polygons, point.lng, point.lat)) hits.push(toHit(unit, true));
  }
  return hits;
}

export type UnitFeatureCollection = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { id: string; code: string };
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] } | { type: "Point"; coordinates: number[] };
  }[];
};

export function unitShapes(units: readonly HuntUnit[]): UnitFeatureCollection {
  return {
    type: "FeatureCollection",
    features: units.map((unit) => ({
      type: "Feature",
      properties: { id: unit.id, code: unit.code },
      geometry: { type: "MultiPolygon", coordinates: unit.polygons },
    })),
  };
}

export type UnitLabel = { id: string; code: string; lng: number; lat: number };

export function unitLabels(units: readonly HuntUnit[]): UnitLabel[] {
  return units.map((unit) => ({ id: unit.id, code: unit.code, lng: unit.labelPoint.lng, lat: unit.labelPoint.lat }));
}

/**
 * Short text for compact readouts: "Unit 22". When hits come from more than
 * one state, each names its state ("Unit 1 ID · Unit 1 MT") so equal codes
 * near a border stay distinguishable.
 */
export function hitsTag(hits: readonly UnitHit[]): string | null {
  if (hits.length === 0) return null;
  const states = new Set(hits.map((hit) => hit.unit.jurisdictionId));
  const tags = hits.map((hit) => (states.size > 1 ? `${hit.unit.label} ${hit.unit.jurisdictionId.slice(3).toUpperCase()}` : hit.unit.label));
  return [...new Set(tags)].join(" · ");
}
