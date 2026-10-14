/**
 * Lookups over the coverage register (coverage-data.ts).
 *
 * The register's boxes are rough extents for discovery. Neighboring states'
 * boxes overlap, so a point near a border can return more than one
 * jurisdiction, and a point in one state's box may lie in its neighbor. Use
 * these functions to decide which sources to ask, never as a boundary test or
 * as the answer to "which state am I in".
 */
import type {
  Bounds,
  JurisdictionCoverage,
  LayerCategory,
  LayerCoverage,
  LngLat,
} from "@/features/catalog/types";
import { containsPoint, intersectsAny, normalizeBounds } from "../../lib/geo/bounds.ts";
import { JURISDICTIONS } from "./coverage-data.ts";

const BY_ID = new Map(JURISDICTIONS.map((j) => [j.id, j]));

/** The register entry for an id such as "us-az" (case-insensitive), or null. */
export function coverageFor(id: string): JurisdictionCoverage | null {
  return BY_ID.get(id.trim().toLowerCase() as JurisdictionCoverage["id"]) ?? null;
}

/**
 * Jurisdictions whose discovery box contains the point, in register order.
 * Near borders this returns several candidates. Invalid points return [].
 */
export function jurisdictionsAt(point: LngLat): JurisdictionCoverage[] {
  if (!Number.isFinite(point.lng) || !Number.isFinite(point.lat)) return [];
  if (point.lat < -90 || point.lat > 90) return [];
  return JURISDICTIONS.filter((j) => j.bounds.some((box) => containsPoint(box, point)));
}

/**
 * Jurisdictions whose discovery box intersects the view, in register order.
 * The view may cross the antimeridian (`west > east`) or come straight from a
 * wrapped map viewport (longitudes past ±180). Bounding-box candidates only:
 * boxes overlap their neighbors, so this is a discovery index, not a boundary
 * test. Invalid bounds return [].
 */
export function jurisdictionsInBounds(bounds: Bounds): JurisdictionCoverage[] {
  const view = normalizeBounds(bounds);
  if (!view) return [];
  return JURISDICTIONS.filter((j) => intersectsAny(j.bounds, view));
}

/**
 * What Fieldline holds for one layer in one jurisdiction. An id missing from
 * the register (a territory, a typo) reports "unknown" rather than claiming
 * the layer is unavailable.
 */
export function layerStatus(id: string, category: LayerCategory): LayerCoverage {
  const entry = coverageFor(id);
  if (!entry) {
    return {
      status: "unknown",
      providerIds: [],
      note: "Fieldline has no coverage entry for this area.",
    };
  }
  return entry.layers[category];
}
