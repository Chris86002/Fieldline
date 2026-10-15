import type { ColorReliefLayerSpecification, ExpressionSpecification, FilterSpecification, HillshadeLayerSpecification, LayerSpecification } from "maplibre-gl";
import type { Basemap } from "@/lib/hunt/types";
import { CONTOUR_LAYER, CONTOUR_MIN_MAP_ZOOM, contourLabel, INDEX_LINE } from "./contours.ts";
import { orderLayers, type GroupedLayers, type RenderGroup } from "./layer-groups.ts";
import { LABEL_LAYER_IDS, labelRules, type LabelDensity, type LabelLayerId } from "./labels.ts";
import { BOUNDARY_WEIGHTS, isVectorBase, reliefPaint, styleFamily, tokensFor, type BoundaryStrength, type LineToken, type MapTokens } from "./tokens.ts";

/**
 * The layer list of the Fieldline map style, as named render groups (MAP-01).
 * Sources (and their attribution) are defined in MapCanvas; every layer here
 * keeps a stable id that MapCanvas toggles and repaints by name.
 */
export type StyleOptions = {
  basemap: Basemap;
  showPublic: boolean;
  showLabels: boolean;
  showRoads: boolean;
  showTracks: boolean;
  showCreeks: boolean;
  showPeaks: boolean;
  showShade: boolean;
  showBorder: boolean;
  publicOpacity: number;
  boundaryStrength: BoundaryStrength;
  labelDensity: LabelDensity;
  /** Contours for the current style (see `contoursShown`); never drawn over the USGS topo scan. */
  showContours: boolean;
  /** Multiplier on contour opacity (1 = the style's own weight). */
  contourStrength: number;
  /** Land-cover fills on the vector styles (Terrain, Field). */
  showLandCover: boolean;
};

export const BASE_RASTERS = ["satellite", "usgs", "topo"] as const;
/** Water fills of the vector styles. */
export const WATER_FILLS = ["vx-water"] as const;
/** Land-cover fills of the vector styles, toggled together. */
export const LAND_COVER_LAYERS = ["vx-landcover", "vx-wood", "vx-landuse", "vx-park"] as const;
export const CONTOUR_LAYERS = ["contours", "contour-labels"] as const;
export const ROAD_LINE_LAYERS = ["vx-local-casing", "vx-local", "vx-highway-casing", "vx-highway", "vx-freeway-casing", "vx-freeway"] as const;
export const TRACK_LAYERS = ["vx-track-casing", "vx-track"] as const;
export const CREEK_LAYERS = ["vx-creek-line", "vx-creek"] as const;
export const ROAD_NAME_LAYERS = ["vx-road-major", "vx-road-minor", "vx-shield"] as const;
export const TOWN_LAYERS = ["vx-place-city", "vx-place-town", "vx-place-small"] as const;
export const PEAK_LAYERS = ["vx-peak"] as const;
export const UNIT_LINE_LAYERS = ["units-casing", "units-line"] as const;
export const BORDER_LAYERS = ["border-casing", "border-line"] as const;

/** Layers whose paint MapCanvas must not reset when it repaints for a style change. */
export const DYNAMIC_PAINT_LAYERS = ["hillshade"] as const;

/**
 * Visibility of every layer the style options control, by id. MapCanvas
 * applies the same table at runtime, so a toggle never rebuilds the style
 * and the built style and the live map can't disagree. Unit lines, unit
 * labels and state lines are switched by their own data-driven effects.
 */
