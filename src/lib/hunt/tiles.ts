const CACHE = "fieldline-tiles-v1";
const PROTOCOL = "fltile";
const MAX_PACK_TILES = 220;
const TILE_TIMEOUT_MS = 8_000;

export const TILES = {
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  hillshade: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
  topo: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  street: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  roads: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
  places: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  sma: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}",
} as const;

let installed = false;

function httpsFrom(protocolUrl: string): string {
  const prefix = `${PROTOCOL}://`;
  return protocolUrl.startsWith(prefix) ? protocolUrl.slice(prefix.length) : protocolUrl;
}

export function cachedTile(template: string): string {
  return `${PROTOCOL}://${template}`;
}

export function installTileProtocol(ml: { addProtocol: typeof import("maplibre-gl").addProtocol }) {
  if (installed) return;
  installed = true;
  ml.addProtocol(PROTOCOL, async (params, abort) => {
    const url = httpsFrom(params.url);
    if (!url.startsWith("https://")) throw new Error("Blocked tile");

    let cache: Cache | null = null;
    try {
      if (typeof caches !== "undefined") cache = await caches.open(CACHE);
    } catch {
      cache = null;
    }
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return { data: await hit.arrayBuffer() };
      } catch {
        cache = null;
      }
    }

    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.arrayBuffer();
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
    return { data };
  });
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
  const templates = [...new Set(options.templates)].filter((template) =>
    (Object.values(TILES) as string[]).includes(template),
  );
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
