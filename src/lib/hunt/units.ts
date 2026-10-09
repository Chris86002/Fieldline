import type { HuntRegion } from "@/lib/hunt/types";

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
  "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0/query?where=GMU+NOT+IN+(%27N%2FA%27%2C%27+%27)&outFields=GMU,GF_REGION,REG_NAME,SQ_MILES,LANDOWN,HUNT,USFSName&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0001&f=geojson";

const IDENTIFY_URL =
  "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0/query";

const ID_UNITS_URL =
  "https://gisportal-idfg.idaho.gov/hosting/rest/services/Hunting/MapServer/3/query?where=1%3D1&outFields=NAME,Elk_Zone&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.002&f=geojson";

const ID_IDENTIFY_URL = "https://gisportal-idfg.idaho.gov/hosting/rest/services/Hunting/MapServer/3/query";

const SPECS: Record<HuntRegion, { url: string; identify: string; cache: string; key: string; outFields: string }> = {
  az: {
    url: UNITS_URL,
    identify: IDENTIFY_URL,
    cache: "fieldline-units-v2",
    key: "https://fieldline.local/az-gmu-v2.json",
    outFields: "GMU,REG_NAME,SQ_MILES,LANDOWN,HUNT,USFSName",
  },
  id: {
    url: ID_UNITS_URL,
    identify: ID_IDENTIFY_URL,
    cache: "fieldline-units-id-v1",
    key: "https://fieldline.local/id-gmu-v1.json",
    outFields: "NAME,Elk_Zone",
  },
};

const pending = new Map<HuntRegion, Promise<HuntUnit[]>>();

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function closeRing(ring: Ring): Ring {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]]];
}

function asPolys(geometry: { type?: string; coordinates?: unknown } | undefined): number[][][][] {
  if (!geometry || geometry.coordinates == null) return [];
  const raw = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.type === "MultiPolygon" ? (geometry.coordinates as number[][][][]) : [];
  return raw.map((polygon) => polygon.map(closeRing));
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

export function parseUnits(body: Geo, region: HuntRegion = "az"): HuntUnit[] {
  const grouped = new Map<string, HuntUnit>();
  for (const feature of body.features ?? []) {
    const props = feature.properties ?? {};
    const gmu = region === "id" ? clean(props.NAME) : clean(props.GMU);
    if (!gmu || gmu.toUpperCase() === "N/A") continue;
    const polygons = asPolys(feature.geometry).filter((polygon) => polygon[0]?.length);
    if (polygons.length === 0) continue;
    let piece = grouped.get(gmu);
    if (!piece) {
      const miles = region === "id" ? Number.NaN : Number(props.SQ_MILES);
      piece = {
        gmu,
        region: region === "id" ? "" : clean(props.GF_REGION),
        regionName: region === "id" ? clean(props.Elk_Zone) : clean(props.REG_NAME),
        sqMiles: Number.isFinite(miles) ? miles : null,
        land: region === "id" ? "" : clean(props.LANDOWN),
        species: region === "id" ? "" : clean(props.HUNT),
        forest: region === "id" ? "" : clean(props.USFSName),
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

async function readCache(region: HuntRegion): Promise<HuntUnit[] | null> {
  if (typeof caches === "undefined") return null;
  const spec = SPECS[region];
  try {
    const cache = await caches.open(spec.cache);
    const hit = await cache.match(spec.key);
    if (!hit) return null;
    const parsed = parseUnits((await hit.json()) as Geo, region);
    return parsed.length > 20 ? parsed : null;
  } catch {
    return null;
  }
}

async function downloadUnits(region: HuntRegion): Promise<HuntUnit[]> {
  const spec = SPECS[region];
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error("Hunt units unavailable");
  const body = (await res.json()) as Geo;
  const units = parseUnits(body, region);
  if (units.length < 20) throw new Error("Hunt units came back short");
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(spec.cache);
      await cache.put(spec.key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
    } catch {
      /* private mode */
    }
  }
  return units;
}

export function loadUnits(region: HuntRegion = "az"): Promise<HuntUnit[]> {
  let job = pending.get(region);
  if (!job) {
    job = (async () => (await readCache(region)) ?? downloadUnits(region))().catch((error) => {
      pending.delete(region);
      throw error;
    });
    pending.set(region, job);
  }
  return job;
}

function hitFrom(attrs: Record<string, unknown>, approximate: boolean, region: HuntRegion): UnitHit | null {
  if (region === "id") {
    const gmu = clean(attrs.NAME ?? attrs.gmu);
    if (!gmu || gmu.toUpperCase() === "N/A") return null;
    return {
      gmu,
      regionName: clean(attrs.Elk_Zone ?? attrs.regionName),
      sqMiles: null,
      land: "",
      species: "",
      forest: "",
      approximate,
    };
  }
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

export async function identifyUnit(lng: number, lat: number, signal?: AbortSignal, region: HuntRegion = "az"): Promise<UnitHit | null> {
  const spec = SPECS[region];
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lng, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: spec.outFields,
    returnGeometry: "false",
  });
  try {
    const res = await fetch(`${spec.identify}?${params}`, { signal });
    if (res.ok) {
      const body = (await res.json()) as { features?: { attributes?: Record<string, unknown> }[] };
      const attrs = body.features?.[0]?.attributes;
      if (attrs) return hitFrom(attrs, false, region);
      if (body.features) return null;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  try {
    const units = await loadUnits(region);
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