export function styleVisibility(o: StyleOptions): Record<string, boolean> {
  const imagery = o.basemap === "satellite";
  const vectorBase = isVectorBase(o.basemap);
  // The topo scan already prints roads, names and contours: no vector duplicates over it.
  const vector = o.basemap !== "topo";
  const cover = vectorBase && o.showLandCover;
  const contours = vector && o.showContours;
  const out: Record<string, boolean> = {
    satellite: imagery,
    usgs: o.basemap === "usgs",
    topo: o.basemap === "topo",
    "terrain-tint": o.basemap === "terrain" && tokensFor(o.basemap).tint !== null,
    "vx-water": vectorBase,
    "vx-landcover": cover,
    "vx-wood": cover,
    "vx-landuse": cover,
    // Parks and protected areas: Terrain only. Field keeps fewer classes; public land shows ownership.
    "vx-park": cover && o.basemap === "terrain",
    hillshade: o.showShade && o.basemap !== "topo",
    contours,
    "contour-labels": contours,
    sma: o.showPublic,
  };
  for (const id of [...ROAD_LINE_LAYERS, ...ROAD_NAME_LAYERS]) out[id] = vector && o.showRoads;
  for (const id of TRACK_LAYERS) out[id] = vector && o.showTracks;
  for (const id of CREEK_LAYERS) out[id] = vector && o.showCreeks;
  for (const id of TOWN_LAYERS) out[id] = vector && o.showLabels;
  for (const id of PEAK_LAYERS) out[id] = vector && o.showPeaks;
  return out;
}

/** Country and state lines (OpenMapTiles admin levels 2 and 4), without maritime boundaries. */
const STATE_LINE_FILTER: ExpressionSpecification = ["all", ["<=", ["get", "admin_level"], 4], ["!=", ["coalesce", ["get", "maritime"], 0], 1]];

/** OpenMapTiles `path` subclasses that are town infrastructure rather than trails. */
export const URBAN_PATH_SUBCLASSES = ["footway", "pedestrian", "steps", "cycleway", "sidewalk", "crossing", "corridor", "platform"] as const;

const NAME_FIELD: ExpressionSpecification = ["coalesce", ["get", "name_en"], ["get", "name"]];
/** OpenMapTiles `rank`: lower is more important, so it is placed first. */
const RANK_SORT: ExpressionSpecification = ["coalesce", ["to-number", ["get", "rank"]], 99];

function vis(on: boolean): "visible" | "none" {
  return on ? "visible" : "none";
}

function lineGeom(): ExpressionSpecification {
  return ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
}

function roadFilter(classes: string[]): ExpressionSpecification {
  return ["all", lineGeom(), ["match", ["get", "class"], classes, true, false], ["!=", ["get", "brunnel"], "tunnel"]];
}

function nameFilter(classes: string[]): ExpressionSpecification {
  return ["all", lineGeom(), ["match", ["get", "class"], classes, true, false], ["has", "name"]];
}

/** Zoom-interpolated width from [zoom, width, zoom, width, ...] stops, scaled by `factor`. */
export function zoomWidth(stops: number[], factor = 1, curve: "exponential" | "linear" = "exponential"): ExpressionSpecification {
  const expr: unknown[] = ["interpolate", curve === "linear" ? ["linear"] : ["exponential", 1.35], ["zoom"]];
  for (let i = 0; i < stops.length; i += 2) expr.push(stops[i], Math.round(stops[i + 1] * factor * 100) / 100);
  return expr as ExpressionSpecification;
}

function cap(value: number): number {
  return Math.min(1, Math.round(value * 100) / 100);
}

function casingPaint(token: LineToken, stops: number[], width = 1, opacity = 1, curve: "exponential" | "linear" = "exponential") {
  return { "line-color": token.casing, "line-width": zoomWidth(stops, width, curve), "line-opacity": cap(token.casingOpacity * opacity) };
}

function linePaint(token: LineToken, stops: number[], width = 1, opacity = 1, curve: "exponential" | "linear" = "exponential") {
  return { "line-color": token.line, "line-width": zoomWidth(stops, width, curve), "line-opacity": cap(token.lineOpacity * opacity) };
}

function labelPaint(t: MapTokens, color = t.label.text, width = t.label.haloWidth) {
  return { "text-color": color, "text-halo-color": t.label.halo, "text-halo-width": width, "text-halo-blur": 0.15 };
}

