/**
 * Browser-only contour tile generator (MAP-03). Uses maplibre-contour
 * (BSD-3-Clause, pinned) to trace isolines from the terrain DEM and encode
 * them as vector tiles behind a MapLibre protocol.
 *
 * DEM tiles are read through Fieldline's own `fltile://` handler (`loadTile`),
 * never with the library's plain `fetch`: offline packages first, then the
 * network. A 512-pixel contour tile at z/x/y is traced from the 256-pixel
 * DEM tile z/x/y and its neighbors: the terrain zoom 3D terrain requests and
 * offline packages hold for that map zoom (docs/storage.md), so a downloaded
 * area draws contours offline. Online these are extra DEM requests next to
 * the hillshade's (which are one zoom deeper); see docs/map-design.md.
 * DEM tiles are smoothed lightly before tracing (`smoothElevation`): a copy
 * for drawing only.
 *
 * Runs on the main thread (the library's worker mode fetches on its own and
 * would bypass offline packages). Work per tile is bounded by the tile size
 * and the caches below; see docs/map-design.md for measured cost.
 */
import mlcontour from "maplibre-contour";
import { cachedTile, loadTile } from "@/lib/hunt/tiles";
import { contourTileOptions, DEM_MAX_ZOOM, smoothElevation, type ContourDetail, type ElevationUnit } from "./contours";

type LocalDemManager = InstanceType<typeof mlcontour.LocalDemManager>;
type FetchDem = LocalDemManager["fetchDem"];
type FetchContourTile = LocalDemManager["fetchContourTile"];

/** Parsed DEM tiles kept in memory (each 256×256 float32 = 256 KB), per cache. */
const CACHE_SIZE = 80;
const TIMEOUT_MS = 15_000;
const SMOOTHING_PASSES = 2;

/** DEM tile bytes through `fltile://`: offline package, then network. */
async function getTile(url: string, abort: AbortController) {
  const { data } = await loadTile({ url: cachedTile(url), type: "arrayBuffer" }, abort);
  return { data: new Blob([data as ArrayBuffer], { type: "image/png" }) };
}

type HeightTile = Awaited<ReturnType<FetchDem>>;

class FieldlineDemManager extends mlcontour.LocalDemManager {
  constructor(options: ConstructorParameters<typeof mlcontour.LocalDemManager>[0]) {
    super(options);
    const decode = this.decodeImage;
    // Smoothed once per DEM tile; the library caches the decoded result.
    this.decodeImage = async (...args) => smoothElevation(await decode(...args), SMOOTHING_PASSES);
  }

  /**
   * Called for the tile and its eight neighbors. A neighbor that can't load
   * (the edge of a downloaded area while offline) only leaves that edge of
   * the contour tile without lines.
   */
  override fetchDem(...args: Parameters<FetchDem>): ReturnType<FetchDem> {
    const abort = args[4];
    return super.fetchDem(...args).catch((error: unknown) => {
      if (abort.signal.aborted) throw error;
      return undefined as unknown as HeightTile;
    });
  }

  /** The tile's own elevation must load; otherwise the tile fails and MapLibre may ask again later. */
  override fetchContourTile(...args: Parameters<FetchContourTile>): ReturnType<FetchContourTile> {
    const [z, x, y, options, abort, timer] = args;
    return super.fetchDem(z, x, y, options, abort, timer).then(() => super.fetchContourTile(...args));
  }
}

let source: InstanceType<typeof mlcontour.DemSource> | null = null;

/** Registers the contour protocol once. `demTemplate` is the app's `/api/dem/{z}/{x}/{y}` URL. */
export function installContourProtocol(ml: { addProtocol: typeof import("maplibre-gl").addProtocol }, demTemplate: string) {
  if (source) return;
  const options = { cacheSize: CACHE_SIZE, encoding: "terrarium" as const, maxzoom: DEM_MAX_ZOOM, timeoutMs: TIMEOUT_MS };
  const next = new mlcontour.DemSource({ url: demTemplate, id: "fieldline-dem", worker: false, ...options });
  next.manager = new FieldlineDemManager({ demUrlPattern: demTemplate, getTile, ...options });
  next.setupMaplibre(ml as unknown as Parameters<typeof next.setupMaplibre>[0]);
  source = next;
}

/** Tile URL template of the contour source for a unit and interval detail. */
export function contourTilesUrl(unit: ElevationUnit, detail: ContourDetail): string {
  if (!source) throw new Error("Contour protocol not installed");
  return source.contourProtocolUrl(contourTileOptions(unit, detail));
}
