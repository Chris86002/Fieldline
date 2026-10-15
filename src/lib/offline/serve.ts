import type { PackagedTile, PackageTileSource } from "../hunt/tiles.ts";
import type { OfflinePackageStore } from "./package-store.ts";
import { canonicalAssetUrl, packageRuleFor } from "./sources.ts";

/**
 * The package lookup the `fltile://` protocol uses (see `setPackageTileSource`
 * in src/lib/hunt/tiles.ts): canonicalizes the requested URL and returns the
 * bytes from a verified package, or null so the protocol falls back to the
 * tile cache and then the network. Storage errors are treated as a miss.
 * `substituteVersions` (the protocol sets it when offline) answers an
 * OpenFreeMap tile from a package downloaded under another data version.
 */
export function createPackageTileSource(
  store: OfflinePackageStore,
  options: { appOrigin?: string | null } = {},
): PackageTileSource {
  return async (url: string, lookup: { substituteVersions?: boolean } = {}) => {
    const appOrigin =
      options.appOrigin !== undefined ? options.appOrigin : (globalThis.location?.origin ?? null);
    const canonical = canonicalAssetUrl(url, appOrigin);
    if (!canonical || !packageRuleFor(canonical)) return null;
    try {
      const hit = await store.readServableAsset(canonical, lookup);
      if (!hit) return null;
      const tile: PackagedTile = {
        data: hit.data,
        contentType: hit.contentType,
        status: hit.status,
      };
      return tile;
    } catch {
      return null;
    }
  };
}
