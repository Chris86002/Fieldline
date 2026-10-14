import type { LandHit, LandRecord, LandTone } from "@/lib/hunt/types";

type AgencyMeta = { label: string; swatch: string; tone: LandTone };

const AGENCIES: Record<string, AgencyMeta> = {
  BLM: { label: "Bureau of Land Management", swatch: "#f8e078", tone: "public" },
  USFS: { label: "US Forest Service", swatch: "#c8e8c0", tone: "public" },
  NPS: { label: "National Park Service", swatch: "#c8b8d8", tone: "park" },
  USFW: { label: "US Fish & Wildlife", swatch: "#9fd0c8", tone: "refuge" },
  FWS: { label: "US Fish & Wildlife", swatch: "#9fd0c8", tone: "refuge" },
  USBR: { label: "Bureau of Reclamation", swatch: "#9ec4d8", tone: "public" },
  BOR: { label: "Bureau of Reclamation", swatch: "#9ec4d8", tone: "public" },
  DOD: { label: "Department of Defense", swatch: "#f8b0c8", tone: "restricted" },
  BIA: { label: "Bureau of Indian Affairs", swatch: "#f8b068", tone: "tribal" },
  STATE: { label: "State land", swatch: "#b0e0e8", tone: "state" },
  STAT: { label: "State land", swatch: "#b0e0e8", tone: "state" },
  ST: { label: "State land", swatch: "#b0e0e8", tone: "state" },
  LOCAL: { label: "Local government", swatch: "#d8d4c8", tone: "public" },
  LOC: { label: "Local government", swatch: "#d8d4c8", tone: "public" },
  OTHF: { label: "Other federal", swatch: "#d0d0c8", tone: "public" },
};

export const LEGEND: { label: string; swatch: string }[] = [
  { label: "BLM", swatch: "#f8e078" },
  { label: "Forest Service", swatch: "#c8e8c0" },
  { label: "Park Service", swatch: "#c8b8d8" },
  { label: "Fish & Wildlife", swatch: "#9fd0c8" },
  { label: "State", swatch: "#b0e0e8" },
  { label: "Tribal", swatch: "#f8b068" },
  { label: "Defense", swatch: "#f8b0c8" },
];

function noteFor(tone: LandTone, state: string | null): string {
  if (tone === "park") return "National Park land. Hunting is prohibited in most parks.";
  if (tone === "refuge") return "Wildlife refuge. Hunt only where that refuge allows it.";
  if (tone === "restricted") return "Military land. Stay out unless the range is open.";
  if (tone === "tribal") return "Tribal land, not public. Access follows tribal rules only.";
  if (tone === "state") {
    return state === "AZ"
      ? "Arizona State Trust land needs a recreation permit."
      : "State land. Permits and rules change by state.";
  }
  if (tone === "private") return "Private surface in the BLM record. Get permission before you cross.";
  if (tone === "unknown") {
    return "This agency code isn't one Fieldline recognizes, so access is unknown. Check with the managing agency.";
  }
  return "Public surface. Seasons, weapons, and closures still apply.";
}

const NO_RECORD_NOTE =
  "No surface-management record here. Ownership is unknown: it may be private, or the data may be incomplete. Verify with the county or agency before you enter.";

export const LAND_SOURCE = "BLM National Surface Management Agency";

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

export type RawHit = {
  layerName?: string;
  attributes?: Record<string, string>;
};

/** Codes that mean the source has no usable agency, not that the ground is private. */
const NO_AGENCY = new Set(["UND", "UNK", "UNKNOWN", "NULL"]);

function toRecord(raw: RawHit): (LandRecord & { area: number }) | null {
  const attrs = raw.attributes ?? {};
  const code = (clean(attrs.ADMIN_AGENCY_CODE) ?? "").toUpperCase();
  if (!code || NO_AGENCY.has(code)) return null;
  const meta: AgencyMeta | { label: string; swatch: string | null; tone: LandTone } =
    code === "PVT"
      ? { label: "Private", swatch: null, tone: "private" }
      : (AGENCIES[code] ?? { label: clean(raw.layerName) ?? code, swatch: "#d0d0c8", tone: "unknown" });
  const area = Number(attrs.Shape_Area);
  return {
    agency: code,
    label: meta.label,
    swatch: meta.swatch,
    tone: meta.tone,
    state: clean(attrs.ADMIN_ST),
    unit: clean(attrs.ADMIN_UNIT_NAME),
    area: Number.isFinite(area) ? area : Number.POSITIVE_INFINITY,
  };
}

/**
 * Turns a successful identify response into a land answer. An empty response
 * is "no record" (ownership unknown). Overlapping records are all kept; the
 * smallest polygon leads because it is usually the most specific, and the rest
 * stay visible in `others` rather than being dropped.
 */
export function landFromResults(results: RawHit[], checkedAt: number): LandHit {
  const records = results
    .map(toRecord)
    .filter((record): record is LandRecord & { area: number } => record !== null)
    .sort((a, b) => a.area - b.area);
  const unique: LandRecord[] = [];
  for (const { area: _area, ...record } of records) {
    if (!unique.some((item) => item.agency === record.agency && item.unit === record.unit)) unique.push(record);
  }
  const [primary, ...others] = unique;
  if (!primary) {
    return {
      agency: "",
      label: "Ownership unknown",
      swatch: null,
      tone: "unknown",
      state: null,
      unit: null,
      status: "no-record",
      note: NO_RECORD_NOTE,
      others: [],
      source: LAND_SOURCE,
      checkedAt,
    };
  }
  return {
    ...primary,
    status: "record",
    note: noteFor(primary.tone, primary.state),
    others,
    source: LAND_SOURCE,
    checkedAt,
  };
}

/** Short tag for compact readouts, e.g. the coordinate bar. */
export function landTag(hit: LandHit): string {
  if (hit.status === "no-record") return "Owner unknown";
  if (hit.tone === "private") return "Private";
  if (hit.tone === "unknown") return `${hit.agency} (unrecognized)`;
  return hit.agency;
}

export async function identifyLand(lng: number, lat: number, signal?: AbortSignal): Promise<LandHit> {
  const pad = 0.008;
  const layers = lat > 51 ? "all:4,5,6,7,8,9,10,11,12,13,14,15" : "all:6,7,8,9,10,11,12,13,14,15";
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers,
    tolerance: "2",
    mapExtent: `${lng - pad},${lat - pad},${lng + pad},${lat + pad}`,
    imageDisplay: "400,400,96",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(
    `https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/identify?${params}`,
    { signal },
  );
  if (!res.ok) throw new Error("Land service unavailable");
  const body = (await res.json()) as { results?: unknown; error?: unknown };
  // ArcGIS reports some failures as HTTP 200 with an error body; that is an outage, not empty ground.
  if (body.error || !Array.isArray(body.results)) throw new Error("Land service unavailable");
  return landFromResults(body.results as RawHit[], Date.now());
}
