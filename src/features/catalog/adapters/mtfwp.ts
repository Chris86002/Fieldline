/**
 * Montana Fish, Wildlife & Parks deer/elk/lion hunting districts, the
 * huntingDistricts MapServer layer 11 "Deer Elk Lion Hunting Districts".
 * Added purely through the adapter kit (REL-10): this file, one registry
 * line and the host allowlist; no app-shell change.
 *
 * Observed 2026-10-14: service copyrightText "Montana Fish, Wildlife & Parks",
 * maxRecordCount 2000, pagination supported, query formats JSON/geoJSON/PBF,
 * no editingInfo (so no source version: every refresh re-downloads), 139
 * features. Neither the service iteminfo (licenseInfo empty) nor the layer
 * metadata states a license or use constraint, so download and
 * redistribution stay "unknown".
 *
 * Only the deer/elk/lion district set: Montana's other species' districts
 * (antelope, moose, sheep, goat, bear, upland birds...) are separate layers
 * and are not included.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanNumber, cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const MTFWP_LAYER_URL = "https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer/11";

export const MTFWP_INFO: ProviderInfo = {
  id: "mtfwp-deer-elk-lion",
  title: "Montana FWP deer, elk and lion hunting districts",
  category: "hunt-units",
  jurisdictionIds: ["us-mt"],
  // Layer extent (EPSG:3857) converted to degrees (-116.050, 44.358, -104.040,
  // 49.001), rounded outward.
  coverage: [{ west: -116.1, south: 44.3, east: -104.0, north: 49.1 }],
  attribution: "Montana Fish, Wildlife & Parks",
  sourceUrl: "https://fwp.mt.gov/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat: "Reference boundaries. Check current Montana regulations and district descriptions.",
};

/** String fields may arrive as numbers from some servers; keep the text either way. */
function fieldText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return cleanText(value);
}

export function mapMtfwpAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = fieldText(attrs.DISTRICT);
  if (!code) return null;
  const region = fieldText(attrs.REG);
  const year = fieldText(attrs.REGYEAR);
  const area = cleanNumber(attrs.AREA_MI);
  return {
    code,
    regionName: region ? `Region ${region}` : "",
    // The layer is defined as the deer-elk-lion district set.
    speciesTags: ["Deer", "Elk", "Mountain lion"],
    seasonContext: year ? `Regulation year ${year}` : null,
    landNote: "",
    forest: "",
    // A district has positive area; a missing or zero AREA_MI is unknown, not 0.
    sqMiles: area !== null && area > 0 ? area : null,
  };
}

/**
 * Simplification matches IDFG (4 decimals ≈ 11 m; 0.002° ≈ 220 m N-S and
 * ≈ 150 m E-W at 45°N): same latitude band, districts of similar size
 * (hundreds to thousands of square miles), display-only copy while identify
 * stays on the authoritative point query.
 */
export const MTFWP_SOURCE: ArcgisUnitSource = {
  info: MTFWP_INFO,
  jurisdictionId: "us-mt",
  layerUrl: MTFWP_LAYER_URL,
  where: "1=1",
  objectIdField: "OBJECTID",
  codeField: "DISTRICT",
  outFields: ["DISTRICT", "REG", "REGYEAR", "AREA_MI"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapMtfwpAttributes,
  labelPrefix: "Hunting District",
};

export function createMtfwpAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(MTFWP_SOURCE, options);
}

export const mtfwpUnitAdapter = createMtfwpAdapter();