const PLACE_LAYOUT = { "text-pitch-alignment": "viewport", "text-rotation-alignment": "viewport" } as const;
const LINE_LABEL_LAYOUT = { "symbol-placement": "line", "text-pitch-alignment": "viewport" } as const;

/** OpenMapTiles `landcover` classes drawn by `vx-landcover` (`wood` has its own layer, `vx-wood`). */
export const LAND_COVER_CLASSES = ["grass", "wetland", "rock", "sand", "ice", "farmland"] as const;
/** OpenMapTiles `grass` subclasses that are shrub or brush rather than grassland. */
export const SHRUB_SUBCLASSES = ["scrub", "heath", "fell"] as const;
/** OpenMapTiles `landuse` classes drawn as built-up land. */
export const DEVELOPED_CLASSES = ["residential", "commercial", "industrial", "retail", "railway", "quarry"] as const;

/** Elevation tint ramp; transparent for families without a tint (the layer is hidden there anyway). */
function tintColor(t: MapTokens): ExpressionSpecification {
  const stops = t.tint?.stops ?? [
    [0, "rgba(0, 0, 0, 0)"],
    [1, "rgba(0, 0, 0, 0)"],
  ];
  return ["interpolate", ["linear"], ["elevation"], ...stops.flat()] as ExpressionSpecification;
}

function baseLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const shown = styleVisibility(o);
  const v = (id: string) => vis(shown[id] ?? false);
  const raster = { "raster-resampling": "linear", "raster-fade-duration": 0 } as const;
  const cover = t.landcover;
  return [
    { id: "land", type: "background", paint: { "background-color": t.land } },
    { id: "satellite", type: "raster", source: "satellite", layout: { visibility: v("satellite") }, paint: { "raster-opacity": 1, ...raster } },
    { id: "usgs", type: "raster", source: "usgs", layout: { visibility: v("usgs") }, paint: { ...raster } },
    { id: "topo", type: "raster", source: "topo", layout: { visibility: v("topo") }, paint: { ...raster } },
    // Restrained elevation tint (Terrain) on the land, under the land cover. Display only.
    {
      id: "terrain-tint",
      type: "color-relief",
      source: "dem",
      layout: { visibility: v("terrain-tint") },
      paint: { "color-relief-opacity": t.tint?.opacity ?? 0, "color-relief-color": tintColor(t) } as ColorReliefLayerSpecification["paint"],
    },
    // Land cover where OpenStreetMap maps it; unmapped ground keeps the land color (no inferred classes).
    {
      id: "vx-landcover",
      type: "fill",
      source: "ofm",
      "source-layer": "landcover",
      filter: ["match", ["get", "class"], [...LAND_COVER_CLASSES], true, false],
      layout: { visibility: v("vx-landcover") },
      paint: {
        "fill-color": [
          "match",
          ["get", "class"],
          "grass",
          ["match", ["get", "subclass"], [...SHRUB_SUBCLASSES], cover.scrub, cover.grass],
          "wetland",
          cover.wetland,
          "rock",
          cover.rock,
          "sand",
          cover.sand,
          "ice",
          cover.ice,
          "farmland",
          cover.farmland,
          t.land,
        ],
        "fill-opacity": cover.opacity,
      },
    },
    {
      id: "vx-wood",
      type: "fill",
      source: "ofm",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      layout: { visibility: v("vx-wood") },
      paint: { "fill-color": t.vegetation, "fill-opacity": cover.opacity },
    },
    {
      id: "vx-landuse",
      type: "fill",
      source: "ofm",
      "source-layer": "landuse",
      minzoom: 9,
      filter: ["match", ["get", "class"], [...DEVELOPED_CLASSES], true, false],
      layout: { visibility: v("vx-landuse") },
      paint: { "fill-color": cover.developed, "fill-opacity": cover.opacity },
    },
    { id: "vx-park", type: "fill", source: "ofm", "source-layer": "park", layout: { visibility: v("vx-park") }, paint: { "fill-color": t.park, "fill-opacity": 0.3 } },
    { id: "vx-water", type: "fill", source: "ofm", "source-layer": "water", layout: { visibility: v("vx-water") }, paint: { "fill-color": t.water } },
  ];
}

