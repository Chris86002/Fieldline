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

/** Words people put around a unit code: "unit 22", "GMU 22", "game management unit 22", "HD 204", "hunting district 204", "hunt area 7". */
const UNIT_WORDS = new Set(["unit", "units", "gmu", "gmus", "hunt", "hunting", "game", "management", "hd", "district", "districts", "area", "areas"]);

/**
 * Species words people add ("elk area 7", "deer unit cache"). Tried as an
 * extra reading with them taken out, never instead of the plain one, so a
 * unit whose name contains one ("Elk Ridge") still matches.
 */
const SPECIES_WORDS = new Map<string, string>([
  ["elk", "elk"],
  ["deer", "deer"],
  ["mule", "deer"],
  ["whitetail", "deer"],
  ["pronghorn", "pronghorn"],
  ["antelope", "pronghorn"],
  ["moose", "moose"],
  ["bear", "bear"],
  ["lion", "lion"],
  ["cougar", "lion"],
  ["sheep", "sheep"],
  ["bighorn", "sheep"],
  ["goat", "goat"],
]);

const NAME_BY_ID = new Map<JurisdictionId, string>(JURISDICTIONS.map((j) => [j.id, j.name]));

/** "az", "arizona", "new mexico", "district of columbia" -> id. */
const JURISDICTION_BY_WORDS = new Map<string, JurisdictionId>();
for (const j of JURISDICTIONS) {
  JURISDICTION_BY_WORDS.set(j.usps.toLowerCase(), j.id);
  JURISDICTION_BY_WORDS.set(j.name.toLowerCase(), j.id);
}
const MAX_NAME_WORDS = Math.max(...JURISDICTIONS.map((j) => j.name.split(" ").length));

/**
 * Canonical unit code: case-, space- and punctuation-insensitive, without
 * leading zeros ("06-a" -> "6a", "Beaver, East" -> "beavereast"). Strips the
 * same punctuation the query parser treats as a separator.
 */
export function normalizeUnitCode(code: string): string {
  return code
    .toLowerCase()
    .replace(/[\s\-_.·,#:;/]+/g, "")
    .replace(/^0+(?=\d)/, "");
}

type ParsedQuery = {
  code: string;
  jurisdictionId: JurisdictionId | null;
  /** The code with nothing taken off as a jurisdiction ("la sal mtns": "la" is also Louisiana). */
  wholeCode: string;
  /** The code without species words ("elk area 7" -> "7"), or "" when the query had none. */
  speciesFreeCode: string;
  /** Species the query named ("elk"), normalized; empty when none. */
  species: string[];
};

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
  const species = [...new Set(rest.flatMap((t) => (SPECIES_WORDS.has(t) ? [SPECIES_WORDS.get(t)!] : [])))];
  const withoutSpecies = rest.filter((t) => !SPECIES_WORDS.has(t));
  return {
    code: normalizeUnitCode(rest.join("")),
    jurisdictionId: id,
    wholeCode: normalizeUnitCode(tokens.join("")),
    speciesFreeCode: species.length && withoutSpecies.length ? normalizeUnitCode(withoutSpecies.join("")) : "",
    species,
  };
}

function jurisdictionName(id: JurisdictionId): string {
  return NAME_BY_ID.get(id) ?? id.slice(3).toUpperCase();
}

/**
 * Units whose code exactly matches the query's code (so "2" never matches
 * "22"), from every jurisdiction. Accepts "22", "unit 22", "GMU 22", "az 22",
 * "22 az", "Arizona 22", and with a species word ("elk area 7", "deer unit
 * cache"). Ordered by jurisdiction match, then units tagged with a species the
 * query named, then distance to `near` when given, then jurisdiction name,
 * then provider and id.
 */
export function searchUnits(
  units: readonly HuntUnit[],
  query: string,
  opts: UnitSearchOptions = {},
): UnitSearchResult[] {
  const parsed = parseUnitQuery(query);
  // A leading or trailing word that is also a state code ("la" in "La Sal
  // Mtns", "mt" in "Mt Dutton") may be part of the unit's name, so the whole
  // query is also tried as a name; the state reading ranks first.
  const whole = parsed.jurisdictionId !== null && parsed.wholeCode !== parsed.code ? parsed.wholeCode : null;
  const speciesFree = parsed.speciesFreeCode || null;
  if (!parsed.code && !whole && !speciesFree) return [];
  const wanted = parsed.jurisdictionId ?? opts.jurisdictionId ?? null;
  const near =
    opts.near && Number.isFinite(opts.near.lng) && Number.isFinite(opts.near.lat) ? opts.near : null;

  const results: UnitSearchResult[] = [];
  /** Units whose species tags include a species the query named rank next after a state match. */
  const speciesMatch = new Set<HuntUnit>();
  for (const unit of units) {
    const code = normalizeUnitCode(unit.code);
    const byState = parsed.code !== "" && (code === parsed.code || code === speciesFree);
    if (!byState && code !== whole) continue;
    if (parsed.species.length && unit.speciesTags.some((tag) => parsed.species.includes(SPECIES_WORDS.get(tag.toLowerCase()) ?? tag.toLowerCase()))) {
      speciesMatch.add(unit);
    }
    const name = jurisdictionName(unit.jurisdictionId);
    const base = unit.label.trim() || `Unit ${unit.code}`;
    // A whole-query match didn't use the state word, so it isn't a state match
    // (unless the filter names that state).
    const target = byState ? wanted : (opts.jurisdictionId ?? null);
    results.push({
      unit,
      label: `${base} · ${name}`,
      jurisdictionName: name,
      jurisdictionMatch: target !== null && unit.jurisdictionId === target,
      distanceMeters: near ? haversine(near, unit.labelPoint) : null,
    });
  }

  return results.sort(
    (a, b) =>
      Number(b.jurisdictionMatch) - Number(a.jurisdictionMatch) ||
      Number(speciesMatch.has(b.unit)) - Number(speciesMatch.has(a.unit)) ||
      (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) ||
      a.jurisdictionName.localeCompare(b.jurisdictionName) ||
      a.unit.providerId.localeCompare(b.unit.providerId) ||
      a.unit.id.localeCompare(b.unit.id),
  );
}
