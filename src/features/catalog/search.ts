/**
 * Nationwide hunt-unit search. Unit codes repeat across states ("22" exists
 * in Arizona and Idaho), so every result carries a jurisdiction label, and a
 * jurisdiction named in the query or the filter ranks first instead of hiding
 * the others.
 */
import type { HuntUnit, JurisdictionId, LngLat } from "@/features/catalog/types";
import { haversine } from "../../lib/hunt/format.ts";
import { JURISDICTIONS } from "./coverage-data.ts";

export type UnitSearchOptions = {
  /** Rank this jurisdiction's units first. A jurisdiction named in the query wins over it. */
  jurisdictionId?: JurisdictionId;
  /** Rank nearer units (by label point, great-circle distance) first. */
  near?: LngLat;
};

export type UnitSearchResult = {
  unit: HuntUnit;
  /** Disambiguated label, e.g. "Unit 22 · Arizona". */
  label: string;
  jurisdictionName: string;
  /** True when the unit is in the jurisdiction the query or filter asked for. */
  jurisdictionMatch: boolean;
  /** Meters from `near` to the unit's label point, or null without `near`. */
  distanceMeters: number | null;
};

/** Words people put around a unit code: "unit 22", "GMU 22", "game management unit 22", "HD 204", "hunting district 204". */
const UNIT_WORDS = new Set(["unit", "units", "gmu", "gmus", "hunt", "hunting", "game", "management", "hd", "district", "districts"]);

const NAME_BY_ID = new Map<JurisdictionId, string>(JURISDICTIONS.map((j) => [j.id, j.name]));

/** "az", "arizona", "new mexico", "district of columbia" -> id. */
const JURISDICTION_BY_WORDS = new Map<string, JurisdictionId>();
for (const j of JURISDICTIONS) {
  JURISDICTION_BY_WORDS.set(j.usps.toLowerCase(), j.id);
  JURISDICTION_BY_WORDS.set(j.name.toLowerCase(), j.id);
}
const MAX_NAME_WORDS = Math.max(...JURISDICTIONS.map((j) => j.name.split(" ").length));

/** Canonical unit code: case-, space- and dash-insensitive, without leading zeros ("06-a" -> "6a"). */
export function normalizeUnitCode(code: string): string {
  return code
    .toLowerCase()
    .replace(/[\s\-_.]+/g, "")
    .replace(/^0+(?=\d)/, "");
}

type ParsedQuery = { code: string; jurisdictionId: JurisdictionId | null };

/** Takes a jurisdiction name or USPS code off the start or end of the tokens. */
function takeJurisdiction(tokens: string[]): { rest: string[]; id: JurisdictionId | null } {
  for (let n = Math.min(MAX_NAME_WORDS, tokens.length - 1); n >= 1; n--) {
    const head = JURISDICTION_BY_WORDS.get(tokens.slice(0, n).join(" "));
    if (head) return { rest: tokens.slice(n), id: head };
    const tail = JURISDICTION_BY_WORDS.get(tokens.slice(-n).join(" "));
    if (tail) return { rest: tokens.slice(0, -n), id: tail };
  }
  return { rest: tokens, id: null };
}

/** Splits "Arizona unit 6A" into code "6a" and jurisdiction "us-az". */
export function parseUnitQuery(query: string): ParsedQuery {
  const tokens = query
    .toLowerCase()
    .replace(/[·,#:;]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !UNIT_WORDS.has(t));
  const { rest, id } = takeJurisdiction(tokens);
  return { code: normalizeUnitCode(rest.join("")), jurisdictionId: id };
}

function jurisdictionName(id: JurisdictionId): string {
  return NAME_BY_ID.get(id) ?? id.slice(3).toUpperCase();
}

/**
 * Units whose code exactly matches the query's code (so "2" never matches
 * "22"), from every jurisdiction. Accepts "22", "unit 22", "GMU 22", "az 22",
 * "22 az" and "Arizona 22". Ordered by jurisdiction match, then distance to
 * `near` when given, then jurisdiction name, then provider and id.
 */
export function searchUnits(
  units: readonly HuntUnit[],
  query: string,
  opts: UnitSearchOptions = {},
): UnitSearchResult[] {
  const parsed = parseUnitQuery(query);
  if (!parsed.code) return [];
  const wanted = parsed.jurisdictionId ?? opts.jurisdictionId ?? null;
  const near =
    opts.near && Number.isFinite(opts.near.lng) && Number.isFinite(opts.near.lat) ? opts.near : null;

  const results: UnitSearchResult[] = [];
  for (const unit of units) {
    if (normalizeUnitCode(unit.code) !== parsed.code) continue;
    const name = jurisdictionName(unit.jurisdictionId);
    const base = unit.label.trim() || `Unit ${unit.code}`;
    results.push({
      unit,
      label: `${base} · ${name}`,
      jurisdictionName: name,
      jurisdictionMatch: wanted !== null && unit.jurisdictionId === wanted,
      distanceMeters: near ? haversine(near, unit.labelPoint) : null,
    });
  }

  return results.sort(
    (a, b) =>
      Number(b.jurisdictionMatch) - Number(a.jurisdictionMatch) ||
      (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) ||
      a.jurisdictionName.localeCompare(b.jurisdictionName) ||
      a.unit.providerId.localeCompare(b.unit.providerId) ||
      a.unit.id.localeCompare(b.unit.id),
  );
}
