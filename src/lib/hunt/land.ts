import type { LandHit, LandTone } from "@/lib/hunt/types";

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
  if (tone === "private") return "Private surface. Get permission before you cross.";
  if (tone === "unknown") return "No agency polygon here. Treat it as private until you verify.";
  return "Public surface. Seasons, weapons, and closures still apply.";
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

type RawHit = {
  layerName?: string;
  attributes?: Record<string, string>;
};

function toHit(raw: RawHit): (LandHit & { area: number }) | null {
  const attrs = raw.attributes ?? {};
  const code = (clean(attrs.ADMIN_AGENCY_CODE) ?? "").toUpperCase();
  if (!code || code === "PVT") return null;
  const meta = AGENCIES[code] ?? {
    label: clean(raw.layerName) ?? code,
    swatch: "#d0d0c8",
    tone: "public" as const,
  };
  const state = clean(attrs.ADMIN_ST);
  const area = Number(attrs.Shape_Area);
  return {
    agency: code,
    label: meta.label,
    swatch: meta.swatch,
    tone: meta.tone,
    state,
    unit: clean(attrs.ADMIN_UNIT_NAME),
    note: noteFor(meta.tone, state),
    area: Number.isFinite(area) ? area : Number.POSITIVE_INFINITY,
  };
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
  const body = (await res.json()) as { results?: RawHit[] };
  const hits = (body.results ?? [])
    .map(toHit)
    .filter((hit): hit is LandHit & { area: number } => hit !== null)
    .sort((a, b) => a.area - b.area);
  const unique: (LandHit & { area: number })[] = [];
  for (const hit of hits) {
    if (!unique.some((item) => item.agency === hit.agency)) unique.push(hit);
  }
  const primary = unique[0];
  if (!primary) {
    return {
      agency: "PVT",
      label: "Likely private",
      swatch: null,
      tone: "private",
      state: null,
      unit: null,
      note: noteFor("private", null),
    };
  }
  const extra = unique
    .slice(1, 3)
    .map((hit) => hit.label)
    .join(", ");
  return {
    agency: primary.agency,
    label: primary.label,
    swatch: primary.swatch,
    tone: primary.tone,
    state: primary.state,
    unit: primary.unit,
    note: extra ? `${primary.note} Also nearby: ${extra}.` : primary.note,
  };
}
