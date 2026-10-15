import type { ExpressionSpecification } from "maplibre-gl";

/**
 * Contour lines (MAP-03), generated in the browser from the same terrain DEM
 * the relief uses (AWS Terrain Tiles through `/api/dem`, read through
 * `fltile://`, so downloaded areas draw contours offline). Pure helpers here;
 * the tile generator is `contour-source.ts`.
 *
 * Intervals follow the user's elevation unit: feet use 20/40/100/200/500 ft
 * steps, meters 10/20/50/100/200 m. Every fifth line is an index line and
 * carries a label. Lines are a rendering of a ~10–30 m elevation model, not a
 * survey: fine intervals can show model noise in flat ground.
 */
export type ElevationUnit = "ft" | "m";
export type ContourDetail = "coarse" | "standard" | "fine";

/** [minor, index] interval by map zoom (512-pixel zoom), standard detail. */
const INTERVALS: Record<ElevationUnit, Record<number, [number, number]>> = {
  ft: { 10: [500, 2500], 11: [200, 1000], 12: [100, 500], 13: [40, 200], 14: [20, 100] },
  m: { 10: [200, 1000], 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] },
};

/** Coarse moves every interval one zoom later; fine one zoom earlier. */
const DETAIL_SHIFT: Record<ContourDetail, number> = { coarse: -1, standard: 0, fine: 1 };

export const FEET_PER_METER = 3.28084;

/**
 * Contour tiles are ordinary 512-pixel vector tiles requested at the map
 * zoom, each traced from the 256-pixel DEM tile with the same z/x/y (and its
 * neighbors): two screen pixels per DEM pixel, which keeps lines smooth
 * enough for labels to follow them. Offline packages hold terrain tiles from
 * one zoom below to one zoom above the package's map zooms
 * (`mapZoomTileRange` in src/lib/offline/sources.ts), so this zoom is always
 * packaged. (MapLibre 6.13 does not load a vector source declared with
 * 256-pixel tiles, so the one-deeper zoom the hillshade uses isn't an option
 * without a mosaic; a 2×2 mosaic at one DEM pixel per screen pixel was tried
 * and gave stair-stepped lines that labels could not follow.)
 */
export const CONTOUR_TILE_ZOOM_OFFSET = 0;
export const DEM_ZOOM_OFFSET = 0;
/** Deepest DEM tile (AWS Terrain Tiles z14). */
export const DEM_MAX_ZOOM = 14;
/** Deepest contour tile: z15 splits the z14 DEM tile (smoothed by the library); MapLibre overzooms past it. */
export const CONTOUR_SOURCE_MAX_ZOOM = DEM_MAX_ZOOM + 1;
/** No contour layer below this map zoom (lines would merge into a smudge). */
export const CONTOUR_MIN_MAP_ZOOM = 9;

export const CONTOUR_LAYER = "contours";

/** maplibre-contour tile options (its `GlobalContourTileOptions`): thresholds keyed by tile zoom. */
export type ContourTileOptions = {
  thresholds: Record<number, [number, number]>;
  multiplier: number;
  contourLayer: string;
  elevationKey: string;
  levelKey: string;
  extent: number;
  buffer: number;
};

/** The [minor, index] interval used at a map zoom, or null where no contours draw. */
export function contourIntervalAt(mapZoom: number, unit: ElevationUnit, detail: ContourDetail): [number, number] | null {
  const table = INTERVALS[unit];
  const zooms = Object.keys(table).map(Number).sort((a, b) => a - b);
  // The table entry for (zoom + shift), capped at the finest interval.
  const lookup = Math.min(Math.floor(mapZoom) + DETAIL_SHIFT[detail], zooms[zooms.length - 1]);
  let found: [number, number] | null = null;
  for (const z of zooms) if (z <= lookup) found = table[z];
  return found;
}

/** Thresholds keyed by contour tile zoom (the map zoom), for the tile generator. */
export function contourThresholds(unit: ElevationUnit, detail: ContourDetail): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  for (let mapZoom = CONTOUR_MIN_MAP_ZOOM; mapZoom <= CONTOUR_SOURCE_MAX_ZOOM - CONTOUR_TILE_ZOOM_OFFSET; mapZoom += 1) {
    const interval = contourIntervalAt(mapZoom, unit, detail);
    if (interval) out[mapZoom + CONTOUR_TILE_ZOOM_OFFSET] = interval;
  }
  return out;
}

export function contourTileOptions(unit: ElevationUnit, detail: ContourDetail): ContourTileOptions {
  return {
    thresholds: contourThresholds(unit, detail),
    // Lines at whole feet when the unit is feet: the DEM's meters are scaled before tracing.
    multiplier: unit === "ft" ? FEET_PER_METER : 1,
    contourLayer: CONTOUR_LAYER,
    elevationKey: "ele",
    levelKey: "level",
    extent: 4096,
    buffer: 1,
  };
}

/**
 * Index-line label: the elevation in the user's unit ("6200"), without the
 * unit, as on printed topo maps. A unit suffix makes labels longer, and fewer
 * fit along curving lines (measured in docs/map-design.md); the unit is
 * stated in the Layers panel's interval line and on peak labels.
 */
export function contourLabel(): ExpressionSpecification {
  return ["to-string", ["get", "ele"]];
}

/** True for index lines (every fifth contour). */
export const INDEX_LINE: ExpressionSpecification = [">", ["coalesce", ["get", "level"], 0], 0];

/** Human-readable interval for the Layers panel, e.g. "40 ft lines, index every 200 ft". */
export function contourIntervalText(mapZoom: number, unit: ElevationUnit, detail: ContourDetail): string {
  const interval = contourIntervalAt(mapZoom, unit, detail);
  if (!interval) return "Zoom in to see contours.";
  return `${interval[0]} ${unit} lines, index every ${interval[1]} ${unit} at this zoom.`;
}

/**
 * Light smoothing of a decoded DEM tile before tracing: `passes` rounds of a
 * separable [1 2 1]/4 kernel, clamped at the tile edge (both sides of a tile
 * seam read the same smoothed tile, so lines still meet). Raw 2-pixel DEM
 * steps make contour lines zigzag, which looks noisy and leaves line labels
 * nowhere to sit. Only the contour drawing uses this copy; relief, 3D terrain
 * and elevation readouts keep the DEM values.
 */
export function smoothElevation(tile: { width: number; height: number; data: Float32Array }, passes = 1) {
  const { width, height } = tile;
  let src = tile.data;
  let tmp = new Float32Array(src.length);
  for (let pass = 0; pass < passes; pass += 1) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const left = src[row + Math.max(0, x - 1)];
        const right = src[row + Math.min(width - 1, x + 1)];
        tmp[row + x] = (left + 2 * src[row + x] + right) / 4;
      }
    }
    for (let y = 0; y < height; y += 1) {
      const up = Math.max(0, y - 1) * width;
      const down = Math.min(height - 1, y + 1) * width;
      const row = y * width;
      for (let x = 0; x < width; x += 1) out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) / 4;
    }
    src = out;
    tmp = new Float32Array(src.length);
  }
  return { width, height, data: src };
}
