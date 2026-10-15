import { canStoreTile, TILES } from "../hunt/tiles.ts";

/**
 * Offline package sources: which map layers can be packaged, their provider
 * rules (docs/data-sources.md), and canonical asset URLs.
 *
 * Only sources whose published terms allow device storage are packageable.
 * Esri imagery (terms forbid storing or pre-fetching tiles) and hunt-unit data
 * (download/redistribution rights unverified) can never be packaged: they are
 * not in `PACKAGE_LAYERS`, and `packageRuleFor` refuses their URLs.
 */

export type PackageLayerId =
  "usgs-imagery" | "usgs-topo" | "blm-sma" | "ofm-vector" | "dem" | "glyphs";

export type ProviderId = "usgs" | "blm" | "openfreemap" | "aws-terrain";

export type AssetKind = "raster" | "vector" | "tilejson" | "glyphs" | "terrain";

export type PackageLayerDef = {
  id: PackageLayerId;
  label: string;
  provider: ProviderId;
  kind: AssetKind;
  /** URL template with {z}/{x}/{y}; null when it must be resolved at download time (OFM TileJSON). */
  template: string | null;
  /** Highest zoom the map requests from this source (MapCanvas `maxzoom`); deeper views overzoom. */
  maxZoom: number;
  /** Average bytes per asset, for estimates only. */
  estimatedTileBytes: number;
  attribution: string;
  /** How long a downloaded copy counts as current before the package is "stale". */
  maxAgeDays: number;
  /** Known source version, when the provider publishes one. */
  sourceVersion: string | null;
};

const OFM_HOST = "tiles.openfreemap.org";
export const OFM_TILEJSON_URL = `https://${OFM_HOST}/planet`;
export const OFM_GLYPHS_TEMPLATE = `https://${OFM_HOST}/fonts/{fontstack}/{range}.pbf`;
/** The terrain tiles the app's /api/dem route proxies (src/routes/api/dem). */
export const DEM_UPSTREAM_PREFIX = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/";
const DEM_TEMPLATE = `${DEM_UPSTREAM_PREFIX}{z}/{x}/{y}.png`;

/** Font stacks the map style uses (src/features/map/style-layers.ts `text-font`). */
export const PACKAGE_FONTSTACKS = [
  "Noto Sans Regular",
  "Noto Sans Bold",
  "Noto Sans Italic",
] as const;
/**
 * Glyph ranges packaged per font stack: Basic Latin + Latin-1 (digits, °, ·),
 * Latin Extended-A/B (place names), General Punctuation (– ’ … •).
 */
export const PACKAGE_GLYPH_RANGES = ["0-255", "256-511", "8192-8447"] as const;

export const PACKAGE_LAYERS: Record<PackageLayerId, PackageLayerDef> = {
  "usgs-imagery": {
    id: "usgs-imagery",
    label: "USGS imagery",
    provider: "usgs",
    kind: "raster",
    template: TILES.imagery,
    maxZoom: 16,
    estimatedTileBytes: 30_000,
    attribution: "Imagery: USGS The National Map, USDA",
    maxAgeDays: 365,
    sourceVersion: null,
  },
  "usgs-topo": {
    id: "usgs-topo",
    label: "USGS topo",
    provider: "usgs",
    kind: "raster",
    template: TILES.topo,
    maxZoom: 16,
    estimatedTileBytes: 25_000,
    attribution: "Topo: USGS The National Map",
    maxAgeDays: 365,
    sourceVersion: null,
  },
  "blm-sma": {
    id: "blm-sma",
    label: "Public land (BLM SMA)",
    provider: "blm",
    kind: "raster",
    template: TILES.sma,
    maxZoom: 16,
    estimatedTileBytes: 8_000,
    attribution: "Public land © BLM",
    // "may be updated by the BLM without notification"
    maxAgeDays: 90,
    sourceVersion: null,
  },
  "ofm-vector": {
    id: "ofm-vector",
    label: "Roads, water and place labels (OpenFreeMap)",
    provider: "openfreemap",
    kind: "vector",
    template: null,
    maxZoom: 14,
    estimatedTileBytes: 25_000,
    attribution: "© OpenStreetMap, OpenFreeMap",
    maxAgeDays: 60,
    sourceVersion: null,
  },
  dem: {
    id: "dem",
    label: "3D terrain",
    provider: "aws-terrain",
    kind: "terrain",
    template: DEM_TEMPLATE,
    maxZoom: 14,
    estimatedTileBytes: 90_000,
    attribution:
      "Terrain: AWS Terrain Tiles (3DEP data courtesy of the U.S. Geological Survey; SRTM; GMTED2010)",
    // The dataset is frozen (v1.1, 2017).
    maxAgeDays: 3650,
    sourceVersion: "terrarium v1.1",
  },
  glyphs: {
    id: "glyphs",
    label: "Map label fonts",
    provider: "openfreemap",
    kind: "glyphs",
    template: OFM_GLYPHS_TEMPLATE,
    maxZoom: 0,
    estimatedTileBytes: 75_000,
    attribution: "Fonts: OpenFreeMap (Noto Sans)",
    maxAgeDays: 365,
    sourceVersion: null,
  },
};

