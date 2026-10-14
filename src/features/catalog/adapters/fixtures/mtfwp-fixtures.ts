/**
 * TEST FIXTURES ONLY. Synthetic data shaped like the Montana FWP
 * huntingDistricts MapServer layer 11 responses observed 2026-10-14 (fields,
 * no editingInfo, paged `f=geojson`). District codes, regions, years, areas
 * and boundaries are invented; never treat them as provider data.
 */
import { layerMetadata, squareRing, type FixtureFeature } from "./arcgis-fixtures.ts";

/** Field list of the live layer (OBJECTID is the esriFieldTypeOID field). */
export const MT_FIELD_NAMES = [
  "DISTRICT",
  "DEERWEBPAGE",
  "ELKWEBPAGE",
  "MAPLINK",
  "REG",
  "AREA_AC",
  "AREA_KM",
  "AREA_MI",
  "OBJECTID",
  "SHAPE",
  "REGYEAR",
];

/** The live layer publishes no editingInfo, so no edit date. */
export function mtLayerMetadata(maxRecordCount = 2000): Record<string, unknown> {
  return { ...layerMetadata({ fields: MT_FIELD_NAMES, maxRecordCount, editDate: null }), type: "Feature Layer" };
}

/** Corner of grid cell (col, row) inside western Montana. */
export function mtCell(col: number, row: number): [number, number] {
  return [-115.5 + col * 0.3, 44.6 + row * 0.3];
}

export function mtFeature(
  oid: number,
  code: string,
  corner: [number, number],
  overrides: Record<string, unknown> = {},
  geometry?: unknown,
): FixtureFeature {
  return {
    type: "Feature",
    id: oid,
    geometry: geometry ?? { type: "Polygon", coordinates: [squareRing(corner[0], corner[1], 0.25)] },
    properties: {
      OBJECTID: oid,
      DISTRICT: code,
      REG: String(1 + (oid % 7)),
      REGYEAR: "2099",
      AREA_MI: 500 + oid,
      ...overrides,
    },
  };
}

/** n features with FIXTURE codes "100", "101", ... on a 10-column grid. */
export function mtFeatures(n: number): FixtureFeature[] {
  return Array.from({ length: n }, (_, i) => mtFeature(i + 1, String(100 + i), mtCell(i % 10, Math.floor(i / 10))));
}
