/**
 * TEST FIXTURES ONLY. Synthetic data shaped like the New Mexico "NM Game
 * Management Units" hosted feature layer responses observed 2026-10-14
 * (field list, OBJECTID object id, string GMU codes with sub-unit letters,
 * editingInfo with an edit date, paged `f=geojson`, point query `f=json`).
 * Codes, zones, areas, map text and boundaries are invented ("FIXTURE"
 * forests, zone "ZZ"); never treat them as provider data.
 */
import { layerMetadata, squareRing, type FixtureFeature } from "./arcgis-fixtures.ts";

/** Field list of the live layer (OBJECTID is the esriFieldTypeOID field). */
export const NM_FIELD_NAMES = [
  "GMU",
  "Maps",
  "OBJECTID",
  "ACRES",
  "HECTARES",
  "SQMI",
  "HUNT_INFO",
  "GMU_PDF",
  "Shape__Area",
  "Shape__Length",
  "GlobalID",
  "BearZone",
  "Cougar_Zone",
  "Licensing",
  "GMU_Desc",
];

/** FIXTURE edit date (the live layer publishes editingInfo). */
export const NM_EDIT = Date.UTC(2099, 8, 25);

export function nmLayerMetadata(maxRecordCount = 2000, editDate: number | null = NM_EDIT): Record<string, unknown> {
  return layerMetadata({ fields: NM_FIELD_NAMES, maxRecordCount, editDate });
}

/** Corner of grid cell (col, row) inside New Mexico (10 columns × 8 rows fit). */
export function nmCell(col: number, row: number): [number, number] {
  return [-108.5 + col * 0.3, 32.5 + row * 0.3];
}

export function nmFeature(
  oid: number,
  code: string | number | null,
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
      GMU: code,
      SQMI: 400 + oid,
      BearZone: "99",
      Cougar_Zone: "ZZ",
      Maps: "BLM Maps: Fixture Quad.\nUS Forest Service Maps: Fixture National Forest.",
      ...overrides,
    },
  };
}

/** FIXTURE codes in the live layer's shape: numbers, some split into lettered sub-units. */
export function nmCodes(n: number): string[] {
  const codes: string[] = [];
  for (let unit = 1; codes.length < n; unit++) {
    if (unit % 4 === 2) for (const letter of ["A", "B", "C"]) codes.push(`${unit}${letter}`);
    else codes.push(String(unit));
  }
  return codes.slice(0, n);
}

/** n features with FIXTURE codes from `nmCodes` on a 10-column grid. */
export function nmFeatures(n: number): FixtureFeature[] {
  return nmCodes(n).map((code, i) => nmFeature(i + 1, code, nmCell(i % 10, Math.floor(i / 10))));
}