/**
 * Tile zoom minus MapLibre map zoom for a layer. MapLibre's zoom is based on
 * 512-pixel tiles, so the map's 256-pixel raster and terrain sources request
 * tiles one zoom deeper than the map zoom (at map zoom 12, USGS z13);
 * OpenFreeMap's 512-pixel vector tiles match the map zoom.
 */
export function mapZoomOffset(layerId: PackageLayerId): number {
  const kind = PACKAGE_LAYERS[layerId].kind;
  return kind === "raster" || kind === "terrain" ? 1 : 0;
}

/** The shallowest ancestor MapLibre's 3D terrain also asks for (`_addTerrainIdealTiles`: min(z, 5)). */
const TERRAIN_ANCESTOR_ZOOM = 5;

/**
 * Tile zooms a layer needs so the map works offline at map zooms
 * `minZoom`..`maxZoom` (before clamping to the layer's deepest tiles).
 *
 * - Raster (256 px, rounded): one deeper than the map, `min+1`..`max+1`.
 * - Vector (512 px, floored): the map zooms.
 * - Terrain serves two consumers that ask differently. Hillshade alone
 *   treats it as a 256-px raster (`min+1`..`max+1`); with 3D terrain on,
 *   MapLibre switches the source to 512-px tiles at floor(map zoom), plus each
 *   tile's parent and a zoom-5 ancestor. So terrain covers
 *   `min(5, min-1)`..`max+1` (the shallow levels are a handful of tiles).
 */
export function mapZoomTileRange(layerId: PackageLayerId, minZoom: number, maxZoom: number): { lo: number; hi: number } {
  const kind = PACKAGE_LAYERS[layerId].kind;
  if (kind === "terrain") return { lo: Math.max(0, Math.min(TERRAIN_ANCESTOR_ZOOM, minZoom - 1)), hi: maxZoom + 1 };
  const offset = mapZoomOffset(layerId);
  return { lo: minZoom + offset, hi: maxZoom + offset };
}

/** Layers a user can choose; label fonts are added to every package automatically. */
export const SELECTABLE_LAYERS: readonly PackageLayerId[] = [
  "usgs-imagery",
  "usgs-topo",
  "blm-sma",
  "ofm-vector",
  "dem",
];

/**
 * Layers the map shows that can never be packaged, with the reason shown to
 * the user. Keys are the ids a caller may pass to `planPackage`.
 */
export const UNPACKAGEABLE_LAYERS: Record<string, string> = {
  "esri-imagery":
    "Esri satellite imagery can't be stored on the device (Esri's terms). USGS imagery can be downloaded instead.",
  satellite:
    "Esri satellite imagery can't be stored on the device (Esri's terms). USGS imagery can be downloaded instead.",
  hybrid:
    "Esri satellite imagery can't be stored on the device (Esri's terms). USGS imagery can be downloaded instead.",
  "hunt-units":
    "Hunt units: download rights from the state agencies are unverified, so unit boundaries aren't included. Check the agency's map before you go.",
  units:
    "Hunt units: download rights from the state agencies are unverified, so unit boundaries aren't included. Check the agency's map before you go.",
};

/** Provider limits, enforced when planning and again while downloading. */
export const PROVIDER_LIMITS: Record<
  ProviderId,
  { maxConcurrency: number; maxAssetsPerPackage: number | null; maxBytesPerPackage: number | null }
> = {
  // https://openfreemap.org/tos/ : at most 3,000 tiles or 50 MB per download, ≤ 4 parallel requests.
  openfreemap: { maxConcurrency: 4, maxAssetsPerPackage: 3_000, maxBytesPerPackage: 50_000_000 },
  // USGS and BLM report maxExportTilesCount 100,000; we stay far below and keep requests polite.
  usgs: { maxConcurrency: 4, maxAssetsPerPackage: null, maxBytesPerPackage: null },
  blm: { maxConcurrency: 2, maxAssetsPerPackage: null, maxBytesPerPackage: null },
  "aws-terrain": { maxConcurrency: 4, maxAssetsPerPackage: null, maxBytesPerPackage: null },
};

/** Hard limits for one package, whatever the layers. */
export const PACKAGE_LIMITS = {
  maxAssets: 20_000,
  maxBytes: 1_000_000_000,
  /** One asset larger than this is refused (a provider error page or a bad response). */
  maxAssetBytes: 8_000_000,
  maxZoom: 16,
} as const;

/** Esri hosts: live viewing only, never stored or pre-fetched (ADR-006). */
export function isRestrictedSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "arcgisonline.com" ||
      host.endsWith(".arcgisonline.com") ||
      host.endsWith(".arcgis.com")
    );
  } catch {
    return true;
  }
}

