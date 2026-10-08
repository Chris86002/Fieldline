const CACHE = "fieldline-tiles-v1";
const PROTOCOL = "fltile";

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
    try {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (hit) return { data: await hit.arrayBuffer() };
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.arrayBuffer();
      void cache.put(url, new Response(data.slice(0), { headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg" } }));
      return { data };
    } catch (error) {
      if (abort.signal.aborted) throw error;
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(String(res.status));
      return { data: await res.arrayBuffer() };
    }
  });
}

function lonToX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

function latToY(lat: number, z: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

function expand(template: string, z: number, x: number, y: number): string {
  return template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y));
}

export async function packTiles(options: {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
  templates: string[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ saved: number; skipped: boolean }> {
  const z = Math.max(8, Math.min(15, Math.round(options.zoom)));
  const jobs: string[] = [];
  for (const template of options.templates) {
    const x0 = lonToX(options.west, z);
    const x1 = lonToX(options.east, z);
    const y0 = latToY(options.north, z);
    const y1 = latToY(options.south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) jobs.push(expand(template, z, x, y));
    }
  }
  if (jobs.length === 0 || jobs.length > 220) return { saved: 0, skipped: true };
  const cache = await caches.open(CACHE);
  let saved = 0;
  for (let i = 0; i < jobs.length; i++) {
    const url = jobs[i];
    if (!(await cache.match(url))) {
      const res = await fetch(url);
      if (res.ok) {
        await cache.put(url, res);
        saved += 1;
      }
    } else {
      saved += 1;
    }
    options.onProgress?.(i + 1, jobs.length);
  }
  return { saved, skipped: false };
}

export async function tileCacheLabel(): Promise<string | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  const used = estimate.usage ?? 0;
  if (used < 1024) return null;
  if (used < 1024 * 1024) return `${Math.round(used / 1024)} KB saved offline`;
  return `${(used / (1024 * 1024)).toFixed(1)} MB saved offline`;
}

