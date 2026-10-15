/**
 * TEST FIXTURES ONLY. Synthetic data shaped like the Utah DWR
 * "2026 Mule Deer General Season" hosted feature layer responses observed
 * 2026-10-14 (field list, editingInfo dates, paged `f=geojson`, point query
 * `f=json`). Unit names, years and boundaries are invented ("Fixture 100",
 * "Fall 2099"); never treat them as provider data.
 */
import { layerMetadata, squareRing, type FixtureFeature } from "./arcgis-fixtures.ts";

/** Field list of the live layer (OBJECTID is the esriFieldTypeOID field). */
export const UT_FIELD_NAMES = [
  "OBJECTID",
  "boundary_name",
  "description",
  "hunt_type",
  "species",
  "season",
  "SHAPE__Area",
  "SHAPE__Length",
];

/** An invented edit date (ms), standing in for editingInfo.dataLastEditDate. */
export const UT_EDIT = Date.UTC(2099, 3, 2);

export function utLayerMetadata(maxRecordCount = 2000, editDate: number | null = UT_EDIT): Record<string, unknown> {
  return layerMetadata({ fields: UT_FIELD_NAMES, maxRecordCount, editDate });
}

/** Corner of grid cell (col, row) inside central Utah. */
export function utCell(col: number, row: number): [number, number] {
  return [-113.5 + col * 0.3, 38.0 + row * 0.3];
}

export function utFeature(
  oid: number,
  name: string,
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
      boundary_name: name,
      hunt_type: "General Season",
      species: "Deer",
      season: "Fall 2099",
      ...overrides,
    },
  };
}

/** n features named "Fixture 100", "Fixture 101", ... on a 10-column grid. */
export function utFeatures(n: number): FixtureFeature[] {
  return Array.from({ length: n }, (_, i) => utFeature(i + 1, `Fixture ${100 + i}`, utCell(i % 10, Math.floor(i / 10))));
}
