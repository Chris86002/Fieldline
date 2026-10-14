import type { PackagedTile } from "../hunt/tiles.ts";
import type { OfflinePackageStore } from "./package-store.ts";
import { canonicalAssetUrl, packageRuleFor } from "./sources.ts";

/**
 * The package lookup the `fltile://` protocol uses (see `setPackageTileSource`
 * in src/lib/hunt/tiles.ts): canonicalizes the requested URL and returns the
 * bytes from a verified package, or null so the protocol falls back to the
 * tile cache and then the network. Storage errors are treated as a miss.
 */
export function createPackageTileSource(
  store: OfflinePackageStore,
  options: { appOrigin?: string | null } = {},
): (url: string) => Promise<PackagedTile | null> {
  return async (url: string) => {
    const appOrigin =
      options.appOrigin !== undefined ? options.appOrigin : (globalThis.location?.origin ?? null);
    const canonical = canonicalAssetUrl(url, appOrigin);
    if (!canonical || !packageRuleFor(canonical)) return null;
    try {
      const hit = await store.readServableAsset(canonical);
      return hit ? { data: hit.data, contentType: hit.contentType, status: hit.status } : null;
    } catch {
      return null;
    }
  };
}
