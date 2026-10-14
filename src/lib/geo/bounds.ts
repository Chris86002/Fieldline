/**
 * Longitude/latitude bounding boxes that understand the antimeridian.
 *
 * A `Bounds` with `west > east` crosses 180° (for example the Aleutians:
 * west 172, east -129). Every function here treats such a box as two plain
 * boxes, [west, 180] and [-180, east]. Nothing here converts degrees to meters;
 * use a geodesic distance for that.
 */
import type { Bounds, LngLat } from "@/features/catalog/types";

/** The whole globe, as a plain box. */
export const WORLD_BOUNDS: Bounds = { west: -180, south: -90, east: 180, north: 90 };

/**
 * Wraps a longitude into [-180, 180]. Values already in range, including
 * exactly 180 and -180, are returned unchanged so box edges keep their side.
 * Non-finite input returns NaN.
 */
export function normalizeLng(lng: number): number {
  if (!Number.isFinite(lng)) return Number.NaN;
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** True for finite coordinates inside [-180, 180] x [-90, 90]. */
export function isValidLngLat(point: LngLat): boolean {
  return (
    Number.isFinite(point.lng) &&
    Number.isFinite(point.lat) &&
    point.lng >= -180 &&
    point.lng <= 180 &&
    point.lat >= -90 &&
    point.lat <= 90
  );
}

/**
 * True when every edge is finite and in range and south <= north. `west > east`
 * is valid: it means the box crosses the antimeridian.
 */
export function isValidBounds(bounds: Bounds): boolean {
  const { west, south, east, north } = bounds;
  return (
    [west, south, east, north].every(Number.isFinite) &&
    west >= -180 &&
    west <= 180 &&
    east >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    south <= north
  );
}

/** True when the box crosses the antimeridian (`west > east`). */
export function crossesAntimeridian(bounds: Bounds): boolean {
  return bounds.west > bounds.east;
}

/**
 * Converts a map viewport, whose longitudes may run past ±180 when the map
 * shows wrapped world copies (e.g. west 170, east 190), into contract form:
 * longitudes in [-180, 180], with `west > east` when it crosses 180°. A view
 * 360° wide or wider becomes the full longitude range. Latitudes are clamped.
 * Returns null for non-finite input or south > north.
 */
export function normalizeBounds(bounds: Bounds): Bounds | null {
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(Number.isFinite) || south > north) return null;
  const lat = { south: Math.max(-90, south), north: Math.min(90, north) };
  const inRange = west >= -180 && west <= 180 && east >= -180 && east <= 180;
  // Already in contract form (either a plain box or one crossing 180°).
  if (inRange) return { west, east, ...lat };
  // Out-of-range longitudes come from an unwrapped viewport, where west <= east.
  if (east - west >= 360) return { west: -180, east: 180, ...lat };
  if (west > east) return null;
  return { west: normalizeLng(west), east: normalizeLng(east), ...lat };
}

/**
 * Splits a box crossing the antimeridian into its two plain parts,
 * [west, 180] and [-180, east]. A plain box is returned alone.
 */
export function splitAntimeridian(bounds: Bounds): Bounds[] {
  if (!crossesAntimeridian(bounds)) return [bounds];
  return [
    { west: bounds.west, south: bounds.south, east: 180, north: bounds.north },
    { west: -180, south: bounds.south, east: bounds.east, north: bounds.north },
  ];
}

function plainIntersects(a: Bounds, b: Bounds): boolean {
  return a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
}

/**
 * True when the boxes share any area or edge. Either or both may cross the
 * antimeridian.
 */
export function intersects(a: Bounds, b: Bounds): boolean {
  const partsA = splitAntimeridian(a);
  const partsB = splitAntimeridian(b);
  return partsA.some((pa) => partsB.some((pb) => plainIntersects(pa, pb)));
}

/** True when any of `boxes` intersects `bounds`. */
export function intersectsAny(boxes: readonly Bounds[], bounds: Bounds): boolean {
  return boxes.some((box) => intersects(box, bounds));
}

/**
 * True when the point lies inside or on the edge of the box. The point's
 * longitude is wrapped first, and ±180 are treated as the same meridian.
 */
export function containsPoint(bounds: Bounds, point: LngLat): boolean {
  if (!Number.isFinite(point.lat) || point.lat < bounds.south || point.lat > bounds.north) {
    return false;
  }
  const lng = normalizeLng(point.lng);
  if (Number.isNaN(lng)) return false;
  const candidates = Math.abs(lng) === 180 ? [-180, 180] : [lng];
  return splitAntimeridian(bounds).some((part) =>
    candidates.some((x) => x >= part.west && x <= part.east),
  );
}

/**
 * The smallest box containing every point, or null for an empty list or any
 * invalid point. When the points sit on both sides of 180° and the shorter
 * span crosses it, the result crosses the antimeridian (`west > east`).
 */
export function boundsOfPoints(points: readonly LngLat[]): Bounds | null {
  if (points.length === 0) return null;
  let south = Infinity;
  let north = -Infinity;
  const lngs: number[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || p.lat < -90 || p.lat > 90) return null;
    const lng = normalizeLng(p.lng);
    if (Number.isNaN(lng)) return null;
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    // -180 and 180 are one meridian; keep one spelling so the gap search works.
    lngs.push(lng === -180 ? 180 : lng);
  }
  lngs.sort((a, b) => a - b);
  // The box is the circle of longitudes minus its largest empty gap.
  // Start with the gap that wraps from the largest longitude to the smallest.
  let gap = lngs[0] + 360 - lngs[lngs.length - 1];
  let west = lngs[0];
  let east = lngs[lngs.length - 1];
  for (let i = 1; i < lngs.length; i++) {
    const g = lngs[i] - lngs[i - 1];
    if (g > gap) {
      gap = g;
      west = lngs[i];
      east = lngs[i - 1];
    }
  }
  // A single point at 180 stays a plain zero-width box.
  return { west, south, east, north };
}