/**
 * Canonical asset URL: the key an asset is stored under. Strips the `fltile://`
 * wrapper and fragments; maps the app's same-origin `/api/dem/{z}/{x}/{y}`
 * proxy (any origin the app runs on) to the upstream terrain tile URL, so a
 * package downloaded on one origin serves on another. Returns null for
 * anything that isn't an http(s) URL.
 */
export function canonicalAssetUrl(input: string, appOrigin?: string | null): string | null {
  const raw = input.startsWith("fltile://") ? input.slice("fltile://".length) : input;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  const dem = /^\/api\/dem\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/.exec(url.pathname);
  if (dem && !url.search && (!appOrigin || url.origin === appOrigin)) {
    return `${DEM_UPSTREAM_PREFIX}${Number(dem[1])}/${Number(dem[2])}/${Number(dem[3])}.png`;
  }
  return url.href;
}

/** URL to fetch a canonical asset from (terrain goes through the app's proxy). */
export function fetchUrlFor(canonical: string, appOrigin: string | null): string {
  if (canonical.startsWith(DEM_UPSTREAM_PREFIX)) {
    const match = /(\d+)\/(\d+)\/(\d+)\.png$/.exec(canonical.slice(DEM_UPSTREAM_PREFIX.length));
    if (match && appOrigin) return `${appOrigin}/api/dem/${match[1]}/${match[2]}/${match[3]}`;
  }
  return canonical;
}

export type PackageRule = {
  layerId: PackageLayerId;
  provider: ProviderId;
  kind: AssetKind;
};

const OFM_TILE_PATH = /^\/planet\/[A-Za-z0-9_.-]{1,64}\/\d{1,2}\/\d{1,6}\/\d{1,6}\.pbf$/;
const OFM_GLYPH_PATH = /^\/fonts\/[A-Za-z0-9%_ .-]{1,80}\/\d{1,5}-\d{1,5}\.pbf$/;

/**
 * The packaging rule for a canonical asset URL, or null when the URL may not
 * be stored in a package. This is the only gate the downloader trusts: Esri
 * and every host not listed here are refused.
 */
export function packageRuleFor(canonical: string): PackageRule | null {
  if (isRestrictedSource(canonical)) return null;
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search || url.username || url.port) return null;
  if (canStoreTile(canonical)) {
    if (canonical.startsWith(TILES.imagery.slice(0, TILES.imagery.indexOf("{"))))
      return { layerId: "usgs-imagery", provider: "usgs", kind: "raster" };
    if (canonical.startsWith(TILES.topo.slice(0, TILES.topo.indexOf("{"))))
      return { layerId: "usgs-topo", provider: "usgs", kind: "raster" };
    if (canonical.startsWith(TILES.sma.slice(0, TILES.sma.indexOf("{"))))
      return { layerId: "blm-sma", provider: "blm", kind: "raster" };
    return null;
  }
  if (url.hostname === OFM_HOST) {
    if (url.pathname === "/planet")
      return { layerId: "ofm-vector", provider: "openfreemap", kind: "tilejson" };
    if (OFM_TILE_PATH.test(url.pathname))
      return { layerId: "ofm-vector", provider: "openfreemap", kind: "vector" };
    if (OFM_GLYPH_PATH.test(url.pathname))
      return { layerId: "glyphs", provider: "openfreemap", kind: "glyphs" };
    return null;
  }
  if (
    canonical.startsWith(DEM_UPSTREAM_PREFIX) &&
    /^\d{1,2}\/\d{1,6}\/\d{1,6}\.png$/.test(canonical.slice(DEM_UPSTREAM_PREFIX.length))
  ) {
    return { layerId: "dem", provider: "aws-terrain", kind: "terrain" };
  }
  return null;
}

/** Glyph asset URLs for every packaged font stack and range. */
export function glyphUrls(): string[] {
  const urls: string[] = [];
  for (const stack of PACKAGE_FONTSTACKS) {
    for (const range of PACKAGE_GLYPH_RANGES) {
      urls.push(
        OFM_GLYPHS_TEMPLATE.replace("{fontstack}", encodeURIComponent(stack)).replace(
          "{range}",
          range,
        ),
      );
    }
  }
  return urls.map((url) => canonicalAssetUrl(url) ?? url);
}

/**
 * Validates an OpenFreeMap TileJSON and returns its tile template, or null.
 * The template must stay on tiles.openfreemap.org under /planet/<version>/.
 */
export function ofmTemplateFromTileJson(
  json: unknown,
): { template: string; version: string } | null {
  if (!json || typeof json !== "object") return null;
  const tiles = (json as { tiles?: unknown }).tiles;
  if (!Array.isArray(tiles) || typeof tiles[0] !== "string") return null;
  const template = tiles[0];
  const match =
    /^https:\/\/tiles\.openfreemap\.org\/planet\/([A-Za-z0-9_.-]{1,64})\/\{z\}\/\{x\}\/\{y\}\.pbf$/.exec(
      template,
    );
  if (!match) return null;
  return { template, version: match[1] };
}
