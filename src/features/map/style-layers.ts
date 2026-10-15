import type { ExpressionSpecification, FilterSpecification, HillshadeLayerSpecification, LayerSpecification } from "maplibre-gl";
import type { Basemap } from "@/lib/hunt/types";
import { orderLayers, type GroupedLayers, type RenderGroup } from "./layer-groups.ts";
import { LABEL_LAYER_IDS, labelRules, type LabelDensity, type LabelLayerId } from "./labels.ts";
import { BOUNDARY_WEIGHTS, reliefPaint, tokensFor, type BoundaryStrength, type LineToken, type MapTokens } from "./tokens.ts";

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
};

export const BASE_RASTERS = ["satellite", "usgs", "topo"] as const;
export const STREET_FILLS = ["vx-water", "vx-wood", "vx-park"] as const;
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

function baseLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const imagery = o.basemap === "satellite" || o.basemap === "hybrid";
  const fillVis = vis(o.basemap === "street");
  const raster = { "raster-resampling": "linear", "raster-fade-duration": 0 } as const;
  return [
    { id: "land", type: "background", paint: { "background-color": t.land } },
    { id: "satellite", type: "raster", source: "satellite", layout: { visibility: vis(imagery) }, paint: { "raster-opacity": 1, ...raster } },
    { id: "usgs", type: "raster", source: "usgs", layout: { visibility: vis(o.basemap === "usgs") }, paint: { ...raster } },
    { id: "topo", type: "raster", source: "topo", layout: { visibility: vis(o.basemap === "topo") }, paint: { ...raster } },
    { id: "vx-water", type: "fill", source: "ofm", "source-layer": "water", layout: { visibility: fillVis }, paint: { "fill-color": t.water } },
    {
      id: "vx-wood",
      type: "fill",
      source: "ofm",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      layout: { visibility: fillVis },
      paint: { "fill-color": t.vegetation, "fill-opacity": 0.65 },
    },
    { id: "vx-park", type: "fill", source: "ofm", "source-layer": "park", layout: { visibility: fillVis }, paint: { "fill-color": t.park, "fill-opacity": 0.55 } },
  ];
}

function reliefLayers(o: StyleOptions): LayerSpecification[] {
  return [
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      layout: { visibility: vis(o.showShade && o.basemap !== "topo") },
      paint: reliefPaint(o.basemap, null, null) as HillshadeLayerSpecification["paint"],
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
  const vector = o.basemap !== "topo";
  const roadVis = vis(vector && o.showRoads);
  const trackVis = vis(vector && o.showTracks);
  const creekVis = vis(vector && o.showCreeks);
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
        "line-opacity": ["case", urbanPath, cap(t.trail.lineOpacity * 0.5), t.trail.lineOpacity],
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

function labelLayers(o: StyleOptions, t: MapTokens): LayerSpecification[] {
  const vector = o.basemap !== "topo";
  const roadVis = vis(vector && o.showRoads);
  const creekVis = vis(vector && o.showCreeks);
  const peakVis = vis(vector && o.showPeaks);
  const townVis = vis(vector && o.showLabels);
  const rules = labelRules(o.labelDensity);
  const zoomOf = (id: LabelLayerId) => rules[id].minzoom;
  const pad = (id: LabelLayerId) => rules[id].padding;
  const spacing = (id: LabelLayerId) => rules[id].spacing ?? 250;
  const byId: Record<LabelLayerId, LayerSpecification> = {
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
        "text-size": 12,
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11.5, 15, 13],
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
        "text-size": 11,
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 14],
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
        "text-size": 12,
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11.5, 15, 13],
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 12, 11, 15, 14, 17],
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 12, 8, 16, 12, 20],
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
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 11.5, 11, 13, 14, 15],
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
    relief: reliefLayers(o),
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
