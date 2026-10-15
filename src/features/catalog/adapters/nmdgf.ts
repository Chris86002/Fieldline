/**
 * New Mexico big-game Game Management Units, the "NM Game Management Units"
 * hosted feature layer published by the agency's own ArcGIS Online
 * organization (org `nmdgf`, "New Mexico Department of Game and Fish"; the
 * department now calls itself the New Mexico Department of Wildlife, NMDOW).
 * Item 192f3a7b478f4cee83741d7f5b5c7379, owner keary.howley@dgf.nm.gov_nmdgf,
 * public, marked authoritative; it is the layer the agency's own "Game
 * Management Units" web map shows (docs/data-sources.md entry 7e). Added
 * purely through the adapter kit (REL-10): this file, one registry line and
 * the host allowlist.
 *
 * Observed 2026-10-14: layer 0, polygons in EPSG:3857, maxRecordCount 2000,
 * pagination supported, JSON/geoJSON/PBF, editingInfo.dataLastEditDate
 * 2026-09-25, 70 features with 70 distinct GMU codes, sub-units lettered
 * ("2A", "16D", "55B"). The item description says the units follow 19.30.4
 * NMAC and serve deer, elk, pronghorn, bighorn and Barbary sheep, turkey,
 * bear, cougar, ibex, oryx and javelina. Fields used: GMU (string code),
 * SQMI (true area: it is about 1/1.5 of the Web Mercator Shape__Area at New
 * Mexico's latitudes), BearZone, Cougar_Zone, and Maps (the agency's list of
 * BLM and Forest Service map sheets, from which national forest names are
 * taken). GMU_Desc (the rule text), GMU_PDF and the licensing links are not
 * shown. The item licenseInfo says NMDOW provides the data "as a courtesy
 * for general location purposes only" with no warranty; it grants and
 * forbids nothing, so download and redistribution stay "unknown".
 *
 * Not included: layer 1 of the same service ("Game_Management_Units_Subunits",
 * one polygon named "Portion of GMU 10"), elk management zones and the
 * Commission's designated areas, which are separate services.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanNumber, cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const NMDGF_LAYER_URL =
  "https://services2.arcgis.com/CjbW1bVhK4dB3WOa/arcgis/rest/services/NMDGF_Game_Management_Units_I_E__v2_WFL1/FeatureServer/0";

export const NMDGF_INFO: ProviderInfo = {
  id: "nmdgf-gmu",
  title: "New Mexico Department of Wildlife GMUs",
  category: "hunt-units",
  jurisdictionIds: ["us-nm"],
  // Data extent (returnExtentOnly, outSR 4326): -109.050, 31.332, -103.002,
  // 37.000, rounded outward.
  coverage: [{ west: -109.1, south: 31.3, east: -103.0, north: 37.1 }],
  attribution: "New Mexico Department of Wildlife",
  sourceUrl: "https://wildlife.dgf.nm.gov/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat:
    "Reference boundaries for general location only, not the legal description (19.30.4 NMAC). Check the current New Mexico hunting rules and GMU descriptions.",
};

/**
 * GMU code as hunters write it: a number with an optional sub-unit letter
 * ("2A", "16D"). Case, spaces, a hyphen and leading zeros are tidied
 * ("16 d", "16-D", "02A"); anything else (null, "", "N/A", free text) is not
 * a GMU code.
 */
export function nmGmuCode(value: unknown): string {
  const text = typeof value === "number" ? String(value) : cleanText(value);
  const match = /^0*(\d{1,3})\s*-?\s*([A-Za-z]?)$/.exec(text);
  if (!match || Number(match[1]) === 0) return "";
  return `${Number(match[1])}${match[2].toUpperCase()}`;
}

/**
 * Bear and cougar zone labels. BearZone "0" (and blank) appears on units
 * the source gives no bear zone; the source does not define "0", so it is
 * left out rather than shown as "zone 0".
 */
function zones(attrs: Record<string, unknown>): string | null {
  const text = (value: unknown) => (typeof value === "number" ? String(value) : cleanText(value));
  const bear = text(attrs.BearZone);
  const cougar = text(attrs.Cougar_Zone);
  const parts = [bear && bear !== "0" ? `Bear zone ${bear}` : "", cougar && cougar !== "0" ? `Cougar zone ${cougar}` : ""];
  const joined = parts.filter(Boolean).join(" · ");
  return joined || null;
}

/** "Gila National Forest" names in the Maps text, in order, without repeats. */
export function nationalForests(maps: unknown): string {
  const found: string[] = [];
  for (const match of cleanText(maps).matchAll(/\b([A-Z][A-Za-z'-]*(?: [A-Z][A-Za-z'-]*)*) National Forest\b/g)) {
    const name = `${match[1]} National Forest`;
    if (!found.includes(name)) found.push(name);
  }
  return found.join(", ");
}

export function mapNmdgfAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = nmGmuCode(attrs.GMU);
  if (!code) return null;
  const area = cleanNumber(attrs.SQMI);
  return {
    code,
    // The layer carries no region; the Department's areas are not in it.
    regionName: "",
    // The layer does not say which species may be hunted in a unit.
    speciesTags: [],
    seasonContext: zones(attrs),
    landNote: "",
    forest: nationalForests(attrs.Maps),
    // A GMU has positive area; a missing or zero SQMI is unknown, not 0.
    sqMiles: area !== null && area > 0 ? area : null,
  };
}

/**
 * Simplification matches the other adapters (4 decimals ≈ 11 m; 0.002° ≈
 * 220 m N-S and ≈ 180 m E-W at 34°N). The smallest GMU (6B) is about 139
 * square miles, so outlines stay recognisable; identify stays on the
 * authoritative point query. Live download ≈ 170 KB of GeoJSON in one page.
 */
export const NMDGF_SOURCE: ArcgisUnitSource = {
  info: NMDGF_INFO,
  jurisdictionId: "us-nm",
  layerUrl: NMDGF_LAYER_URL,
  where: "1=1",
  objectIdField: "OBJECTID",
  codeField: "GMU",
  outFields: ["GMU", "SQMI", "BearZone", "Cougar_Zone", "Maps"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapNmdgfAttributes,
  labelPrefix: "GMU",
};

export function createNmdgfAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(NMDGF_SOURCE, options);
}

export const nmdgfUnitAdapter = createNmdgfAdapter();
