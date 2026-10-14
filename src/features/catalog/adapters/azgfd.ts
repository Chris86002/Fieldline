/**
 * Arizona Game and Fish Department game management units
 * (docs/data-sources.md entry 6). Reference geometry only: the legal unit
 * descriptions are in Commission Rule R12-4-108.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanNumber, cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const AZGFD_LAYER_URL =
  "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0";

export const AZGFD_INFO: ProviderInfo = {
  id: "azgfd-gmu",
  title: "Arizona Game and Fish hunt units",
  category: "hunt-units",
  jurisdictionIds: ["us-az"],
  // Layer extent (EPSG:3857) converted to degrees, rounded outward.
  coverage: [{ west: -115.2, south: 31.2, east: -108.9, north: 37.1 }],
  attribution: "GIS Program, Habitat Branch, Wildlife Management Division, Arizona Game and Fish Department",
  sourceUrl: "https://www.azgfd.com/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat: "Reference geometry, not the legal description in Commission Rule R12-4-108.",
};

export function mapAzgfdAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = cleanText(attrs.GMU);
  if (!code || code.toUpperCase() === "N/A") return null;
  return {
    code,
    regionName: cleanText(attrs.REG_NAME),
    speciesTags: cleanText(attrs.HUNT)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    seasonContext: null,
    landNote: cleanText(attrs.LANDOWN),
    forest: cleanText(attrs.USFSName),
    sqMiles: cleanNumber(attrs.SQ_MILES),
  };
}

export const AZGFD_SOURCE: ArcgisUnitSource = {
  info: AZGFD_INFO,
  jurisdictionId: "us-az",
  layerUrl: AZGFD_LAYER_URL,
  where: "GMU NOT IN ('N/A',' ')",
  objectIdField: "OBJECTID",
  codeField: "GMU",
  outFields: ["GMU", "REG_NAME", "SQ_MILES", "LANDOWN", "HUNT", "USFSName"],
  geometryPrecision: 5,
  maxAllowableOffset: 0.0001,
  mapAttributes: mapAzgfdAttributes,
};

export function createAzgfdAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(AZGFD_SOURCE, options);
}

export const azgfdUnitAdapter = createAzgfdAdapter();