/** Contour line paint: index lines heavier and stronger than minor lines. */
export function contourPaint(t: MapTokens, strength: number) {
  const c = t.contour;
  return {
    "line-color": ["case", INDEX_LINE, c.index, c.minor] as ExpressionSpecification,
    "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", INDEX_LINE, 0.8, 0.4], 13, ["case", INDEX_LINE, 1.2, 0.6], 16, ["case", INDEX_LINE, 1.8, 0.9]] as ExpressionSpecification,
    "line-opacity": ["case", INDEX_LINE, cap(c.indexOpacity * strength), cap(c.minorOpacity * strength)] as ExpressionSpecification,
  };
}

function reliefLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const shown = styleVisibility(o);
  return [
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      layout: { visibility: vis(shown.hillshade) },
      paint: reliefPaint(o.basemap, null, null) as HillshadeLayerSpecification["paint"],
    },
    // Contours traced from the terrain DEM (contour-source.ts); own visibility, independent of relief and 3D.
    {
      id: "contours",
      type: "line",
      source: "contours",
      "source-layer": CONTOUR_LAYER,
      minzoom: CONTOUR_MIN_MAP_ZOOM,
      layout: { visibility: vis(shown.contours), "line-join": "round", "line-cap": "round" },
      paint: contourPaint(t, o.contourStrength),
    },
  ];
}

function thematicLayers(o: StyleOptions): LayerSpecification[] {
  return [
    {
      id: "sma",
      type: "raster",
      source: "sma",
      layout: { visibility: vis(o.showPublic) },
      paint: { "raster-opacity": o.publicOpacity, "raster-resampling": "linear", "raster-fade-duration": 0 },
    },
  ];
}

function detailLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const shown = styleVisibility(o);
  const roadVis = vis(shown["vx-local"]);
  const trackVis = vis(shown["vx-track"]);
  const creekVis = vis(shown["vx-creek-line"]);
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const { freeway, highway, minor } = t.roads;
  const local = roadFilter(["tertiary", "minor", "service", "unclassified"]);
  const major = roadFilter(["primary", "secondary"]);
  const motorway = roadFilter(["motorway", "trunk"]);
  const trails = roadFilter(["track", "path"]);
  // Sidewalks, footways and cycleways share the OpenMapTiles "path" class; keep them quiet so towns don't fill with trail symbols.
  const urbanPath: ExpressionSpecification = ["match", ["get", "subclass"], [...URBAN_PATH_SUBCLASSES], true, false];
  const backcountry: ExpressionSpecification = ["all", trails, ["!", urbanPath]];
  const trailWidth = [12, 0.8, 14, 1.6, 17, 2.8];
  return [
    {
      id: "vx-creek-line",
      type: "line",
      source: "ofm",
      "source-layer": "waterway",
      minzoom: 11,
      filter: ["match", ["get", "class"], ["river", "stream", "canal"], true, false],
      layout: { visibility: creekVis, ...round },
      paint: { "line-color": t.waterway, "line-width": zoomWidth([11, 0.4, 14, 1.15, 17, 2.2]), "line-opacity": 0.85 },
    },
    // Local roads first, then trails above them, then the quieter major roads on top at crossings.
    { id: "vx-local-casing", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 11, filter: local, layout: { visibility: roadVis, ...round }, paint: casingPaint(minor, [11, 1, 14, 3, 17, 7]) },
    { id: "vx-local", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 11, filter: local, layout: { visibility: roadVis, ...round }, paint: linePaint(minor, [11, 0.4, 14, 1.5, 17, 4.2]) },
    {
      id: "vx-track-casing",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 12,
      filter: backcountry,
      layout: { visibility: trackVis, ...round },
      paint: casingPaint(t.trail, trailWidth, 2.1),
    },
    {
      id: "vx-track",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 12,
      filter: trails,
      layout: { visibility: trackVis, "line-cap": "butt", "line-join": "round" },
      paint: {
        ...linePaint(t.trail, trailWidth),
        // Sidewalks fainter still on the light vector styles, where the dark trail color crowded town grids.
        "line-opacity": ["case", urbanPath, cap(t.trail.lineOpacity * (t.family === "terrain" || t.family === "field" ? 0.3 : 0.5)), t.trail.lineOpacity],
        "line-dasharray": [1.4, 1.1],
      },
    },
    { id: "vx-highway-casing", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 7, filter: major, layout: { visibility: roadVis, ...round }, paint: casingPaint(highway, [7, 1.1, 10, 2.1, 14, 4.4, 17, 8]) },
    { id: "vx-highway", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 7, filter: major, layout: { visibility: roadVis, ...round }, paint: linePaint(highway, [7, 0.5, 10, 1.1, 14, 2.6, 17, 5.2]) },
    { id: "vx-freeway-casing", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 5, filter: motorway, layout: { visibility: roadVis, ...round }, paint: casingPaint(freeway, [5, 1.4, 8, 2.5, 12, 5, 16, 9.5]) },
    { id: "vx-freeway", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 5, filter: motorway, layout: { visibility: roadVis, ...round }, paint: linePaint(freeway, [5, 0.7, 8, 1.4, 12, 3, 16, 6.4]) },
  ];
}

function boundaryLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const w = BOUNDARY_WEIGHTS[o.boundaryStrength];
  const round = { "line-join": "round", "line-cap": "round" } as const;
  const border = { ...round, visibility: vis(o.showBorder) };
  return [
    { id: "units-casing", type: "line", source: "units", layout: round, paint: casingPaint(t.unit, [5, 2.2, 8, 3.2, 12, 4.8], w.width, w.casing, "linear") },
    { id: "units-line", type: "line", source: "units", layout: round, paint: linePaint(t.unit, [5, 1, 8, 1.6, 12, 2.4], w.width, w.line, "linear") },
    // State and national lines for every state, from the OpenFreeMap (OpenMapTiles) boundary layer.
    // Sea boundaries are left out; these are reference lines, not legal boundaries.
    {
      id: "border-casing",
      type: "line",
      source: "ofm",
      "source-layer": "boundary",
      filter: STATE_LINE_FILTER,
      layout: border,
      paint: casingPaint(t.state, [4, 2.6, 7, 4, 11, 5.4], w.width, w.casing, "linear"),
    },
    {
      id: "border-line",
      type: "line",
      source: "ofm",
      "source-layer": "boundary",
      filter: STATE_LINE_FILTER,
      layout: border,
      paint: linePaint(t.state, [4, 1.2, 7, 1.9, 11, 2.7], w.width, w.line, "linear"),
    },
  ];
}

/**
 * A label size scaled by the style's text scale: a number, or the output stops
 * of a `["interpolate", curve, ["zoom"], z, size, ...]` expression.
 */
export function scaledSize(size: number | unknown[], scale: number): number | ExpressionSpecification {
  const round = (value: number) => Math.round(value * scale * 10) / 10;
  if (typeof size === "number") return round(size);
  const out = [...size];
  for (let i = 4; i < out.length; i += 2) out[i] = round(out[i] as number);
  return out as ExpressionSpecification;
}

/** Text sizes of the ordinary labels, before the style's text scale. */
export const LABEL_SIZES: Record<LabelLayerId, number | unknown[]> = {
  "contour-labels": 10.5,
  "vx-road-minor": 12,
  "vx-road-major": ["interpolate", ["linear"], ["zoom"], 11, 11.5, 15, 13],
  "vx-shield": 11,
  "vx-place-small": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 14],
  "vx-creek": 12,
  "vx-peak": ["interpolate", ["linear"], ["zoom"], 11, 11.5, 15, 13],
  "vx-place-town": ["interpolate", ["linear"], ["zoom"], 7, 12, 11, 15, 14, 17],
  "vx-place-city": ["interpolate", ["linear"], ["zoom"], 4, 12, 8, 16, 12, 20],
  "unit-labels": ["interpolate", ["linear"], ["zoom"], 8, 11.5, 11, 13, 14, 15],
};

function labelLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const shown = styleVisibility(o);
  const roadVis = vis(shown["vx-road-minor"]);
  const creekVis = vis(shown["vx-creek"]);
  const peakVis = vis(shown["vx-peak"]);
  const townVis = vis(shown["vx-place-town"]);
  const rules = labelRules(o.labelDensity);
  const zoomOf = (id: LabelLayerId) => rules[id].minzoom;
  const pad = (id: LabelLayerId) => rules[id].padding;
  const spacing = (id: LabelLayerId) => rules[id].spacing ?? 250;
  const size = (id: LabelLayerId) => scaledSize(LABEL_SIZES[id], t.textScale);
  const byId: Record<LabelLayerId, LayerSpecification> = {
    // Elevations on index contours, along the line.
    "contour-labels": {
      id: "contour-labels",
      type: "symbol",
      source: "contours",
      "source-layer": CONTOUR_LAYER,
      minzoom: zoomOf("contour-labels"),
      filter: INDEX_LINE as FilterSpecification,
      layout: {
        visibility: vis(shown["contour-labels"]),
        ...LINE_LABEL_LAYOUT,
        "symbol-spacing": spacing("contour-labels"),
        "text-field": contourLabel(),
        "text-font": ["Noto Sans Regular"],
        "text-size": size("contour-labels"),
        "text-padding": pad("contour-labels"),
        // Contours curve more than roads; 60° lets labels sit on gently bending lines.
        "text-max-angle": 60,
        "text-rotation-alignment": "map",
      },
      paint: { "text-color": t.contour.label, "text-halo-color": t.contour.halo, "text-halo-width": 1.4, "text-halo-blur": 0.15 },
    },
    "vx-road-minor": {
      id: "vx-road-minor",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: zoomOf("vx-road-minor"),
      filter: nameFilter(["minor", "service", "track"]),
      layout: {
        visibility: roadVis,
        ...LINE_LABEL_LAYOUT,
        "symbol-spacing": spacing("vx-road-minor"),
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": size("vx-road-minor"),
        "text-padding": pad("vx-road-minor"),
        "text-rotation-alignment": "map",
      },
      paint: labelPaint(t, t.label.text, 1.5),
    },
    "vx-road-major": {
      id: "vx-road-major",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: zoomOf("vx-road-major"),
      filter: nameFilter(["motorway", "trunk", "primary", "secondary", "tertiary"]),
      layout: {
        visibility: roadVis,
        ...LINE_LABEL_LAYOUT,
        "symbol-spacing": spacing("vx-road-major"),
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": size("vx-road-major"),
        "text-padding": pad("vx-road-major"),
        "text-rotation-alignment": "map",
      },
      paint: labelPaint(t),
    },
    "vx-shield": {
      id: "vx-shield",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: zoomOf("vx-shield"),
      filter: ["all", lineGeom(), ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false], ["has", "ref"]],
      layout: {
        visibility: roadVis,
        ...LINE_LABEL_LAYOUT,
        "symbol-spacing": spacing("vx-shield"),
        "text-field": ["to-string", ["get", "ref"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": size("vx-shield"),
        "text-padding": pad("vx-shield"),
      },
      paint: labelPaint(t, t.label.text, 1.8),
    },
    "vx-place-small": {
      id: "vx-place-small",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: zoomOf("vx-place-small"),
      filter: ["match", ["get", "class"], ["village", "hamlet", "suburb", "neighbourhood"], true, false],
      layout: {
        visibility: townVis,
        ...PLACE_LAYOUT,
        "symbol-sort-key": RANK_SORT,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": size("vx-place-small"),
        "text-padding": pad("vx-place-small"),
      },
      paint: labelPaint(t, t.label.text, 1.5),
    },
    "vx-creek": {
      id: "vx-creek",
      type: "symbol",
      source: "ofm",
      "source-layer": "waterway",
      minzoom: zoomOf("vx-creek"),
      filter: ["all", lineGeom(), ["has", "name"]],
      layout: {
        visibility: creekVis,
        ...LINE_LABEL_LAYOUT,
        "symbol-spacing": spacing("vx-creek"),
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Italic"],
        "text-size": size("vx-creek"),
        "text-letter-spacing": 0.04,
        "text-padding": pad("vx-creek"),
      },
      paint: labelPaint(t, t.waterway, 1.4),
    },
    "vx-peak": {
      id: "vx-peak",
      type: "symbol",
      source: "ofm",
      "source-layer": "mountain_peak",
      minzoom: zoomOf("vx-peak"),
      filter: ["has", "name"],
      layout: {
        visibility: peakVis,
        ...PLACE_LAYOUT,
        "symbol-sort-key": RANK_SORT,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": size("vx-peak"),
        "text-padding": pad("vx-peak"),
        "text-offset": [0, 0.6],
      },
      paint: labelPaint(t, t.label.text, 1.5),
    },
    "vx-place-town": {
      id: "vx-place-town",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: zoomOf("vx-place-town"),
      filter: ["==", ["get", "class"], "town"],
      layout: {
        visibility: townVis,
        ...PLACE_LAYOUT,
        "symbol-sort-key": RANK_SORT,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Bold"],
        "text-size": size("vx-place-town"),
        "text-padding": pad("vx-place-town"),
      },
      paint: labelPaint(t),
    },
    "vx-place-city": {
      id: "vx-place-city",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: zoomOf("vx-place-city"),
      filter: ["==", ["get", "class"], "city"],
      layout: {
        visibility: townVis,
        ...PLACE_LAYOUT,
        "symbol-sort-key": RANK_SORT,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Bold"],
        "text-size": size("vx-place-city"),
        "text-padding": pad("vx-place-city"),
        "text-letter-spacing": 0.02,
      },
      paint: labelPaint(t, t.label.text, 1.7),
    },
    // Unit numbers: collision-managed (no forced overlap) and top priority among ordinary labels.
    "unit-labels": {
      id: "unit-labels",
      type: "symbol",
      source: "unit-labels",
      minzoom: zoomOf("unit-labels"),
      layout: {
        "text-field": ["get", "code"],
        "text-font": ["Noto Sans Bold"],
        "text-size": size("unit-labels"),
        "text-padding": pad("unit-labels"),
      },
      paint: { "text-color": t.unitLabel.text, "text-halo-color": t.unitLabel.halo, "text-halo-width": 1.5 },
    },
  };
  // The labels group is ordered by priority: last drawn is placed first.
  return LABEL_LAYER_IDS.map((id) => byId[id]);
}

