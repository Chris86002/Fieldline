/**
 * Idaho Fish and Game game management units, Hunting MapServer layer 3
 * (docs/data-sources.md entry 7). CC BY Idaho Fish and Game. Reference
 * lines, not the legal boundary.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const IDFG_LAYER_URL = "https://gisportal-idfg.idaho.gov/hosting/rest/services/Hunting/MapServer/3";

export const IDFG_INFO: ProviderInfo = {
  id: "idfg-gmu",
  title: "Idaho Fish and Game hunt units",
  category: "hunt-units",
  jurisdictionIds: ["us-id"],
  // Layer extent (EPSG:3857) converted to degrees, rounded outward.
  coverage: [{ west: -117.3, south: 41.9, east: -110.9, north: 49.1 }],
  attribution: "Idaho Fish and Game (CC BY)",
  sourceUrl: "https://idfg.idaho.gov/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: true, redistribution: true },
  caveat: "Reference lines, not the legal boundary.",
};

export function mapIdfgAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = cleanText(attrs.NAME);
  if (!code || code.toUpperCase() === "N/A") return null;
  const elkZone = cleanText(attrs.Elk_Zone);
  return {
    code,
    regionName: "",
    speciesTags: [],
    seasonContext: elkZone ? `Elk zone: ${elkZone}` : null,
    landNote: "",
    forest: "",
    sqMiles: null,
  };
}

export const IDFG_SOURCE: ArcgisUnitSource = {
  info: IDFG_INFO,
  jurisdictionId: "us-id",
  layerUrl: IDFG_LAYER_URL,
  where: "1=1",
  objectIdField: "OBJECTID_1",
  codeField: "NAME",
  outFields: ["NAME", "Elk_Zone"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapIdfgAttributes,
};

export function createIdfgAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(IDFG_SOURCE, options);
}

export const idfgUnitAdapter = createIdfgAdapter();
