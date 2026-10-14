import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { circlePolygon, windFits } from "@/lib/hunt/format";
import { destination } from "@/lib/hunt/sun";
import { MARKS } from "@/components/hunt/marks";
import { cachedTile, installTileProtocol, TILES } from "@/lib/hunt/tiles";
import { trackSegments } from "@/lib/hunt/track-segments";
import type { Basemap, LngLat, MapView, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";
import { DEFAULT_VIEW } from "@/lib/hunt/types";
import type { BoundaryStrength, DistanceUnit, ElevationUnit, LabelDensity } from "@/features/settings/schema";
import { firstLayerAbove } from "@/features/map/layer-groups";
import { LABEL_LAYER_IDS, labelRules } from "@/features/map/labels";
import {
  BORDER_LAYERS,
  buildLayers,
  CREEK_LAYERS,
  DYNAMIC_PAINT_LAYERS,
  mapLayerGroups,
  PEAK_LAYERS,
  ROAD_LINE_LAYERS,
  ROAD_NAME_LAYERS,
  STREET_FILLS,
  TOWN_LAYERS,
  TRACK_LAYERS,
  UNIT_LINE_LAYERS,
  type StyleOptions,
} from "@/features/map/style-layers";
import { reliefPaint } from "@/features/map/tokens";

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
  /** Weight of hunt-unit and state lines. */
  boundaryStrength: BoundaryStrength;
  /** How many ordinary labels show, and from which zoom. */
  labelDensity: LabelDensity;
  showShade: boolean;
  showSun: boolean;
  showRings: boolean;
  showUnits: boolean;
  unitsGeo: FC;
  unitLabels: { id: string; code: string; lng: number; lat: number }[];
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
  | { type: "MultiLineString"; coordinates: number[][][] }
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

function vis(on: boolean): "visible" | "none" {
  return on ? "visible" : "none";
}

/**
 * Repaints every layer for the current style options (base map, boundary
 * strength, public-land opacity) from the same builder that made the style, so
 * a style switch never leaves a stale color behind. Visibility and the
 * sun-linked hillshade are handled by their own effects.
 */
function applyStylePaint(map: MlMap, options: StyleOptions) {
  for (const layer of buildLayers(options)) {
    if ((DYNAMIC_PAINT_LAYERS as readonly string[]).includes(layer.id) || !map.getLayer(layer.id)) continue;
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(layer.id, prop as never, value as never);
  }
}

/** Applies label density: first zoom, collision padding and line-label spacing per label layer. */
function applyLabelDensity(map: MlMap, density: LabelDensity) {
  const rules = labelRules(density);
  for (const id of LABEL_LAYER_IDS) {
    if (!map.getLayer(id)) continue;
    const rule = rules[id];
    map.setLayerZoomRange(id, rule.minzoom, 24);
    map.setLayoutProperty(id, "text-padding", rule.padding);
    if (rule.spacing != null) map.setLayoutProperty(id, "symbol-spacing", rule.spacing);
  }
}

function styleOptions(p: Props): StyleOptions {
  return {
    basemap: p.basemap,
    showPublic: p.showPublic,
    showLabels: p.showLabels,
    showRoads: p.showRoads,
    showTracks: p.showTracks,
    showCreeks: p.showCreeks,
    showPeaks: p.showPeaks,
    showShade: p.showShade,
    showBorder: p.showBorder,
    publicOpacity: p.publicOpacity,
    boundaryStrength: p.boundaryStrength,
    labelDensity: p.labelDensity,
  };
}

function buildStyle(opts: StyleOptions): StyleSpecification {
  const dem = `${window.location.origin}/api/dem/{z}/{x}/{y}`;
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
      units: { type: "geojson", data: EMPTY, attribution: "Hunt units: state wildlife agencies (reference only)" },
      "unit-labels": { type: "geojson", data: EMPTY },
    },
    // Named render groups (src/features/map/layer-groups.ts), never positional slices.
    layers: buildLayers(opts),
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
          style: buildStyle(styleOptions(state)),
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
          mapRef.current = map;          fit();
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
  }, [ready, props.basemap, props.showPublic, props.showLabels, props.showRoads, props.showTracks, props.showCreeks, props.showPeaks, props.showShade]);

  // Colors, weights and public-land opacity come from the design tokens of the current style.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    applyStylePaint(map, styleOptions(propsRef.current));
  }, [ready, props.basemap, props.boundaryStrength, props.publicOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    applyLabelDensity(map, props.labelDensity);
  }, [ready, props.labelDensity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const existing = map.getLayer("hillshade");
    if (!existing || existing.type !== "hillshade") {
      if (existing) map.removeLayer("hillshade");
      if (map.getSource("hillshade")) map.removeSource("hillshade");
      if (!map.getSource("dem")) return;
      const groups = mapLayerGroups(styleOptions(propsRef.current));
      const relief = groups.relief.find((layer) => layer.id === "hillshade");
      if (!relief) return;
      // Back on top of the relief group, under public land and everything above it.
      map.addLayer(relief, firstLayerAbove(groups, "relief", (id) => Boolean(map.getLayer(id))));
    }
    // Sun-direction hillshade (not cast shadows); strength depends on the base map.
    const paint = reliefPaint(props.basemap, props.shadeAz, props.shadeEl);
    for (const [prop, value] of Object.entries(paint)) map.setPaintProperty("hillshade", prop as never, value as never);
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
    for (const id of UNIT_LINE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
  }, [ready, props.showUnits, props.unitsGeo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const id of BORDER_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(props.showBorder));
  }, [ready, props.showBorder]);

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
        properties: { id: label.id, code: label.code },
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
        // Recording gaps stay gaps: each segment is its own line.
        geometry: { type: "MultiLineString", coordinates: trackSegments(track).map((segment) => segment.map((point) => [point.lng, point.lat])) },
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
