const CACHE = "fieldline-tiles-v1";
const PROTOCOL = "fltile";
const MAX_PACK_TILES = 220;
const TILE_TIMEOUT_MS = 8_000;

export const TILES = {
  /** Esri World Imagery: live viewing only. Esri's terms forbid storing or pre-fetching its tiles. */
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  /** USGS The National Map orthoimagery: public domain, tile export allowed. */
  imagery: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  topo: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  sma: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}",
} as const;

/**
 * Tile sources whose published terms allow storing tiles on the device.
 * See docs/data-sources.md before adding one.
 */
export const OFFLINE_TEMPLATES: readonly string[] = [TILES.imagery, TILES.topo, TILES.sma];

const STORABLE_PREFIXES = OFFLINE_TEMPLATES.map((template) => template.slice(0, template.indexOf("{")));

/** True when this tile URL comes from a source that permits device storage. */
export function canStoreTile(url: string): boolean {
  return STORABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

let installed = false;

function httpsFrom(protocolUrl: string): string {
  const prefix = `${PROTOCOL}://`;
  return protocolUrl.startsWith(prefix) ? protocolUrl.slice(prefix.length) : protocolUrl;
}

/**
 * Wraps a source URL or template in the `fltile://` protocol: offline
 * packages first, then the tile cache (only for `OFFLINE_TEMPLATES`), then
 * the network. Works for raster templates, the OpenFreeMap TileJSON URL
 * (`cachedTile(OFM)`), the glyph template, and the app's `/api/dem` template.
 */
export function cachedTile(template: string): string {
  return `${PROTOCOL}://${template}`;
}

/** Bytes for a tile from a verified offline package (src/lib/offline/serve.ts). */
export type PackagedTile = { data: ArrayBuffer; contentType?: string; status?: number };
export type PackageTileSource = (
  url: string,
  options?: { substituteVersions?: boolean },
) => Promise<PackagedTile | null>;

let packageSource: PackageTileSource | null = null;
const stats = { package: 0, cache: 0, network: 0, failed: 0 };

/**
 * Lets the `fltile://` protocol read offline packages before the cache and
 * network. Call once at startup with `createPackageTileSource(store)`; pass
 * null to detach.
 */
export function setPackageTileSource(source: PackageTileSource | null) {
  packageSource = source;
}

/** Where `fltile://` responses came from since startup (diagnostics, offline checks). */
export function tileProtocolStats() {
  return { ...stats };
}

/**
 * HTTPS anywhere, plus plain HTTP only for this app's own `/api/dem` terrain
 * proxy (the dev and desktop servers run on http://localhost).
 */
function allowedUrl(url: string): boolean {
  if (url.startsWith("https://")) return true;
  const origin = globalThis.location?.origin;
  return Boolean(origin && url.startsWith(`${origin}/api/dem/`));
}

/**
 * A TileJSON's tile URLs are wrapped in `fltile://` too, so vector tiles of a
 * packaged source (OpenFreeMap) are served from the package when offline.
 */
export function wrapTileJson(json: unknown): unknown {
  if (!json || typeof json !== "object") return json;
  const tiles = (json as { tiles?: unknown }).tiles;
  if (!Array.isArray(tiles)) return json;
  return {
    ...json,
    tiles: tiles.map((tile) =>
      typeof tile === "string" && tile.startsWith("https://") ? cachedTile(tile) : tile,
    ),
  };
}

/** The `fltile://` handler (exported for tests; MapLibre calls it through `addProtocol`). */
export async function loadTile(
  params: { url: string; type?: string },
  abort: AbortController,
): Promise<{ data: unknown }> {
  const url = httpsFrom(params.url);
  if (!allowedUrl(url)) throw new Error("Blocked tile");
  const respond = (data: ArrayBuffer) =>
    params.type === "json"
      ? { data: wrapTileJson(JSON.parse(new TextDecoder().decode(data))) }
      : params.type === "string"
        ? { data: new TextDecoder().decode(data) }
        : { data };
  const offline = globalThis.navigator?.onLine === false;

  /** Packaged copy; with `substitute`, another packaged data version of the same tile. */
  const fromPackage = async (substitute: boolean) => {
    if (!packageSource) return null;
    let hit: PackagedTile | null = null;
    try {
      hit = await packageSource(url, { substituteVersions: substitute });
    } catch {
      hit = null;
    }
    if (!hit) return null;
    stats.package += 1;
    // The provider has no tile here (confirmed when the package was made).
    if (hit.status === 404) throw new Error("404");
    return respond(hit.data);
  };

  // A TileJSON names the provider's current data version: online, always
  // ask the network, so the map never stays pinned to an old packaged
  // version. Packaged copies are the offline fallback.
  if (params.type === "json") {
    if (!offline) {
      try {
        return await fromNetwork(url, abort, respond, null);
      } catch (error) {
        const packaged = await fromPackage(true);
        if (packaged) return packaged;
        throw error;
      }
    }
    const packaged = await fromPackage(true);
    if (packaged) return packaged;
    return fromNetwork(url, abort, respond, null);
  }

  const packaged = await fromPackage(offline);
  if (packaged) return packaged;

  let cache: Cache | null = null;
  try {
    if (typeof caches !== "undefined" && canStoreTile(url)) cache = await caches.open(CACHE);
  } catch {
    cache = null;
  }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        stats.cache += 1;
        return respond(await hit.arrayBuffer());
      }
    } catch {
      cache = null;
    }
  }

  try {
    return await fromNetwork(url, abort, respond, cache);
  } catch (error) {
    // The network failed (offline without navigator.onLine knowing): a
    // packaged copy under another data version still beats a blank map.
    if (!offline) {
      const substitute = await fromPackage(true);
      if (substitute) return substitute;
    }
    // Zoomed past a downloaded area's deepest level: enlarge its tile.
    const enlarged = await fromAncestor(url);
    if (enlarged) {
      stats.package += 1;
      return respond(enlarged);
    }
    throw error;
  }
}

