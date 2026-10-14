/**
 * Planar geometry helpers for hunt-unit polygons in WGS84 degrees.
 *
 * Polygons use GeoJSON MultiPolygon nesting: [polygon][ring][point][lng, lat].
 * Ring 0 of each polygon is the outer boundary; later rings are holes.
 * Containment uses the even-odd rule, so ring orientation does not matter.
 *
 * These helpers assume a unit does not cross the antimeridian. That holds
 * for the Arizona and Idaho sources; an Alaska adapter must split its
 * geometry before using them.
 */
import type { Bounds, LngLat } from "./types.ts";

export type Ring = number[][];
export type Polygon = number[][][];
export type MultiPolygon = number[][][][];

/** Returns the ring closed (first point repeated at the end). */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]]];
}

/** Even-odd ray cast. Uses the half-open rule so shared vertices count once. */
export function ringContains(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function polygonContains(polygon: Polygon, lng: number, lat: number): boolean {
  if (polygon.length === 0 || !ringContains(polygon[0], lng, lat)) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (ringContains(polygon[h], lng, lat)) return false;
  }
  return true;
}

/** True when any part of a multipart geometry contains the point. */
export function polygonsContain(polygons: MultiPolygon, lng: number, lat: number): boolean {
  return polygons.some((polygon) => polygonContains(polygon, lng, lat));
}

export function boundsContain(bounds: Bounds, lng: number, lat: number): boolean {
  if (lat < bounds.south || lat > bounds.north) return false;
  if (bounds.west <= bounds.east) return lng >= bounds.west && lng <= bounds.east;
  // Box crosses the antimeridian.
  return lng >= bounds.west || lng <= bounds.east;
}

/** Bounds of the outer rings, or null when there are no points. */
export function boundsOf(polygons: MultiPolygon): Bounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon[0] ?? []) {
      if (point[0] < west) west = point[0];
      if (point[0] > east) east = point[0];
      if (point[1] < south) south = point[1];
      if (point[1] > north) north = point[1];
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/** Absolute planar (degree) area of a ring. Only used to rank parts. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum) / 2;
}

export function polygonArea(polygon: Polygon): number {
  if (polygon.length === 0) return 0;
  let area = ringArea(polygon[0]);
  for (let h = 1; h < polygon.length; h++) area -= ringArea(polygon[h]);
  return area;
}

/** Sorted crossings of every ring of the polygon with a line. */
function crossings(polygon: Polygon, value: number, axis: 0 | 1): number[] {
  const other = axis === 0 ? 1 : 0;
  const hits: number[] = [];
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ai = ring[i][axis];
      const aj = ring[j][axis];
      if (ai > value !== aj > value) {
        const t = (value - ai) / (aj - ai);
        hits.push(ring[i][other] + t * (ring[j][other] - ring[i][other]));
      }
    }
  }
  return hits.sort((a, b) => a - b);
}

/** The even-odd interval [start, end] on a line that contains `at`, or null. */
function intervalAround(hits: number[], at: number): [number, number] | null {
  for (let k = 0; k + 1 < hits.length; k += 2) {
    if (hits[k] <= at && at <= hits[k + 1]) return [hits[k], hits[k + 1]];
  }
  return null;
}

const SCANLINES = 17;

/**
 * A label point guaranteed inside the largest part and outside its holes
 * (spec §6: interior label points, not a vertex average). Casts horizontal
 * scanlines, takes the midpoint of each inside interval, re-centres it on
 * the vertical interval through that point and keeps the candidate with the
 * largest min(width, height). Returns null for empty or degenerate input.
 */
export function interiorPoint(polygons: MultiPolygon): LngLat | null {
  let best: Polygon | null = null;
  let bestArea = -1;
  for (const polygon of polygons) {
    const area = polygonArea(polygon);
    if (polygon[0]?.length && area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  if (!best) return null;
  const box = boundsOf([best]);
  if (!box) return null;

  let pick: LngLat | null = null;
  let pickScore = -1;
  const height = box.north - box.south;
  for (let i = 0; i < SCANLINES; i++) {
    // The odd offset keeps scanlines off round-number vertex latitudes.
    const lat = box.south + (height * (i + 0.5 + 0.0137)) / SCANLINES;
    const xs = crossings(best, lat, 1);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const width = xs[k + 1] - xs[k];
      if (width <= 0) continue;
      const lng = (xs[k] + xs[k + 1]) / 2;
      let candidate: LngLat = { lng, lat };
      let tall = 0;
      const span = intervalAround(crossings(best, lng, 0), lat);
      if (span) {
        tall = span[1] - span[0];
        const centred = { lng, lat: (span[0] + span[1]) / 2 };
        if (polygonContains(best, centred.lng, centred.lat)) candidate = centred;
      }
      if (!polygonContains(best, candidate.lng, candidate.lat)) continue;
      const score = Math.min(width, tall);
      if (score > pickScore) {
        pick = candidate;
        pickScore = score;
      }
    }
  }
  return pick;
}
