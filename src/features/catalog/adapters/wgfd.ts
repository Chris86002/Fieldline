/**
 * Wyoming Game and Fish Department elk hunt areas, the "ElkHuntAreas" hosted
 * feature layer published by the department's own ArcGIS Online account
 * (owner `WyomingGameAndFish@wgfd`, item 1cd21d69c98649f782a8d44380343259)
 * (docs/data-sources.md entry 7d). Added purely through the adapter kit
 * (REL-10): this file, one registry line and the host allowlist.
 *
 * Observed 2026-10-14: layer 0, polygons in EPSG:3857, maxRecordCount 2000,
 * pagination supported, JSON/geoJSON/PBF, editingInfo.dataLastEditDate
 * 2026-03-19, 105 features with 105 distinct HUNTAREA values (1–130, not
 * contiguous). copyrightText "Wyoming Game and Fish Department, State of
 * Wyoming". Fields: HUNTAREA (the area number hunters use), HUNTNAME (the
 * area's name), HERDUNIT / HERDNAME (the elk herd unit; 0 and blank for two
 * areas outside any herd unit), Region (the source says the nonresident
 * regions are made by dissolving on it: Eastern, Southern, Western), SqMiles
 * (true area; it agrees with the latitude-corrected Shape__Area within 1%).
 * The layer description still says "2025 elk hunt area" boundaries although
 * the data were edited in March 2026, so the caveat points to the current
 * regulations.
 *
 * The item licenseInfo is an as-is disclaimer: no warranty, no liability,
 * "should never be used at a scale larger than 1:100,000", and the written
 * boundary descriptions "take precedence in resolving locational disputes".
 * It grants and forbids nothing, so download and redistribution stay
 * "unknown".
 *
 * Only elk. Deer, pronghorn, moose, bighorn sheep, mountain goat, bison,
 * bear, lion, wolf and bird hunt areas are separate WGFD layers and are not
 * included, so a deer or pronghorn hunter must not read these as theirs; the
 * label says "Elk hunt area".
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanNumber, cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const WGFD_LAYER_URL =
  "https://services6.arcgis.com/cWzdqIyxbijuhPLw/arcgis/rest/services/ElkHuntAreas/FeatureServer/0";

export const WGFD_INFO: ProviderInfo = {
  id: "wgfd-elk-areas",
  title: "Wyoming Game and Fish elk hunt areas",
  category: "hunt-units",
  jurisdictionIds: ["us-wy"],
  // Data extent (returnExtentOnly, outSR 4326): -111.050, 40.995, -104.052,
  // 45.007, rounded outward.
  coverage: [{ west: -111.1, south: 40.9, east: -104.0, north: 45.1 }],
  attribution: "Wyoming Game and Fish Department",
  sourceUrl: "https://wgfd.wyo.gov/hunting-trapping",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat:
    "Elk hunt areas only, for reference at 1:100,000 scale, not the legal description. Check the current Wyoming elk regulations' hunt area descriptions; deer, pronghorn and other species use other areas.",
};

/** HUNTAREA and HERDUNIT are double fields holding whole numbers; anything else is not a code. */
function wholeNumber(value: unknown): string {
  const text = typeof value === "number" ? String(value) : cleanText(value);
  return /^\d{1,4}(\.0+)?$/.test(text) && Number(text) > 0 ? String(Number(text)) : "";
}

export function mapWgfdAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = wholeNumber(attrs.HUNTAREA);
  if (!code) return null;
  const name = cleanText(attrs.HUNTNAME).replace(/\s+/g, " ");
  // Areas outside any herd unit carry HERDUNIT 0 and a blank HERDNAME.
  const herdCode = wholeNumber(attrs.HERDUNIT);
  const herdName = cleanText(attrs.HERDNAME).replace(/\s+/g, " ");
  const herd = herdCode ? `Herd unit ${herdCode}${herdName ? ` (${herdName})` : ""}` : "";
  const context = [name ? `Area name: ${name}` : "", herd].filter(Boolean).join(" · ");
  const region = cleanText(attrs.Region);
  const area = cleanNumber(attrs.SqMiles);
  return {
    code,
    regionName: region ? `${region} nonresident region` : "",
    speciesTags: ["Elk"],
    seasonContext: context || null,
    landNote: "",
    forest: "",
    // A hunt area has positive area; a missing or zero SqMiles is unknown, not 0.
    sqMiles: area !== null && area > 0 ? area : null,
  };
}

/**
 * Simplification matches the other adapters (4 decimals ≈ 11 m; 0.002° ≈
 * 220 m N-S and ≈ 160 m E-W at 43°N). The smallest area (88, about 18
 * square miles) keeps a recognisable outline; identify stays on the
 * authoritative point query. All 105 areas fit in one page.
 */
export const WGFD_SOURCE: ArcgisUnitSource = {
  info: WGFD_INFO,
  jurisdictionId: "us-wy",
  layerUrl: WGFD_LAYER_URL,
  where: "1=1",
  objectIdField: "OBJECTID",
  codeField: "HUNTAREA",
  outFields: ["HUNTAREA", "HUNTNAME", "HERDUNIT", "HERDNAME", "Region", "SqMiles"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapWgfdAttributes,
  labelPrefix: "Elk hunt area",
};

export function createWgfdAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(WGFD_SOURCE, options);
}

export const wgfdUnitAdapter = createWgfdAdapter();
