/**
 * Colorado Parks and Wildlife big-game Game Management Units, the
 * CPWAdminData FeatureServer layer 6 "CPW GMU Boundary (Big Game)" (ArcGIS
 * Online item 168fccb0583f42f1afe57de6c9ce846d, owned by the CPW
 * organization). Added purely through the adapter kit (REL-10): this file,
 * one registry line and the host allowlist; no app-shell change.
 *
 * Observed 2026-10-14: layer copyrightText "Colorado Parks and Wildlife GIS
 * Group", maxRecordCount 2000, pagination supported, query formats
 * JSON/geoJSON/PBF, editingInfo.dataLastEditDate 2026-08-27 (so the store
 * can skip unchanged refreshes), 186 features with 186 distinct GMUID
 * values, object-ID field FID, native spatial reference 3857. The item's
 * licenseInfo says the data are "product and property of the Colorado Parks
 * and Wildlife" with an as-is, no-warranty disclaimer; it grants no license
 * for download or redistribution, so both stay "unknown".
 *
 * Only the big-game GMU set: bighorn sheep and mountain goat units are
 * separate layers (7 and 8) and are not included. The COUNTY field is free
 * text with misspellings and is not shown.
 */
import type { ProviderInfo } from "../types.ts";
import type { ArcgisAdapterOptions, ArcgisUnitSource, UnitFields } from "./arcgis.ts";
import { cleanNumber, cleanText, createArcgisUnitAdapter } from "./arcgis.ts";

export const CPW_LAYER_URL =
  "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/6";

export const CPW_INFO: ProviderInfo = {
  id: "cpw-gmu",
  title: "Colorado Parks and Wildlife big-game GMUs",
  category: "hunt-units",
  jurisdictionIds: ["us-co"],
  // Data extent (returnExtentOnly, outSR 4326): -109.060, 36.992, -102.042,
  // 41.003, rounded outward.
  coverage: [{ west: -109.1, south: 36.9, east: -102.0, north: 41.1 }],
  attribution: "Colorado Parks and Wildlife",
  sourceUrl: "https://cpw.state.co.us/",
  licenseUrl: null,
  capabilities: { view: true, identify: true, search: true, download: "unknown", redistribution: "unknown" },
  caveat: "Reference boundaries, not the legal description. Check the current Colorado big-game brochure and GMU descriptions.",
};

/**
 * Data Analysis Unit (herd unit) fields, in display order. Codes ending in
 * "-99" (e.g. "E-99") are not numbered herd units and the source does not
 * document them, so they are left out rather than shown as a herd unit.
 */
const DAU_FIELDS: readonly (readonly [field: string, species: string])[] = [
  ["DEERDAU", "deer"],
  ["ELKDAU", "elk"],
  ["ANTDAU", "pronghorn"],
  ["MOOSEDAU", "moose"],
  ["BEARDAU", "bear"],
  ["LIONDAU", "lion"],
];

export const CPW_DAU_FIELD_NAMES = DAU_FIELDS.map(([field]) => field);

function herdUnits(attrs: Record<string, unknown>): string | null {
  const parts = DAU_FIELDS.flatMap(([field, species]) => {
    const code = cleanText(attrs[field]);
    return code && !/-99$/.test(code) ? [`${species} ${code}`] : [];
  });
  return parts.length > 0 ? `Herd units (DAU): ${parts.join(", ")}` : null;
}

/** GMUID is an integer field; a text or non-integer value is not a GMU code. */
function gmuCode(value: unknown): string {
  const text = typeof value === "number" ? String(value) : cleanText(value);
  return /^\d{1,4}$/.test(text) && Number(text) > 0 ? String(Number(text)) : "";
}

export function mapCpwAttributes(attrs: Record<string, unknown>): UnitFields | null {
  const code = gmuCode(attrs.GMUID);
  if (!code) return null;
  const area = cleanNumber(attrs.SqMilesGIS);
  return {
    code,
    // The layer carries no CPW region; regions are a separate layer.
    regionName: "",
    // The layer does not say which species may be hunted in a unit.
    speciesTags: [],
    seasonContext: herdUnits(attrs),
    landNote: "",
    forest: "",
    // A GMU has positive area; a missing or zero SqMilesGIS is unknown, not 0.
    sqMiles: area !== null && area > 0 ? area : null,
  };
}

/**
 * Simplification matches the other adapters (4 decimals ≈ 11 m; 0.002° ≈
 * 220 m N-S and ≈ 175 m E-W at 39°N). The smallest GMU (512) is about 27
 * square miles, so outlines stay recognisable; identify stays on the
 * authoritative point query. Live download ≈ 390 KB of GeoJSON in one page.
 */
export const CPW_SOURCE: ArcgisUnitSource = {
  info: CPW_INFO,
  jurisdictionId: "us-co",
  layerUrl: CPW_LAYER_URL,
  where: "1=1",
  objectIdField: "FID",
  codeField: "GMUID",
  outFields: ["GMUID", ...CPW_DAU_FIELD_NAMES, "SqMilesGIS"],
  geometryPrecision: 4,
  maxAllowableOffset: 0.002,
  mapAttributes: mapCpwAttributes,
  labelPrefix: "GMU",
};

export function createCpwAdapter(options?: ArcgisAdapterOptions) {
  return createArcgisUnitAdapter(CPW_SOURCE, options);
}

export const cpwUnitAdapter = createCpwAdapter();
