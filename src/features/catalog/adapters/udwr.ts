/**
 * Utah Division of Wildlife Resources general-season buck deer hunt units,
 * the "2026 Mule Deer General Season" hosted feature layer published by the
 * DWR's own ArcGIS Online account (owner `dwrdata`, item
 * e08bbe6e3a2d4144914bc59a15ac7d15, marked authoritative)
 * (docs/data-sources.md entry 7b). Added purely through the adapter kit
 * (REL-10): this file, one registry line and the host allowlist.
 *
 * Observed 2026-10-14: layer 0, polygons in EPSG:3857, maxRecordCount 2000,
 * pagination supported, JSON/geoJSON/PBF, editingInfo.dataLastEditDate
 * 2026-04-02, 31 features, one per unit. Fields: boundary_name (the unit
 * name hunters use, e.g. "Cache", "Pine Valley"), description (the
 * guidebook boundary text), hunt_type ("General Season"), species ("Deer"),
 * season ("Fall 2026"). No unit number field exists, so the name is the code.
 * The item's licenseInfo is a disclaimer ("For reference only", provided
 * "as is", no warranty, no liability); it grants and forbids nothing, so
 * download and redistribution stay "unknown".
 *
 * Only the general-season deer set. Utah's limited-entry deer, elk (general
 * any-bull, spike-only, limited-entry), pronghorn, once-in-a-lifetime and
 * antlerless boundaries are separate layers and are not included; units
 * that are limited-entry only (e.g. Paunsaugunt, Henry Mtns) are gaps here.
 *
 * The service name carries the year: DWR published a new service per
 * season (2025 → 2026), so the URL must be updated when the next season's
 * layer appears. `season` is shown with each result so a stale year is
 * visible rather than silent.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const UDWR_LAYER_URL =
  "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/2026MuleDeerGeneralSeason2/FeatureServer/0";

export const UDWR_INFO: ProviderInfo = {
  id: "udwr-deer-general",
  title: "Utah DWR general-season deer hunt units",
  category: "hunt-units",
  jurisdictionIds: ["us-ut"],
  // Layer extent (EPSG:3857) converted to degrees (-114.053, 37.000, -109.042,
  // 42.002), rounded outward.
  coverage: [{ west: -114.1, south: 36.9, east: -109.0, north: 42.1 }],
  attribution: "Utah Division of Wildlife Resources",
  sourceUrl: "https://wildlife.utah.gov/hunting/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat:
    "General-season buck deer boundaries only, for reference. Check the Utah Big Game Guidebook boundary descriptions; other species and limited-entry hunts use other boundaries.",
};

export function mapUdwrAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = cleanText(attrs.boundary_name).replace(/\s+/g, " ");
  if (!code) return null;
  const huntType = cleanText(attrs.hunt_type);
  const season = cleanText(attrs.season);
  const species = cleanText(attrs.species);
  const context = [huntType, season].filter(Boolean).join(" · ");
  return {
    code,
    regionName: "",
    speciesTags: species ? [species] : [],
    seasonContext: context || null,
    landNote: "",
    forest: "",
    // SHAPE__Area is planar Web Mercator area (inflated ~1.7x at Utah's
    // latitude), not a true area, so no square miles are claimed.
    sqMiles: null,
  };
}

/**
 * Simplification matches IDFG/MTFWP (4 decimals ≈ 11 m; 0.002° ≈ 220 m N-S,
 * ≈ 170 m E-W at 40°N): units of similar size (hundreds to thousands of
 * square miles), display-only copy while identify stays on the
 * authoritative point query.
 */
export const UDWR_SOURCE: ArcgisUnitSource = {
  info: UDWR_INFO,
  jurisdictionId: "us-ut",
  layerUrl: UDWR_LAYER_URL,
  where: "1=1",
  objectIdField: "OBJECTID",
  codeField: "boundary_name",
  outFields: ["boundary_name", "hunt_type", "species", "season"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapUdwrAttributes,
  labelPrefix: "Deer unit",
};

export function createUdwrAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(UDWR_SOURCE, options);
}

export const udwrUnitAdapter = createUdwrAdapter();
