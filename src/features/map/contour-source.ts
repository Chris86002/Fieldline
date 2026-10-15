/**
 * Contour tile generator (MAP-03). Uses maplibre-contour (BSD-3-Clause,
 * pinned) to trace isolines from the terrain DEM and encode them as vector
 * tiles behind a MapLibre protocol. Loaded lazily by MapCanvas; if this chunk
 * can't load, the map runs without contours.
 *
 * DEM tiles are read through Fieldline's own `fltile://` handler (`loadTile`),
 * never with the library's plain `fetch`: offline packages first, then the
 * network (and, offline past a package's deepest zoom, an enlarged packaged
 * ancestor). A 512-pixel contour tile at z/x/y is traced from the 256-pixel
 * DEM tile z/x/y and its neighbors: the terrain zoom 3D terrain requests and
 * offline packages hold for that map zoom (docs/storage.md). Online these are
 * extra DEM requests next to the hillshade's (which are one zoom deeper); see
 * docs/map-design.md. DEM tiles are smoothed lightly before tracing
 * (`smoothElevation`): a copy for drawing only.
 *
 * Runs on the main thread (the library's worker mode fetches on its own and
 * would bypass offline packages). Work per tile is bounded by the tile size
 * and the caches below.
 */
import mlcontour from "maplibre-contour";
import { cachedTile, loadTile } from "../../lib/hunt/tiles.ts";
import { contourTileOptions, DEM_MAX_ZOOM, smoothElevation, type ContourDetail, type ElevationUnit } from "./contours.ts";

type LocalDemManager = InstanceType<typeof mlcontour.LocalDemManager>;
type ManagerOptions = ConstructorParameters<typeof mlcontour.LocalDemManager>[0];
type FetchDem = LocalDemManager["fetchDem"];
type FetchContourTile = LocalDemManager["fetchContourTile"];
type HeightTile = Awaited<ReturnType<FetchDem>>;
export type GetTile = NonNullable<ManagerOptions["getTile"]>;
type FetchResponse = Awaited<ReturnType<GetTile>>;

/** Parsed DEM tiles kept in memory (each 256×256 float32 = 256 KB), per cache. */
const CACHE_SIZE = 80;
const TIMEOUT_MS = 15_000;
const SMOOTHING_PASSES = 2;
/** How long a DEM tile that failed is answered from memory instead of asked again. */
export const FAILED_TILE_MEMORY_MS = 45_000;
const MAX_REMEMBERED_FAILURES = 500;

/** DEM tile bytes through `fltile://`: offline package, then network. `load` is replaceable for tests. */
export function fltileGetTile(load: typeof loadTile = loadTile): GetTile {
  return async (url, abort) => {
    const { data } = await load({ url: cachedTile(url), type: "arrayBuffer" }, abort);
    return { data: new Blob([data as ArrayBuffer], { type: "image/png" }) };
  };
}

/**
 * A missing neighbor is tolerated only when there is no network: the browser
 * says it's offline, or the request itself failed (a fetch `TypeError`, as
 * when every host is unreachable). HTTP errors and timeouts while online fail
 * the tile, so MapLibre asks again later instead of keeping a gap.
 */
export function noNetwork(error: unknown): boolean {
  return globalThis.navigator?.onLine === false || error instanceof TypeError;
}