function personalLayers(t: MapTokens): LayerSpecification[] {
  const r = t.route;
  return [
    { id: "tracks-casing", type: "line", source: "tracks", paint: { "line-color": r.casing, "line-width": 5 } },
    { id: "tracks", type: "line", source: "tracks", paint: { "line-color": r.recorded, "line-width": 2.5 } },
    { id: "live-casing", type: "line", source: "live", paint: { "line-color": r.casing, "line-width": 5 } },
    { id: "live", type: "line", source: "live", paint: { "line-color": r.live, "line-width": 2.5, "line-dasharray": [1.4, 1.2] } },
  ];
}

function navigationLayers(t: MapTokens): LayerSpecification[] {
  const n = t.nav;
  const isPreview: FilterSpecification = ["==", ["get", "kind"], "preview"];
  return [
    // Downloaded offline areas (solid) and the area being planned (dashed).
    { id: "offline-areas-casing", type: "line", source: "offline-areas", paint: { "line-color": n.casing, "line-width": 4, "line-opacity": 0.6 } },
    {
      id: "offline-areas",
      type: "line",
      source: "offline-areas",
      filter: ["!", isPreview],
      paint: { "line-color": ["match", ["get", "kind"], "ready", n.offlineReady, n.offlinePartial], "line-width": 2 },
    },
    { id: "offline-area-preview", type: "line", source: "offline-areas", filter: isPreview, paint: { "line-color": n.offlinePreview, "line-width": 2, "line-dasharray": [2, 1.5] } },
    { id: "rings", type: "line", source: "rings", paint: { "line-color": n.ring, "line-width": 1.25, "line-opacity": 0.8, "line-dasharray": [1.4, 1.1] } },
    { id: "sun-casing", type: "line", source: "sun", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": n.casing, "line-width": 4.5, "line-opacity": 0.8 } },
    {
      id: "sun-line",
      type: "line",
      source: "sun",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": ["match", ["get", "kind"], "rise", n.sunRise, "sun", n.sunNow, n.sunSet], "line-width": 2.5 },
    },
    {
      id: "sun-label",
      type: "symbol",
      source: "sun",
      filter: ["==", ["geometry-type"], "Point"],
      // Active navigation content: always drawn, even over other labels.
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 13, "text-offset": [0, -0.6], "text-anchor": "bottom", "text-allow-overlap": true },
      paint: { "text-color": n.ring, "text-halo-color": n.casing, "text-halo-width": 1.4 },
    },
    { id: "accuracy", type: "fill", source: "accuracy", paint: { "fill-color": n.accuracy, "fill-opacity": 0.18 } },
    { id: "accuracy-line", type: "line", source: "accuracy", paint: { "line-color": n.accuracy, "line-width": 1, "line-opacity": 0.75 } },
    { id: "measure-fill", type: "fill", source: "measure", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": n.measureFill, "fill-opacity": 0.22 } },
    { id: "measure-casing", type: "line", source: "measure", paint: { "line-color": n.casing, "line-width": 5 } },
    { id: "measure", type: "line", source: "measure", paint: { "line-color": n.measure, "line-width": 2 } },
    {
      id: "measure-pts",
      type: "circle",
      source: "measure",
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 4, "circle-color": n.measure, "circle-stroke-width": 2, "circle-stroke-color": n.casing },
    },
  ];
}

