import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { circlePolygon, windFits } from "@/lib/hunt/format";
import { destination } from "@/lib/hunt/sun";
import { MARKS } from "@/components/hunt/marks";
import { cachedTile, installTileProtocol, TILES } from "@/lib/hunt/tiles";
import type { Basemap, LngLat, MapView, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";
import { DEFAULT_VIEW } from "@/lib/hunt/types";
import type { DistanceUnit, ElevationUnit } from "@/features/settings/schema";

export type GpsFix = { lng: number; lat: number; accuracy: number; heading: number | null };

export type MapBounds = { west: number; south: number; east: number; north: number; zoom: number };

export type MapHandle = {
  easeTo: (lng: number, lat: number, zoom?: number) => void;
  fit: (points: LngLat[]) => void;
  getCenter: () => LngLat;
  getBounds: () => MapBounds | null;
  resetNorth: () => void;
};

type Tool = "none" | "drop" | "measure";

type Props = {
  hydrated: boolean;
  basemap: Basemap;
  showPublic: boolean;
  publicOpacity: number;
  showLabels: boolean;
  showRoads: boolean;
  showTracks: boolean;
  showCreeks: boolean;
  showPeaks: boolean;
  showUnitLabels: boolean;
  showBorder: boolean;
  showShade: boolean;
  showSun: boolean;
  showRings: boolean;
  showUnits: boolean;
  unitsGeo: FC;
  borderGeo: FC;
  unitLabels: { gmu: string; lng: number; lat: number }[];
  windFrom: number | null;
  sunLng: number | null;
  sunLat: number | null;
  riseAz: number | null;
  setAz: number | null;
  liveAz: number | null;
  shadeAz: number | null;
  shadeEl: number | null;
  viewZoom: number;
  ringAt: LngLat | null;
  terrain: boolean;
  /** Display-only vertical scale. Elevation values elsewhere stay real. */
  terrainExaggeration: number;
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
  /** Skip animated camera moves. */
  reduceMotion: boolean;
  /** Camera when the map first starts. */
  initialView: MapView;
  showMarks: boolean;
  waypoints: Waypoint[];
  selectedId: string | null;
  tracks: Track[];
  livePoints: TrackPoint[];
  measurePoints: LngLat[];
  measureClosed: boolean;
  gps: GpsFix | null;
  tool: Tool;
  onMapClick: (lng: number, lat: number, x: number, y: number) => void;
  onContextMenu: (lng: number, lat: number, x: number, y: number) => void;
  onPointerMove: (lng: number, lat: number, x: number, y: number) => void;
  onPointerLeave: () => void;
  onMarkerClick: (id: string) => void;
  onView: (view: MapView) => void;
  onDragStart: () => void;
};

type JsonGeometry =
  | { type: "LineString"; coordinates: number[][] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "Point"; coordinates: number[] };

type JsonFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: JsonGeometry;
};

type FC = { type: "FeatureCollection"; features: JsonFeature[] };

const EMPTY: FC = { type: "FeatureCollection", features: [] };

const OFM = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const ROAD_LINE_LAYERS = ["vx-local-casing", "vx-local", "vx-highway-casing", "vx-highway", "vx-freeway-casing", "vx-freeway"] as const;
const TRACK_LAYERS = ["vx-track"] as const;
const CREEK_LAYERS = ["vx-creek-line", "vx-creek"] as const;
const ROAD_NAME_LAYERS = ["vx-road-major", "vx-road-minor", "vx-shield"] as const;
const TOWN_LAYERS = ["vx-place-city", "vx-place-town", "vx-place-small"] as const;
const PEAK_LAYERS = ["vx-peak"] as const;
const STREET_FILLS = ["vx-water", "vx-wood", "vx-park"] as const;

type OverlayPaint = {
  street: boolean;
  freeway: string;
  freewayCasing: string;
  highway: string;
  highwayCasing: string;
  local: string;
  localCasing: string;
  track: string;
  text: string;
  halo: string;
  creek: string;
  land: string;
};