/** Raster grids whose missing tiles can be enlarged from a packaged ancestor: URL prefix and path order. */
type RasterGrid = { prefix: string; order: "zyx" | "zxy"; terrain: boolean };

function rasterGrids(): RasterGrid[] {
  const grids: RasterGrid[] = OFFLINE_TEMPLATES.map((template) => ({ prefix: template.slice(0, template.indexOf("{")), order: "zyx", terrain: false }));
  const origin = globalThis.location?.origin;
  if (origin) grids.push({ prefix: `${origin}/api/dem/`, order: "zxy", terrain: true });
  return grids;
}

/** Deepest ancestor search when enlarging (a tile from 4 levels up is 16 pixels across). */
const MAX_ENLARGE_LEVELS = 4;

/**
 * The tile `levels` zooms above a raster tile URL, and the square of it that
 * covers the original (in 256-pixel tile coordinates). Null for URLs that
 * aren't raster grid tiles.
 */
export function ancestorTile(
  url: string,
  levels: number,
  grids = rasterGrids(),
): { url: string; sx: number; sy: number; size: number; terrain: boolean } | null {
  for (const grid of grids) {
    if (!url.startsWith(grid.prefix)) continue;
    const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(url.slice(grid.prefix.length));
    if (!match) return null;
    const z = Number(match[1]);
    const [x, y] = grid.order === "zxy" ? [Number(match[2]), Number(match[3])] : [Number(match[3]), Number(match[2])];
    if (levels < 1 || levels > z) return null;
    const px = x >> levels;
    const py = y >> levels;
    const size = 256 / 2 ** levels;
    const path = grid.order === "zxy" ? `${z - levels}/${px}/${py}` : `${z - levels}/${py}/${px}`;
    return { url: `${grid.prefix}${path}`, sx: (x - px * 2 ** levels) * size, sy: (y - py * 2 ** levels) * size, size, terrain: grid.terrain };
  }
  return null;
}

/** Crops a square of an image and scales it to a full tile (PNG bytes). Browser only. */
export type TileEnlarger = (
  image: { data: ArrayBuffer; contentType: string },
  crop: { sx: number; sy: number; size: number; smooth: boolean },
) => Promise<ArrayBuffer>;

const canvasEnlarger: TileEnlarger = async (image, crop) => {
  const bitmap = await createImageBitmap(new Blob([image.data], { type: image.contentType }));
  const scale = bitmap.width / 256;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  // Terrain tiles encode elevation in their colors: never blend neighboring pixels.
  context.imageSmoothingEnabled = crop.smooth;
  context.drawImage(bitmap, crop.sx * scale, crop.sy * scale, crop.size * scale, crop.size * scale, 0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
};

let enlarger: TileEnlarger | null =
  typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function" ? canvasEnlarger : null;

/** @internal Tests: replace the image step (Node has no canvas). */
export function _setTileEnlarger(next: TileEnlarger | null) {
  enlarger = next;
}

/** A raster tile enlarged from the nearest packaged ancestor, or null. */
async function fromAncestor(url: string): Promise<ArrayBuffer | null> {
  if (!packageSource || !enlarger) return null;
  for (let levels = 1; levels <= MAX_ENLARGE_LEVELS; levels += 1) {
    const ancestor = ancestorTile(url, levels);
    if (!ancestor) return null;
    let hit: PackagedTile | null = null;
    try {
      hit = await packageSource(ancestor.url);
    } catch {
      hit = null;
    }
    if (!hit) continue;
    // The provider had no data there: nothing to enlarge.
    if (hit.status === 404) return null;
    try {
      return await enlarger(
        { data: hit.data, contentType: hit.contentType ?? "image/png" },
        { sx: ancestor.sx, sy: ancestor.sy, size: ancestor.size, smooth: !ancestor.terrain },
      );
    } catch {
      return null;
    }
  }
  return null;
}

async function fromNetwork(
  url: string,
  abort: AbortController,
  respond: (data: ArrayBuffer) => { data: unknown },
  cache: Cache | null,
): Promise<{ data: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: abort.signal });
  } catch (error) {
    stats.failed += 1;
    throw error;
  }
  if (!response.ok) {
    stats.failed += 1;
    throw new Error(String(response.status));
  }
  const data = await response.arrayBuffer();
  stats.network += 1;
  if (cache) {
    try {
      await cache.put(
        url,
        new Response(data.slice(0), {
          headers: { "Content-Type": response.headers.get("content-type") ?? "image/jpeg" },
        }),
      );
    } catch {
      // Tile display should not depend on optional browser cache/quota support.
    }
  }
  return respond(data);
}