/** The map's layers by render group. */
export function mapLayerGroups(o: StyleOptions): Record<RenderGroup, LayerSpecification[]> {
  const t = tokensFor(o.basemap);
  return {
    base: baseLayers(o, t),
    relief: reliefLayers(o, t),
    thematic: thematicLayers(o),
    detail: detailLayers(o, t),
    boundaries: boundaryLayers(o, t),
    labels: labelLayers(o, t),
    personal: personalLayers(t),
    navigation: navigationLayers(t),
    inspection: [],
  };
}

/** The ordered layer list for the style. */
export function buildLayers(o: StyleOptions): LayerSpecification[] {
  return orderLayers(mapLayerGroups(o) as GroupedLayers<LayerSpecification>);
}

/**
 * Whether contours draw for these settings. Terrain and Field use
 * `showContours` (on by default); Satellite has its own switch, off by
 * default, so imagery users don't see lines appear after an update.
 */
export function contoursShown(o: { basemap: Basemap; showContours: boolean; showImageryContours: boolean }): boolean {
  // The USGS topo scan prints its own contours; Fieldline's are never drawn over it.
  if (o.basemap === "topo") return false;
  return styleFamily(o.basemap) === "imagery" ? o.showImageryContours : o.showContours;
}

/** Layout properties that differ between style families: label sizes (re-applied on a style switch; visibility is separate). */
export function styleLayout(o: StyleOptions): { id: string; prop: string; value: unknown }[] {
  const out: { id: string; prop: string; value: unknown }[] = [];
  for (const layer of mapLayerGroups(o).labels) {
    const layout = (layer as { layout?: Record<string, unknown> }).layout;
    if (layout?.["text-size"] !== undefined) out.push({ id: layer.id, prop: "text-size", value: layout["text-size"] });
  }
  return out;
}