function overlayPaint(basemap: Basemap): OverlayPaint {
  const street = basemap === "street";
  return street
    ? {
        street,
        freeway: "#e25c12",
        freewayCasing: "#7a3410",
        highway: "#c9842e",
        highwayCasing: "#8a6230",
        local: "#fffcf7",
        localCasing: "#b7b1a6",
        track: "#6d675c",
        text: "#1a1e16",
        halo: "#f3f0e8",
        creek: "#3e6278",
        land: "#e4dfd4",
      }
    : {
        street,
        freeway: "#ff7a1a",
        freewayCasing: "#2a1004",
        highway: "#f0d56a",
        highwayCasing: "#1a1408",
        local: "#c5d2e0",
        localCasing: "#12161c",
        track: "#e4efd8",
        text: "#f7f4ea",
        halo: "#141810",
        creek: "#d5e6f2",
        land: "#1c2418",
      };
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

const NAME_FIELD: ExpressionSpecification = ["coalesce", ["get", "name_en"], ["get", "name"]];

function zoomWidth(stops: number[]): ExpressionSpecification {
  const expr: unknown[] = ["interpolate", ["exponential", 1.35], ["zoom"]];
  for (let i = 0; i < stops.length; i += 2) expr.push(stops[i], stops[i + 1]);
  return expr as ExpressionSpecification;
}

function overlayLayers(
  paint: OverlayPaint,
  flags: { roads: boolean; tracks: boolean; creeks: boolean; peaks: boolean; towns: boolean; street: boolean },
): LayerSpecification[] {
  const roadVis = vis(flags.roads);
  const trackVis = vis(flags.tracks);
  const creekVis = vis(flags.creeks);
  const peakVis = vis(flags.peaks);
  const townVis = vis(flags.towns);
  const fillVis = vis(flags.street);
  return [
    {
      id: "vx-water",
      type: "fill",
      source: "ofm",
      "source-layer": "water",
      layout: { visibility: fillVis },
      paint: { "fill-color": "#c5d4e2" },
    },
    {
      id: "vx-wood",
      type: "fill",
      source: "ofm",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      layout: { visibility: fillVis },
      paint: { "fill-color": "#d3dcc8", "fill-opacity": 0.65 },
    },
    {
      id: "vx-park",
      type: "fill",
      source: "ofm",
      "source-layer": "park",
      layout: { visibility: fillVis },
      paint: { "fill-color": "#d7e3c4", "fill-opacity": 0.55 },
    },
    {
      id: "vx-creek-line",
      type: "line",
      source: "ofm",
      "source-layer": "waterway",
      minzoom: 11,
      filter: ["match", ["get", "class"], ["river", "stream", "canal"], true, false],
      layout: { visibility: creekVis, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": paint.creek,
        "line-width": zoomWidth([11, 0.4, 14, 1.15, 17, 2.2]),
        "line-opacity": 0.85,
      },
    },
    {
      id: "vx-track",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 12,
      filter: roadFilter(["track", "path"]),
      layout: { visibility: trackVis, "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": paint.track,
        "line-width": zoomWidth([12, 0.7, 14, 1.3, 17, 2.4]),
        "line-dasharray": [1.1, 1.35],
        "line-opacity": 0.95,
      },
    },
    {
      id: "vx-local-casing",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 11,
      filter: roadFilter(["tertiary", "minor", "service", "unclassified"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.localCasing, "line-width": zoomWidth([11, 1, 14, 3, 17, 7]), "line-opacity": 0.9 },
    },
    {
      id: "vx-local",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 11,
      filter: roadFilter(["tertiary", "minor", "service", "unclassified"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.local, "line-width": zoomWidth([11, 0.4, 14, 1.5, 17, 4.2]) },
    },
    {
      id: "vx-highway-casing",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 7,
      filter: roadFilter(["primary", "secondary"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.highwayCasing, "line-width": zoomWidth([7, 1.4, 10, 2.6, 14, 5.5, 17, 10]), "line-opacity": 0.92 },
    },
    {
      id: "vx-highway",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 7,
      filter: roadFilter(["primary", "secondary"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.highway, "line-width": zoomWidth([7, 0.6, 10, 1.4, 14, 3.2, 17, 6.4]) },
    },
    {
      id: "vx-freeway-casing",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 5,
      filter: roadFilter(["motorway", "trunk"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.freewayCasing, "line-width": zoomWidth([5, 1.8, 8, 3.2, 12, 6.4, 16, 12]), "line-opacity": 0.94 },
    },
    {
      id: "vx-freeway",
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom: 5,
      filter: roadFilter(["motorway", "trunk"]),
      layout: { visibility: roadVis, "line-cap": "round", "line-join": "round" },
      paint: { "line-color": paint.freeway, "line-width": zoomWidth([5, 0.85, 8, 1.8, 12, 3.8, 16, 8]) },
    },
    {
      id: "vx-road-major",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: 11,
      filter: nameFilter(["motorway", "trunk", "primary", "secondary", "tertiary"]),
      layout: {
        visibility: roadVis,
        "symbol-placement": "line",
        "symbol-spacing": 320,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "map",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.6, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-road-minor",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: 14,
      filter: nameFilter(["minor", "service", "track"]),
      layout: {
        visibility: roadVis,
        "symbol-placement": "line",
        "symbol-spacing": 280,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "map",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.5, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-shield",
      type: "symbol",
      source: "ofm",
      "source-layer": "transportation_name",
      minzoom: 8,
      filter: ["all", lineGeom(), ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false], ["has", "ref"]],
      layout: {
        visibility: roadVis,
        "symbol-placement": "line",
        "symbol-spacing": 360,
        "text-field": ["to-string", ["get", "ref"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-pitch-alignment": "viewport",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.8, "text-halo-blur": 0.1 },
    },
    {
      id: "vx-creek",
      type: "symbol",
      source: "ofm",
      "source-layer": "waterway",
      minzoom: 12,
      filter: ["all", lineGeom(), ["has", "name"]],
      layout: {
        visibility: creekVis,
        "symbol-placement": "line",
        "symbol-spacing": 400,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Italic"],
        "text-size": 12,
        "text-letter-spacing": 0.04,
        "text-pitch-alignment": "viewport",
      },
      paint: { "text-color": paint.creek, "text-halo-color": paint.halo, "text-halo-width": 1.4, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-place-city",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: 4,
      filter: ["==", ["get", "class"], "city"],
      layout: {
        visibility: townVis,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 12, 8, 16, 12, 22],
        "text-padding": 6,
        "text-letter-spacing": 0.02,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.7, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-place-town",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: 7,
      filter: ["==", ["get", "class"], "town"],
      layout: {
        visibility: townVis,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 12, 11, 15, 14, 18],
        "text-padding": 4,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.6, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-place-small",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      minzoom: 11,
      filter: ["match", ["get", "class"], ["village", "hamlet", "suburb", "neighbourhood"], true, false],
      layout: {
        visibility: townVis,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 14],
        "text-padding": 3,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.5, "text-halo-blur": 0.15 },
    },
    {
      id: "vx-peak",
      type: "symbol",
      source: "ofm",
      "source-layer": "mountain_peak",
      minzoom: 11,
      filter: ["has", "name"],
      layout: {
        visibility: peakVis,
        "text-field": NAME_FIELD,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-padding": 2,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
        "text-offset": [0, 0.6],
      },
      paint: { "text-color": paint.text, "text-halo-color": paint.halo, "text-halo-width": 1.5, "text-halo-blur": 0.15 },
    },
  ];
}

function applyOverlayPaint(map: MlMap, basemap: Basemap) {
  const paint = overlayPaint(basemap);
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as never, value as never);
  };
  set("land", "background-color", paint.land);
  set("vx-freeway-casing", "line-color", paint.freewayCasing);
  set("vx-freeway", "line-color", paint.freeway);
  set("vx-highway-casing", "line-color", paint.highwayCasing);
  set("vx-highway", "line-color", paint.highway);
  set("vx-local-casing", "line-color", paint.localCasing);
  set("vx-local", "line-color", paint.local);
  set("vx-track", "line-color", paint.track);
  for (const id of ["vx-road-major", "vx-road-minor", "vx-shield", "vx-place-city", "vx-place-town", "vx-place-small", "vx-peak"]) {
    set(id, "text-color", paint.text);
    set(id, "text-halo-color", paint.halo);
  }
  set("vx-creek", "text-color", paint.creek);
  set("vx-creek", "text-halo-color", paint.halo);
  set("vx-creek-line", "line-color", paint.creek);
}

function vis(on: boolean): "visible" | "none" {
  return on ? "visible" : "none";
}

function buildStyle(opts: {
  basemap: Basemap;
  showPublic: boolean;
  showLabels: boolean;
  showRoads: boolean;
  showTracks: boolean;
  showCreeks: boolean;
  showPeaks: boolean;
  showShade: boolean;
  publicOpacity: number;
}): StyleSpecification {
  const hybrid = opts.basemap === "hybrid";
  const street = opts.basemap === "street";
  const imagery = opts.basemap === "satellite" || hybrid;
  const usgs = opts.basemap === "usgs";
  const shade = opts.showShade && opts.basemap !== "topo";
  const paint = overlayPaint(opts.basemap);
  const vector = opts.basemap !== "topo";
  const dem = `${window.location.origin}/api/dem/{z}/{x}/{y}`;
  const overlay = overlayLayers(paint, {
    roads: vector && opts.showRoads,
    tracks: vector && opts.showTracks,
    creeks: vector && opts.showCreeks,
    peaks: vector && opts.showPeaks,
    towns: vector && opts.showLabels,
    street,
  });
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      // Esri imagery is fetched live and never written to the device cache (provider terms).
      satellite: {
        type: "raster",
        tiles: [TILES.satellite],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Powered by Esri · Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
      },
      usgs: { type: "raster", tiles: [cachedTile(TILES.imagery)], tileSize: 256, maxzoom: 16, attribution: "Imagery: USGS The National Map, USDA" },
      topo: { type: "raster", tiles: [cachedTile(TILES.topo)], tileSize: 256, maxzoom: 16, attribution: "Topo: USGS The National Map" },
      sma: { type: "raster", tiles: [cachedTile(TILES.sma)], tileSize: 256, maxzoom: 16, attribution: "Public land © BLM" },
      ofm: { type: "vector", url: OFM, attribution: "© OpenStreetMap, OpenFreeMap" },
      dem: { type: "raster-dem", tiles: [dem], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Terrain © AWS Terrain Tiles" },
      tracks: { type: "geojson", data: EMPTY },
      live: { type: "geojson", data: EMPTY },
      measure: { type: "geojson", data: EMPTY },
      accuracy: { type: "geojson", data: EMPTY },
      sun: { type: "geojson", data: EMPTY },
      rings: { type: "geojson", data: EMPTY },
      units: { type: "geojson", data: EMPTY },
      "unit-labels": { type: "geojson", data: EMPTY },
      border: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": paint.land } },
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: vis(imagery) }, paint: { "raster-opacity": 1, "raster-resampling": "linear", "raster-fade-duration": 0 } },
      { id: "usgs", type: "raster", source: "usgs", layout: { visibility: vis(usgs) }, paint: { "raster-resampling": "linear", "raster-fade-duration": 0 } },
      { id: "topo", type: "raster", source: "topo", layout: { visibility: vis(opts.basemap === "topo") }, paint: { "raster-resampling": "linear", "raster-fade-duration": 0 } },
      ...overlay.slice(0, 3),
      { id: "sma", type: "raster", source: "sma", layout: { visibility: vis(opts.showPublic) }, paint: { "raster-opacity": opts.publicOpacity, "raster-resampling": "linear", "raster-fade-duration": 0 } },
      {
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        layout: { visibility: vis(shade) },
        paint: {
          "hillshade-method": "basic",
          "hillshade-illumination-anchor": "map",
          "hillshade-illumination-direction": 180,
          "hillshade-illumination-altitude": 35,
          "hillshade-exaggeration": 0.65,
          "hillshade-shadow-color": "rgba(8, 12, 10, 0.82)",
          "hillshade-highlight-color": "rgba(255, 236, 196, 0.42)",
          "hillshade-accent-color": "rgba(0, 0, 0, 0)",
        },
      },
      ...overlay.slice(3, 11),
      {
        id: "units-casing",
        type: "line",
        source: "units",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#141910",
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.6, 8, 4.2, 12, 6.5],
          "line-opacity": 0.75,
        },
      },
      {
        id: "units-line",
        type: "line",
        source: "units",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#f4efe2",
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.2, 8, 2, 12, 3.1],
          "line-opacity": 0.96,
        },
      },
      {
        id: "unit-labels",
        type: "symbol",
        source: "unit-labels",
        minzoom: 8,
        layout: {
          "text-field": ["get", "gmu"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#f3f1ea", "text-halo-color": "#121410", "text-halo-width": 1.5 },
      },
      {
        id: "border-casing",
        type: "line",
        source: "border",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#0c0e0a",
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 3.4, 7, 5.2, 11, 7],
          "line-opacity": 0.9,
        },
      },
      {
        id: "border-line",
        type: "line",
        source: "border",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#fffaf0",
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.6, 7, 2.5, 11, 3.5],
          "line-opacity": 1,
        },
      },
      { id: "rings", type: "line", source: "rings", paint: { "line-color": "#f3f1ea", "line-width": 1.25, "line-opacity": 0.8, "line-dasharray": [1.4, 1.1] } },
      {
        id: "sun-casing",
        type: "line",
        source: "sun",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#121410", "line-width": 4.5, "line-opacity": 0.8 },
      },
      {
        id: "sun-line",
        type: "line",
        source: "sun",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": ["match", ["get", "kind"], "rise", "#f6e7b0", "sun", "#fffdf6", "#e39455"],
          "line-width": 2.5,
        },
      },
      {
        id: "sun-label",
        type: "symbol",
        source: "sun",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 13,
          "text-offset": [0, -0.6],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#f3f1ea", "text-halo-color": "#121410", "text-halo-width": 1.4 },
      },
      { id: "accuracy", type: "fill", source: "accuracy", paint: { "fill-color": "#d7e2c8", "fill-opacity": 0.18 } },
      { id: "accuracy-line", type: "line", source: "accuracy", paint: { "line-color": "#d7e2c8", "line-width": 1, "line-opacity": 0.75 } },
      { id: "tracks-casing", type: "line", source: "tracks", paint: { "line-color": "#121410", "line-width": 5 } },
      { id: "tracks", type: "line", source: "tracks", paint: { "line-color": "#d7e2c8", "line-width": 2.5 } },
      { id: "live-casing", type: "line", source: "live", paint: { "line-color": "#121410", "line-width": 5 } },
      { id: "live", type: "line", source: "live", paint: { "line-color": "#f3f1ea", "line-width": 2.5, "line-dasharray": [1.4, 1.2] } },
      {
        id: "measure-fill",
        type: "fill",
        source: "measure",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#d7e2c8", "fill-opacity": 0.22 },
      },
      { id: "measure-casing", type: "line", source: "measure", paint: { "line-color": "#121410", "line-width": 5 } },
      { id: "measure", type: "line", source: "measure", paint: { "line-color": "#f3f1ea", "line-width": 2 } },
      {
        id: "measure-pts",
        type: "circle",
        source: "measure",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#f3f1ea", "circle-stroke-width": 2, "circle-stroke-color": "#121410" },
      },
      ...overlay.slice(11),
    ],
  };
}