export function installTileProtocol(ml: { addProtocol: typeof import("maplibre-gl").addProtocol }) {
  if (installed) return;
  installed = true;
  ml.addProtocol(PROTOCOL, loadTile as Parameters<typeof ml.addProtocol>[1]);
}

function lonToX(lng: number, z: number): number {
  return Math.max(0, Math.min(2 ** z - 1, Math.floor(((lng + 180) / 360) * 2 ** z)));
}

function latToY(lat: number, z: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

function expand(template: string, z: number, x: number, y: number): string {
  return template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y));
}

type TileBounds = { west: number; south: number; east: number; north: number };
type PackOptions = TileBounds & {
  zoom: number;
  templates: string[];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};
export type PackResult = {
  saved: number;
  reused: number;
  failed: number;
  total: number;
  skipped: boolean;
};

function validBounds(bounds: TileBounds): boolean {
  return (
    Number.isFinite(bounds.west) &&
    Number.isFinite(bounds.east) &&
    Number.isFinite(bounds.south) &&
    Number.isFinite(bounds.north) &&
    bounds.west >= -180 &&
    bounds.east <= 180 &&
    bounds.west <= bounds.east &&
    bounds.south >= -90 &&
    bounds.north <= 90 &&
    bounds.south <= bounds.north
  );
}

function emptyPack(total = 0, skipped = false): PackResult {
  return { saved: 0, reused: 0, failed: 0, total, skipped };
}

export async function packTiles(options: PackOptions): Promise<PackResult> {
  const templates = [...new Set(options.templates)].filter((template) => OFFLINE_TEMPLATES.includes(template));
  if (!validBounds(options) || !Number.isFinite(options.zoom) || templates.length === 0) {
    return emptyPack(0, true);
  }

  const z = Math.max(8, Math.min(15, Math.round(options.zoom)));
  const x0 = lonToX(options.west, z);
  const x1 = lonToX(options.east, z);
  const y0 = latToY(options.north, z);
  const y1 = latToY(options.south, z);
  const gridSize = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
  const total = gridSize * templates.length;
  if (total === 0 || total > MAX_PACK_TILES) return emptyPack(total, true);

  let cache: Cache;
  try {
    if (typeof caches === "undefined") return { ...emptyPack(total), failed: total };
    cache = await caches.open(CACHE);
  } catch {
    return { ...emptyPack(total), failed: total };
  }

  let saved = 0;
  let reused = 0;
  let failed = 0;
  let done = 0;
  for (const template of templates) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const url = expand(template, z, x, y);
        if (options.signal?.aborted) {
          failed += total - done;
          options.onProgress?.(total, total);
          return { saved, reused, failed, total, skipped: false };
        }
        try {
          if (await cache.match(url)) {
            reused += 1;
          } else {
            const timeout = AbortSignal.timeout(TILE_TIMEOUT_MS);
            const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(String(response.status));
            await cache.put(url, response);
            saved += 1;
          }
        } catch {
          failed += 1;
        }
        done += 1;
        options.onProgress?.(done, total);
      }
    }
  }
  return { saved, reused, failed, total, skipped: false };
}

/**
 * Deletes stored tiles from sources that don't permit device storage (older
 * builds cached Esri imagery). Returns how many were removed.
 */
export async function purgeRestrictedTiles(): Promise<number> {
  try {
    if (typeof caches === "undefined") return 0;
    const cache = await caches.open(CACHE);
    let removed = 0;
    for (const request of await cache.keys()) {
      if (canStoreTile(request.url)) continue;
      if (await cache.delete(request)) removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function tileCacheLabel(): Promise<string | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(CACHE);
    const count = (await cache.keys()).length;
    if (!count) return null;
    return `${count.toLocaleString()} map tile${count === 1 ? "" : "s"} saved on this device`;
  } catch {
    return null;
  }
}
