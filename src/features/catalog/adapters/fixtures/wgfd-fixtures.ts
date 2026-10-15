/**
 * TEST FIXTURES ONLY. Synthetic data shaped like the Wyoming Game and Fish
 * "ElkHuntAreas" hosted feature layer responses observed 2026-10-14 (field
 * list, OBJECTID object id, double HUNTAREA / HERDUNIT, editingInfo dates,
 * paged `f=geojson`, point query `f=json`). Area numbers, names, herd units,
 * regions, areas and boundaries are invented ("Fixture Ridge", 2099);
 * never treat them as provider data.
 */
import { layerMetadata, squareRing, type FixtureFeature } from "./arcgis-fixtures.ts";

/** Field list of the live layer (OBJECTID is the esriFieldTypeOID field). */
export const WY_FIELD_NAMES = [
  "OBJECTID",
  "HUNTAREA",
  "HERDUNIT",
  "HERDNAME",
  "SqMiles",
  "HUNTNAME",
  "Region",
  "Shape__Area",
  "Shape__Length",
];

/** An invented edit date (ms), standing in for editingInfo.dataLastEditDate. */
export const WY_EDIT = Date.UTC(2099, 2, 19);

export function wyLayerMetadata(maxRecordCount = 2000, editDate: number | null = WY_EDIT): Record<string, unknown> {
  return layerMetadata({ fields: WY_FIELD_NAMES, maxRecordCount, editDate });
}

/** Corner of grid cell (col, row) inside central Wyoming (15 columns × 8 rows fit). */
export function wyCell(col: number, row: number): [number, number] {
  return [-110.5 + col * 0.3, 42.0 + row * 0.3];
}

export function wyFeature(
  oid: number,
  area: number | string | null,
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
      HUNTAREA: area,
      HERDUNIT: 900 + (oid % 5),
      HERDNAME: "Fixture Herd",
      HUNTNAME: `Fixture Ridge ${oid}`,
      Region: "Fixture",
      SqMiles: 200.25 + oid,
      ...overrides,
    },
  };
}

/** n features with FIXTURE area numbers 1, 2, ... on a 15-column grid. */
export function wyFeatures(n: number): FixtureFeature[] {
  return Array.from({ length: n }, (_, i) => wyFeature(i + 1, i + 1, wyCell(i % 15, Math.floor(i / 15))));
}