function setGeo(map: MlMap, id: string, data: FC) {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  source?.setData(data);
}

function fitStage(map: MlMap, el: HTMLElement) {
  const stage = el.parentElement;
  if (!stage) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width < 2 || height < 2) return;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  map.resize();
}

export const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas(props, ref) {
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const mlRef = useRef<typeof import("maplibre-gl") | null>(null);
  const scaleRef = useRef<{ setUnit: (unit: "imperial" | "metric") => void } | null>(null);
  const onMapClickRef = useRef(props.onMapClick);
  const onContextRef = useRef(props.onContextMenu);
  const onPointerMoveRef = useRef(props.onPointerMove);
  const onPointerLeaveRef = useRef(props.onPointerLeave);
  const onMarkerClickRef = useRef(props.onMarkerClick);
  const onViewRef = useRef(props.onView);
  const onDragRef = useRef(props.onDragStart);
  const terrainRef = useRef(props.terrain);
  const propsRef = useRef(props);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  propsRef.current = props;
  const motion = (ms: number) => (propsRef.current.reduceMotion ? 0 : ms);

  onMapClickRef.current = props.onMapClick;
  onContextRef.current = props.onContextMenu;
  onPointerMoveRef.current = props.onPointerMove;
  onPointerLeaveRef.current = props.onPointerLeave;
  onMarkerClickRef.current = props.onMarkerClick;
  onViewRef.current = props.onView;
  onDragRef.current = props.onDragStart;
  terrainRef.current = props.terrain;

  useImperativeHandle(ref, () => ({
    easeTo(lng, lat, zoom) {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 13), duration: motion(700) });
    },
    fit(points) {
      const map = mapRef.current;
      if (!map || points.length === 0) return;
      if (points.length === 1) {
        map.easeTo({ center: [points[0].lng, points[0].lat], zoom: Math.max(map.getZoom(), 14), duration: motion(700) });
        return;
      }
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const point of points) {
        west = Math.min(west, point.lng);
        east = Math.max(east, point.lng);
        south = Math.min(south, point.lat);
        north = Math.max(north, point.lat);
      }
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 72, duration: motion(700), maxZoom: 15 },
      );
    },
    getCenter() {
      const center = mapRef.current?.getCenter();
      return center ? { lng: center.lng, lat: center.lat } : { lng: DEFAULT_VIEW.lng, lat: DEFAULT_VIEW.lat };
    },
    getBounds() {
      const map = mapRef.current;
      if (!map) return null;
      const bounds = map.getBounds();
      return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        zoom: map.getZoom(),
      };
    },
    resetNorth() {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ bearing: 0, pitch: terrainRef.current ? Math.max(map.getPitch(), 48) : 0, duration: motion(450) });
    },
  }));

  useEffect(() => {
    if (!props.hydrated || !containerRef.current) return;
    const el = containerRef.current;
    let map: MlMap | null = null;
    let dead = false;
    let observer: ResizeObserver | null = null;
    let hoverRaf = 0;
    let holdTimer = 0;

    void (async () => {
      try {
        const ml = await import("maplibre-gl");
        if (dead) return;
        ml.setWorkerUrl(maplibreWorkerUrl);
        installTileProtocol(ml);
        mlRef.current = ml;
        const state = propsRef.current;
        const saved = state.initialView;
        map = new ml.Map({
          container: el,
          style: buildStyle({
            basemap: state.basemap,
            showPublic: state.showPublic,
            showLabels: state.showLabels,
            showRoads: state.showRoads,
            showTracks: state.showTracks,
            showCreeks: state.showCreeks,
            showPeaks: state.showPeaks,
            showShade: state.showShade,
            publicOpacity: state.publicOpacity,
          }),
          center: [saved.lng, saved.lat],
          zoom: saved.zoom,
          bearing: saved.bearing,
          pitch: saved.pitch,
          maxPitch: 72,
          attributionControl: { compact: true },
          maplibreLogo: false,
          fadeDuration: 0,
          refreshExpiredTiles: false,
          validateStyle: false,
          pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
          canvasContextAttributes: { antialias: false, failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: false },
        });
        map.touchPitch.disable();
        const scale = new ml.ScaleControl({ maxWidth: 110, unit: state.distanceUnit });
        scaleRef.current = scale;
        map.addControl(scale, "bottom-left");
        const fit = () => {
          if (map && !dead) fitStage(map, el);
        };
        observer = new ResizeObserver(fit);
        if (stageRef.current) observer.observe(stageRef.current);
        let booted = false;
        const boot = () => {
          if (dead || !map || booted) return;
          booted = true;
          mapRef.current = map;
          fit();
          if (propsRef.current.terrain) {
            map.setTerrain({ source: "dem", exaggeration: propsRef.current.terrainExaggeration });
            map.touchPitch.enable();
          }
          const center = map.getCenter();
          onViewRef.current({
            lng: center.lng,
            lat: center.lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          });
          setReady(true);
          window.setTimeout(fit, 60);
        };
        map.on("load", boot);
        map.on("style.load", boot);
        if (map.isStyleLoaded()) boot();
        map.on("error", (event) => {
          const message = event.error?.message ?? "";
          if (/webgl|failed to initialize/i.test(message)) setMapError("This browser can't draw the map.");
        });
        let swallowClick = false;
        let hold: { x: number; y: number; lng: number; lat: number } | null = null;
        const clearHold = () => {
          if (holdTimer) window.clearTimeout(holdTimer);
          holdTimer = 0;
          hold = null;
        };
        map.on("click", (event) => {
          if (swallowClick) {
            swallowClick = false;
            return;
          }
          onMapClickRef.current(event.lngLat.lng, event.lngLat.lat, event.point.x, event.point.y);
        });
        map.on("contextmenu", (event) => {
          event.preventDefault();
          if (hold) swallowClick = true;
          onContextRef.current(event.lngLat.lng, event.lngLat.lat, event.point.x, event.point.y);
        });
        map.on("touchstart", (event) => {
          if (event.originalEvent.touches.length !== 1) {
            clearHold();
            return;
          }
          hold = { x: event.point.x, y: event.point.y, lng: event.lngLat.lng, lat: event.lngLat.lat };
          holdTimer = window.setTimeout(() => {
            if (!hold) return;
            swallowClick = true;
            onContextRef.current(hold.lng, hold.lat, hold.x, hold.y);
            hold = null;
            holdTimer = 0;
          }, 520);
        });
        map.on("touchmove", (event) => {
          if (!hold) return;
          const dx = event.point.x - hold.x;
          const dy = event.point.y - hold.y;
          if (dx * dx + dy * dy > 64) clearHold();
        });
        map.on("touchend", clearHold);
        map.on("touchcancel", clearHold);
        let pendingHover: { lng: number; lat: number; x: number; y: number } | null = null;
        let lastHx = -1e9;
        let lastHy = -1e9;
        map.on("mousemove", (event) => {
          pendingHover = { lng: event.lngLat.lng, lat: event.lngLat.lat, x: event.point.x, y: event.point.y };
          if (hoverRaf) return;
          hoverRaf = requestAnimationFrame(() => {
            hoverRaf = 0;
            const next = pendingHover;
            if (!next || dead) return;
            const dx = next.x - lastHx;
            const dy = next.y - lastHy;
            if (dx * dx + dy * dy < 36) return;
            lastHx = next.x;
            lastHy = next.y;
            onPointerMoveRef.current(next.lng, next.lat, next.x, next.y);
          });
        });
        map.on("mouseout", () => {
          lastHx = -1e9;
          lastHy = -1e9;
          onPointerLeaveRef.current();
        });
        map.on("dragstart", () => onDragRef.current());
        let lastPose = 0;
        const publish = () => {
          if (!map) return;
          const center = map.getCenter();
          onViewRef.current({
            lng: center.lng,
            lat: center.lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          });
        };
        const publishPose = () => {
          const now = performance.now();
          if (now - lastPose < 160) return;
          lastPose = now;
          publish();
        };
        map.on("moveend", publish);
        map.on("rotate", publishPose);
        map.on("pitch", publishPose);
        fit();
      } catch (error) {
        if (!dead) setMapError(error instanceof Error ? error.message : "Map failed to start.");
      }
    })();

    return () => {
      dead = true;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      if (holdTimer) window.clearTimeout(holdTimer);
      setReady(false);
      observer?.disconnect();
      mapRef.current = null;
      scaleRef.current = null;
      map?.remove();
    };
  }, [props.hydrated]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const show = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
    };
    const hybrid = props.basemap === "hybrid";
    const street = props.basemap === "street";
    const imagery = props.basemap === "satellite" || hybrid;
    const vector = props.basemap !== "topo";
    show("hillshade", props.showShade && props.basemap !== "topo");
    show("satellite", imagery);
    show("usgs", props.basemap === "usgs");
    show("topo", props.basemap === "topo");
    show("sma", props.showPublic);
    for (const id of STREET_FILLS) show(id, street);
    for (const id of ROAD_LINE_LAYERS) show(id, vector && props.showRoads);
    for (const id of ROAD_NAME_LAYERS) show(id, vector && props.showRoads);
    for (const id of TRACK_LAYERS) show(id, vector && props.showTracks);
    for (const id of CREEK_LAYERS) show(id, vector && props.showCreeks);
    for (const id of TOWN_LAYERS) show(id, vector && props.showLabels);
    for (const id of PEAK_LAYERS) show(id, vector && props.showPeaks);
    map.setPaintProperty("sma", "raster-opacity", props.publicOpacity);
    map.setPaintProperty("satellite", "raster-opacity", 1);
    applyOverlayPaint(map, props.basemap);
  }, [ready, props.basemap, props.showPublic, props.showLabels, props.showRoads, props.showTracks, props.showCreeks, props.showPeaks, props.showShade, props.publicOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const existing = map.getLayer("hillshade");
    if (!existing || existing.type !== "hillshade") {
      if (existing) map.removeLayer("hillshade");
      if (map.getSource("hillshade")) map.removeSource("hillshade");
      if (!map.getSource("dem")) return;
      map.addLayer(
        {
          id: "hillshade",
          type: "hillshade",
          source: "dem",
          layout: { visibility: props.showShade && props.basemap !== "topo" ? "visible" : "none" },
          paint: {
            "hillshade-method": "basic",
            "hillshade-illumination-anchor": "map",
            "hillshade-illumination-direction": props.shadeAz ?? 180,
            "hillshade-illumination-altitude": 35,
            "hillshade-exaggeration": 0.65,
            "hillshade-shadow-color": "rgba(8, 12, 10, 0.82)",
            "hillshade-highlight-color": "rgba(255, 236, 196, 0.42)",
            "hillshade-accent-color": "rgba(0, 0, 0, 0)",
          },
        },
        map.getLayer("units-casing") ? "units-casing" : undefined,
      );
    }
    if (props.shadeAz == null || props.shadeEl == null) return;
    const altitude = props.shadeEl <= 0 ? 3 : Math.min(80, Math.max(4, props.shadeEl));
    const exaggeration = props.shadeEl <= 0 ? 0.4 : props.shadeEl < 15 ? 0.85 : 0.42 + (1 - altitude / 90) * 0.35;
    map.setPaintProperty("hillshade", "hillshade-illumination-direction", props.shadeAz);
    map.setPaintProperty("hillshade", "hillshade-illumination-altitude", altitude);
    map.setPaintProperty("hillshade", "hillshade-exaggeration", exaggeration);
    map.setPaintProperty("hillshade", "hillshade-shadow-color", props.shadeEl <= 0 ? "rgba(8, 12, 10, 0.4)" : "rgba(8, 12, 10, 0.82)");
  }, [ready, props.basemap, props.showShade, props.shadeAz, props.shadeEl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (props.terrain) {
      map.setTerrain({ source: "dem", exaggeration: props.terrainExaggeration });
      map.touchPitch.enable();
      if (map.getPitch() < 20) map.easeTo({ pitch: 52, duration: motion(500) });
    } else {
      map.touchPitch.disable();
      map.setTerrain(null);
      if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: motion(400) });
    }
  }, [ready, props.terrain, props.terrainExaggeration]);

  useEffect(() => {
    scaleRef.current?.setUnit(props.distanceUnit);
  }, [props.distanceUnit, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map?.getLayer("vx-peak")) return;
    const factor = props.elevationUnit === "ft" ? 3.28084 : 1;
    const unit = props.elevationUnit === "ft" ? " ft" : " m";
    map.setLayoutProperty("vx-peak", "text-field", [
      "concat",
      ["coalesce", ["get", "name_en"], ["get", "name"]],
      [
        "case",
        ["all", ["has", "ele"], [">", ["to-number", ["get", "ele"]], 0]],
        ["concat", "\n", ["to-string", ["round", ["*", ["to-number", ["get", "ele"]], factor]]], unit],
        "",
      ],
    ]);
  }, [props.elevationUnit, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (props.tool === "drop" || props.tool === "measure") map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [ready, props.tool]);

  useEffect(() => {
    const map = mapRef.current;
    const ml = mlRef.current;
    if (!ready || !map || !ml) return;
    const entries: { marker: Marker; root: Root }[] = [];
    if (props.showMarks) {
      for (const waypoint of props.waypoints) {
        const meta = MARKS[waypoint.kind];
        const verdict = props.windFrom == null ? null : windFits(props.windFrom, waypoint.goodWinds);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `mark-pin ${meta.pinClass}${waypoint.id === props.selectedId ? " mark-pin-on" : ""}${verdict === true ? " mark-go" : ""}${verdict === false ? " mark-hold" : ""}`;
        button.setAttribute("aria-label", waypoint.name);
        const slot = document.createElement("span");
        slot.className = "grid place-items-center";
        button.appendChild(slot);
        const root = createRoot(slot);
        const Icon = meta.icon;
        root.render(<Icon className="size-4" strokeWidth={2.25} aria-hidden />);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onMarkerClickRef.current(waypoint.id);
        });
        const marker = new ml.Marker({ element: button, anchor: "center" }).setLngLat([waypoint.lng, waypoint.lat]).addTo(map);
        entries.push({ marker, root });
      }
    }
    return () => {
      for (const entry of entries) {
        entry.root.unmount();
        entry.marker.remove();
      }
    };
  }, [ready, props.waypoints, props.showMarks, props.selectedId, props.windFrom]);

  useEffect(() => {
    const map = mapRef.current;
    const ml = mlRef.current;
    if (!ready || !map || !ml || !props.gps) return;
    const button = document.createElement("div");
    button.className = "gps-dot";
    button.setAttribute("aria-hidden", "true");
    const marker = new ml.Marker({ element: button, rotationAlignment: "map", pitchAlignment: "map" })
      .setLngLat([props.gps.lng, props.gps.lat])
      .setRotation(props.gps.heading ?? 0)
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [ready, props.gps]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setGeo(map, "units", props.unitsGeo);
    const on = props.showUnits && props.unitsGeo.features.length > 0;
    if (map.getLayer("units-casing")) map.setLayoutProperty("units-casing", "visibility", vis(on));
    if (map.getLayer("units-line")) map.setLayoutProperty("units-line", "visibility", vis(on));
  }, [ready, props.showUnits, props.unitsGeo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    setGeo(map, "border", props.borderGeo);
    const on = props.showBorder && props.borderGeo.features.length > 0;
    if (map.getLayer("border-casing")) map.setLayoutProperty("border-casing", "visibility", vis(on));
    if (map.getLayer("border-line")) map.setLayoutProperty("border-line", "visibility", vis(on));
  }, [ready, props.showBorder, props.borderGeo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.showUnits || !props.showUnitLabels || props.unitLabels.length === 0) {
      if (map?.getLayer("unit-labels")) map.setLayoutProperty("unit-labels", "visibility", "none");
      return;
    }
    setGeo(map, "unit-labels", {
      type: "FeatureCollection",
      features: props.unitLabels.map((label) => ({
        type: "Feature",
        properties: { gmu: label.gmu },
        geometry: { type: "Point", coordinates: [label.lng, label.lat] },
      })),
    });
    if (map.getLayer("unit-labels")) map.setLayoutProperty("unit-labels", "visibility", "visible");
  }, [ready, props.showUnits, props.showUnitLabels, props.unitLabels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: JsonFeature[] = props.tracks
      .filter((track) => track.visible && track.points.length > 1)
      .map((track) => ({
        type: "Feature",
        properties: { id: track.id },
        geometry: { type: "LineString", coordinates: track.points.map((point) => [point.lng, point.lat]) },
      }));
    setGeo(map, "tracks", { type: "FeatureCollection", features });
  }, [ready, props.tracks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: JsonFeature[] =
      props.livePoints.length > 1
        ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: props.livePoints.map((point) => [point.lng, point.lat]) } }]
        : [];
    setGeo(map, "live", { type: "FeatureCollection", features });
  }, [ready, props.livePoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: JsonFeature[] = [];
    const coords = props.measurePoints.map((point) => [point.lng, point.lat] as [number, number]);
    if (props.measureClosed && coords.length >= 3) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...coords, coords[0]]] } });
    } else if (coords.length >= 2) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
    }
    for (const coord of coords) features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coord } });
    setGeo(map, "measure", { type: "FeatureCollection", features });
  }, [ready, props.measurePoints, props.measureClosed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const accuracy = props.gps?.accuracy ?? 0;
    const features: JsonFeature[] =
      props.gps && accuracy > 0 && accuracy < 4000
        ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePolygon(props.gps.lng, props.gps.lat, accuracy)] } }]
        : [];
    setGeo(map, "accuracy", { type: "FeatureCollection", features });
  }, [ready, props.gps]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: JsonFeature[] = [];
    const lng = props.sunLng;
    const lat = props.sunLat;
    if (props.showSun && lng != null && lat != null) {
      const zoom = map.getZoom();
      const width = map.getContainer().clientWidth || 900;
      const meters = Math.min(14000, Math.max(220, ((156543.03 * Math.cos((lat * Math.PI) / 180) * width) / 2 ** zoom) * 0.2));
      const rays = [
        { kind: "rise", label: "Rise", az: props.riseAz },
        { kind: "set", label: "Set", az: props.setAz },
        { kind: "sun", label: "Sun", az: props.liveAz },
      ];
      for (const ray of rays) {
        if (ray.az == null || !Number.isFinite(ray.az)) continue;
        const start = destination(lng, lat, ray.az, meters * 0.06);
        const tip = destination(lng, lat, ray.az, meters);
        features.push({
          type: "Feature",
          properties: { kind: ray.kind },
          geometry: { type: "LineString", coordinates: [start, tip] },
        });
        features.push({
          type: "Feature",
          properties: { kind: ray.kind, label: ray.label },
          geometry: { type: "Point", coordinates: tip },
        });
      }
    }
    setGeo(map, "sun", { type: "FeatureCollection", features });
  }, [ready, props.showSun, props.sunLng, props.sunLat, props.riseAz, props.setAz, props.liveAz, props.viewZoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const radii = props.distanceUnit === "imperial" ? [91.44, 182.88, 365.76] : [100, 200, 400];
    const features: JsonFeature[] =
      props.showRings && props.ringAt
        ? radii.map((radius) => ({
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [circlePolygon(props.ringAt!.lng, props.ringAt!.lat, radius)] },
          }))
        : [];
    setGeo(map, "rings", { type: "FeatureCollection", features });
  }, [ready, props.showRings, props.ringAt, props.distanceUnit]);

  return (
    <div ref={stageRef} className="map-stage">
      <div ref={containerRef} className={props.tool === "none" ? "h-full w-full" : "h-full w-full cursor-crosshair"} />
      {mapError ? <p className="absolute inset-x-6 top-1/2 z-10 -translate-y-1/2 text-center text-muted">{mapError}</p> : null}
    </div>
  );
});
