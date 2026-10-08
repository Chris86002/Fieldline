export type HuntUnit = {
  gmu: string;
  region: string;
  regionName: string;
  sqMiles: number | null;
  land: string;
  species: string;
  forest: string;
  west: number;
  south: number;
  east: number;
  north: number;
  label: { lng: number; lat: number };
  polygons: number[][][][];
};

export type UnitHit = {
  gmu: string;
  regionName: string;
  sqMiles: number | null;
  land: string;
  species: string;
  forest: string;
  approximate: boolean;
};

type Ring = number[][];
type Geo = {
  features?: {
    properties?: Record<string, unknown>;
    geometry?: { type?: string; coordinates?: unknown };
  }[];
};

const UNITS_URL =
  "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0/query?where=GMU+NOT+IN+(%27N%2FA%27%2C%27+%27)&outFields=GMU,GF_REGION,REG_NAME,SQ_MILES,LANDOWN,HUNT,USFSName&returnGeometry=true&outSR=4326&geometryPrecision=3&maxAllowableOffset=0.004&f=geojson";

const IDENTIFY_URL =
  "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0/query";

const CACHE = "fieldline-units-v1";
const CACHE_KEY = "https://fieldline.local/az-gmu-v1.json";

let pending: Promise<HuntUnit[]> | null = null;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPolys(geometry: { type?: string; coordinates?: unknown } | undefined): number[][][][] {
  if (!geometry || geometry.coordinates == null) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  return [];
}

function ringInside(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function unitContains(unit: HuntUnit, lng: number, lat: number): boolean {
  if (lng < unit.west || lng > unit.east || lat < unit.south || lat > unit.north) return false;
  for (const polygon of unit.polygons) {
    if (polygon.length === 0) continue;
    if (!ringInside(lng, lat, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (ringInside(lng, lat, polygon[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function unitAt(units: HuntUnit[], lng: number, lat: number): HuntUnit | null {
  for (const unit of units) {
    if (unitContains(unit, lng, lat)) return unit;
  }
  return null;
}

function normalizeCode(query: string): string {
  return query
    .trim()
    .toUpperCase()
    .replace(/^(UNIT|GMU)\s+/, "")
    .replace(/\s+/g, "");
}

export function matchUnit(units: HuntUnit[], query: string): HuntUnit | null {
  const code = normalizeCode(query);
  if (!code || code.length > 4) return null;
  return units.find((unit) => unit.gmu.replace(/\s+/g, "").toUpperCase() === code) ?? null;
}

export function parseUnits(body: Geo): HuntUnit[] {
  const grouped = new Map<string, HuntUnit>();
  for (const feature of body.features ?? []) {
    const props = feature.properties ?? {};
    const gmu = clean(props.GMU);
    if (!gmu || gmu.toUpperCase() === "N/A") continue;
    const polygons = asPolys(feature.geometry).filter((polygon) => polygon[0]?.length);
    if (polygons.length === 0) continue;
    let piece = grouped.get(gmu);
    if (!piece) {
      const miles = Number(props.SQ_MILES);
      piece = {
        gmu,
        region: clean(props.GF_REGION),
        regionName: clean(props.REG_NAME),
        sqMiles: Number.isFinite(miles) ? miles : null,
        land: clean(props.LANDOWN),
        species: clean(props.HUNT),
        forest: clean(props.USFSName),
        west: Infinity,
        south: Infinity,
        east: -Infinity,
        north: -Infinity,
        label: { lng: 0, lat: 0 },
        polygons: [],
      };
      grouped.set(gmu, piece);
    }
    piece.polygons.push(...polygons);
  }
  const units = [...grouped.values()];
  for (const unit of units) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const polygon of unit.polygons) {
      for (const point of polygon[0]) {
        unit.west = Math.min(unit.west, point[0]);
        unit.east = Math.max(unit.east, point[0]);
        unit.south = Math.min(unit.south, point[1]);
        unit.north = Math.max(unit.north, point[1]);
        sx += point[0];
        sy += point[1];
        n += 1;
      }
    }
    if (n > 0) unit.label = { lng: sx / n, lat: sy / n };
  }
  units.sort((a, b) => a.gmu.localeCompare(b.gmu, "en", { numeric: true }));
  return units;
}

async function readCache(): Promise<HuntUnit[] | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(CACHE_KEY);
    if (!hit) return null;
    const parsed = parseUnits((await hit.json()) as Geo);
    return parsed.length > 20 ? parsed : null;
  } catch {
    return null;
  }
}

async function downloadUnits(): Promise<HuntUnit[]> {
  const res = await fetch(UNITS_URL);
  if (!res.ok) throw new Error("Hunt units unavailable");
  const body = (await res.json()) as Geo;
  const units = parseUnits(body);
  if (units.length < 20) throw new Error("Hunt units came back short");
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(CACHE_KEY, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
    } catch {
      /* private mode */
    }
  }
  return units;
}

export function loadUnits(): Promise<HuntUnit[]> {
  if (!pending) {
    pending = (async () => (await readCache()) ?? downloadUnits())().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

function hitFrom(attrs: Record<string, unknown>, approximate: boolean): UnitHit | null {
  const gmu = clean(attrs.GMU ?? attrs.gmu);
  if (!gmu || gmu.toUpperCase() === "N/A") return null;
  const miles = Number(attrs.SQ_MILES ?? attrs.sqMiles);
  return {
    gmu,
    regionName: clean(attrs.REG_NAME ?? attrs.regionName),
    sqMiles: Number.isFinite(miles) ? miles : null,
    land: clean(attrs.LANDOWN ?? attrs.land),
    species: clean(attrs.HUNT ?? attrs.species),
    forest: clean(attrs.USFSName ?? attrs.forest),
    approximate,
  };
}

export function hitFromUnit(unit: HuntUnit, approximate: boolean): UnitHit {
  return {
    gmu: unit.gmu,
    regionName: unit.regionName,
    sqMiles: unit.sqMiles,
    land: unit.land,
    species: unit.species,
    forest: unit.forest,
    approximate,
  };
}

export async function identifyUnit(lng: number, lat: number, signal?: AbortSignal): Promise<UnitHit | null> {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lng, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "GMU,REG_NAME,SQ_MILES,LANDOWN,HUNT,USFSName",
    returnGeometry: "false",
  });
  try {
    const res = await fetch(`${IDENTIFY_URL}?${params}`, { signal });
    if (res.ok) {
      const body = (await res.json()) as { features?: { attributes?: Record<string, unknown> }[] };
      const attrs = body.features?.[0]?.attributes;
      if (attrs) return hitFrom(attrs, false);
      if (body.features) return null;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  try {
    const units = await loadUnits();
    const local = unitAt(units, lng, lat);
    return local ? hitFromUnit(local, true) : null;
  } catch {
    return null;
  }
}

export function unitsCollection(units: HuntUnit[]): {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { gmu: string };
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  }[];
} {
  return {
    type: "FeatureCollection",
    features: units.map((unit) => ({
      type: "Feature",
      properties: { gmu: unit.gmu },
      geometry: { type: "MultiPolygon", coordinates: unit.polygons },
    })),
  };
}
