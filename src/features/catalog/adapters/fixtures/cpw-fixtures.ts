/**
 * TEST FIXTURES ONLY. Synthetic data shaped like the Colorado Parks and
 * Wildlife CPWAdminData FeatureServer layer 6 responses observed 2026-10-14
 * (field list, FID object id, integer GMUID, editingInfo with an edit date,
 * paged `f=geojson` with `properties.exceededTransferLimit`). GMU codes,
 * herd-unit codes, areas and boundaries are invented; never treat them as
 * provider data.
 */
import { layerMetadata, squareRing, type FixtureFeature } from "./arcgis-fixtures.ts";

/** Field list of the live layer (FID is the esriFieldTypeOID field). */
export const CO_FIELD_NAMES = [
  "FID",
  "GMUID",
  "COUNTY",
  "DEERDAU",
  "ELKDAU",
  "ANTDAU",
  "MOOSEDAU",
  "BEARDAU",
  "LIONDAU",
  "INPUT_DATE",
  "EDIT_DATE",
  "AcresGISCa",
  "SqMilesGIS",
  "Shape__Area",
  "Shape__Length",
  "GlobalID",
];

/** FIXTURE edit date (the live layer publishes editingInfo). */
export const CO_EDIT = Date.UTC(2099, 7, 27);

export function coLayerMetadata(maxRecordCount = 2000, editDate: number | null = CO_EDIT): Record<string, unknown> {
  return layerMetadata({ fields: CO_FIELD_NAMES, maxRecordCount, editDate });
}

/** Corner of grid cell (col, row) inside Colorado (20 columns × 10 rows fit). */
export function coCell(col: number, row: number): [number, number] {
  return [-108.5 + col * 0.3, 37.2 + row * 0.3];
}

export function coFeature(
  oid: number,
  code: number | string | null,
  corner: [number, number],
  overrides: Record<string, unknown> = {},
  geometry?: unknown,
): FixtureFeature {
  return {
    type: "Feature",
    id: oid,
    geometry: geometry ?? { type: "Polygon", coordinates: [squareRing(corner[0], corner[1], 0.25)] },
    properties: {
      FID: oid,
      GMUID: code,
      COUNTY: "FIXTURE COUNTY",
      DEERDAU: "D-90",
      ELKDAU: "E-91",
      ANTDAU: "A-99",
      MOOSEDAU: "M-99",
      BEARDAU: "B-92",
      LIONDAU: "L-ZZ",
      SqMilesGIS: 300 + oid,
      ...overrides,
    },
  };
}

/** n features with FIXTURE codes 500, 501, ... on a 20-column grid. */
export function coFeatures(n: number): FixtureFeature[] {
  return Array.from({ length: n }, (_, i) => coFeature(i + 1, 500 + i, coCell(i % 20, Math.floor(i / 20))));
}