function aborted(abort: AbortController, error: unknown): boolean {
  return abort.signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export type ContourManagerOptions = {
  demTemplate: string;
  getTile?: GetTile;
  /** Decodes a DEM image; the library's browser decoder by default. */
  decodeImage?: ManagerOptions["decodeImage"];
  /** Which neighbor failures leave a gap instead of failing the tile. */
  tolerate?: (error: unknown) => boolean;
  now?: () => number;
};

export class FieldlineDemManager extends mlcontour.LocalDemManager {
  private readonly failures = new Map<string, { error: unknown; until: number }>();
  private readonly tolerate: (error: unknown) => boolean;
  private readonly now: () => number;

  constructor(options: ContourManagerOptions) {
    super({
      demUrlPattern: options.demTemplate,
      cacheSize: CACHE_SIZE,
      encoding: "terrarium",
      maxzoom: DEM_MAX_ZOOM,
      timeoutMs: TIMEOUT_MS,
      getTile: options.getTile ?? fltileGetTile(),
      ...(options.decodeImage ? { decodeImage: options.decodeImage } : {}),
    });
    this.tolerate = options.tolerate ?? noNetwork;
    this.now = options.now ?? Date.now;
    const decode = this.decodeImage;
    // Smoothed once per DEM tile; the library caches the decoded result.
    this.decodeImage = async (...args) => smoothElevation(await decode(...args), SMOOTHING_PASSES);
    const fetchOnce = this.getTile;
    // Each failed DEM tile is asked once per `FAILED_TILE_MEMORY_MS`, not once per adjacent contour tile.
    this.getTile = (url, abort) => this.rememberFailures(fetchOnce, url, abort);
  }

  private async rememberFailures(getTile: GetTile, url: string, abort: AbortController): Promise<FetchResponse> {
    const known = this.failures.get(url);
    if (known && known.until > this.now()) throw known.error;
    if (known) this.failures.delete(url);
    try {
      return await getTile(url, abort);
    } catch (error) {
      if (!aborted(abort, error)) {
        this.failures.set(url, { error, until: this.now() + FAILED_TILE_MEMORY_MS });
        if (this.failures.size > MAX_REMEMBERED_FAILURES) this.failures.delete(this.failures.keys().next().value as string);
      }
      throw error;
    }
  }

  /** True while the DEM tile used for this contour tile position failed recently. */
  private failedRecently(z: number, x: number, y: number, overzoom = 0): boolean {
    const zoom = Math.max(0, Math.min(z - overzoom, this.maxzoom));
    const div = 1 << (z - zoom);
    const max = 1 << z;
    const url = this.demUrlPattern
      .replace("{z}", String(zoom))
      .replace("{x}", String(Math.floor(((x + max) % max) / div)))
      .replace("{y}", String(Math.floor(y / div)));
    const known = this.failures.get(url);
    return Boolean(known && known.until > this.now());
  }

  /**
   * Called for the tile and its eight neighbors. A neighbor that can't load
   * for lack of network (the edge of a downloaded area offline) only leaves
   * that edge of the contour tile without lines; other failures fail the tile.
   */
  override fetchDem(...args: Parameters<FetchDem>): ReturnType<FetchDem> {
    const abort = args[4];
    return super.fetchDem(...args).catch((error: unknown) => {
      if (aborted(abort, error) || !this.tolerate(error)) throw error;
      return undefined as unknown as HeightTile;
    });
  }

  /**
   * No contour levels at this zoom: an empty tile, without fetching any DEM.
   * Otherwise the tile's own elevation must load (or the tile fails and
   * MapLibre may ask again later). A tile traced with a missing neighbor is
   * not kept in the library's cache, so it is traced again once the neighbor
   * can load.
   */
  override async fetchContourTile(...args: Parameters<FetchContourTile>): Promise<Awaited<ReturnType<FetchContourTile>>> {
    const [z, x, y, options, abort, timer] = args;
    if (!options.levels || options.levels.length === 0) return { arrayBuffer: new ArrayBuffer(0) };
    await super.fetchDem(z, x, y, options, abort, timer);
    const tile = await super.fetchContourTile(...args);
    let gapped = false;
    for (let dy = -1; dy <= 1 && !gapped; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const ny = y + dy;
        if ((dx || dy) && ny >= 0 && ny < 1 << z && this.failedRecently(z, x + dx, ny, options.overzoom)) {
          gapped = true;
          break;
        }
      }
    }
    if (gapped) {
      for (const key of [...this.contourCache.items.keys()]) if (key.startsWith(`${z}/${x}/${y}/`)) this.contourCache.items.delete(key);
    }
    return tile;
  }

  /** Forgets traced tiles and remembered failures (back online: trace gapped edges again). */
  reset() {
    this.failures.clear();
    this.contourCache.clear();
  }
}

let source: InstanceType<typeof mlcontour.DemSource> | null = null;
let manager: FieldlineDemManager | null = null;

/** Registers the contour protocol once. `demTemplate` is the app's `/api/dem/{z}/{x}/{y}` URL. */
export function installContourProtocol(ml: { addProtocol: typeof import("maplibre-gl").addProtocol }, demTemplate: string) {
  if (source) return;
  const next = new mlcontour.DemSource({ url: demTemplate, id: "fieldline-dem", worker: false, cacheSize: CACHE_SIZE, encoding: "terrarium", maxzoom: DEM_MAX_ZOOM, timeoutMs: TIMEOUT_MS });
  manager = new FieldlineDemManager({ demTemplate });
  next.manager = manager;
  next.setupMaplibre(ml as unknown as Parameters<typeof next.setupMaplibre>[0]);
  source = next;
}

/** Tile URL template of the contour source for a unit and interval detail. */
export function contourTilesUrl(unit: ElevationUnit, detail: ContourDetail): string {
  if (!source) throw new Error("Contour protocol not installed");
  return source.contourProtocolUrl(contourTileOptions(unit, detail));
}

/** Clears traced tiles and remembered failures, e.g. when the network comes back. */
export function resetContours() {
  manager?.reset();
}
