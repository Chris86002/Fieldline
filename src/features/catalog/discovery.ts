/**
 * Provider discovery: which providers to ask for a map view or a point.
 * Pure functions over a provider list passed in by the caller, so adapters can
 * be registered elsewhere without this module importing them.
 */
import type { Bounds, LayerCategory, LngLat, ProviderInfo } from "@/features/catalog/types";
import { containsPoint, intersectsAny, normalizeBounds } from "../../lib/geo/bounds.ts";

/**
 * Providers whose coverage intersects the view, optionally limited to one
 * layer category, in input order. The view may cross the antimeridian
 * (`west > east`) or use wrapped longitudes from a map viewport. Invalid
 * views return [].
 */
export function providersForView(
  view: Bounds,
  providers: readonly ProviderInfo[],
  category?: LayerCategory,
): ProviderInfo[] {
  const box = normalizeBounds(view);
  if (!box) return [];
  return providers.filter(
    (p) => (category === undefined || p.category === category) && intersectsAny(p.coverage, box),
  );
}

/**
 * Providers whose coverage boxes contain the point, optionally limited to one
 * layer category. Coverage boxes are coarse, so a hit means "worth asking",
 * not "has data here".
 */
export function providersAt(
  point: LngLat,
  providers: readonly ProviderInfo[],
  category?: LayerCategory,
): ProviderInfo[] {
  return providers.filter(
    (p) =>
      (category === undefined || p.category === category) &&
      p.coverage.some((box) => containsPoint(box, point)),
  );
}
