import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { circlePolygon, scentReach, sectorPolygon, windFits } from "@/lib/hunt/format";
import { MARKS } from "@/components/hunt/marks";
import { cachedTile, installTileProtocol, TILES } from "@/lib/hunt/tiles";
import type { Basemap, LngLat, MapView, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";
import { DEFAULT_VIEW } from "@/lib/hunt/types";
import { useHunt } from "@/lib/hunt/store";

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
  showShade: boolean;
  showScent: boolean;
  showRings: boolean;
  showUnits: boolean;
  unitsGeo: FC;
  unitLabels: { gmu: string; lng: number; lat: number }[];
  windFrom: number | null;
  windMps: number;
  scentAt: LngLat;
  ringAt: LngLat | null;
  terrain: boolean;
  imperial: boolean;
  showMarks: boolean;
  waypoints: Waypoint[];
  selectedId: string | null;
  tracks: Track[];
  livePoints: TrackPoint[];
  measurePoints: LngLat[];
  measureClosed: boolean;
  gps: GpsFix | null;
  tool: Tool;
  onMapClick: (lng: number, lat: number) => void;
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

function vis(on: boolean): "visible" | "none" {
  return on ? "visible" : "none";
}

function buildStyle(opts: {
  basemap: Basemap;
  showPublic: boolean;
  showLabels: boolean;
  showShade: boolean;
  publicOpacity: number;
}): StyleSpecification {
  const hybrid = opts.basemap === "hybrid";
  const imagery = opts.basemap === "satellite" || hybrid;
  const shade = opts.showShade && imagery;
  const dem = `${window.location.origin}/api/dem/{z}/{x}/{y}`;
  return {
    version: 8,
    sources: {
      satellite: { type: "raster", tiles: [cachedTile(TILES.satellite)], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
      hillshade: { type: "raster", tiles: [cachedTile(TILES.hillshade)], tileSize: 256, maxzoom: 16, attribution: "Hillshade © Esri" },
      topo: { type: "raster", tiles: [cachedTile(TILES.topo)], tileSize: 256, maxzoom: 16, attribution: "Topo © USGS" },
      street: { type: "raster", tiles: [cachedTile(TILES.street)], tileSize: 256, maxzoom: 19, attribution: "Streets © Esri" },
      roads: { type: "raster", tiles: [cachedTile(TILES.roads)], tileSize: 256, maxzoom: 19 },
      places: { type: "raster", tiles: [cachedTile(TILES.places)], tileSize: 256, maxzoom: 19 },
      sma: { type: "raster", tiles: [cachedTile(TILES.sma)], tileSize: 256, maxzoom: 16, attribution: "Public land © BLM" },
      dem: { type: "raster-dem", tiles: [dem], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Terrain © AWS Terrain Tiles" },
      tracks: { type: "geojson", data: EMPTY },
      live: { type: "geojson", data: EMPTY },
      measure: { type: "geojson", data: EMPTY },
      accuracy: { type: "geojson", data: EMPTY },
      scent: { type: "geojson", data: EMPTY },
      rings: { type: "geojson", data: EMPTY },
      units: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": "#1c2418" } },
      { id: "hillshade", type: "raster", source: "hillshade", layout: { visibility: vis(shade) }, paint: { "raster-opacity": 0.95 } },
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: vis(imagery) }, paint: { "raster-opacity": shade ? 0.78 : 1 } },
      { id: "topo", type: "raster", source: "topo", layout: { visibility: vis(opts.basemap === "topo") } },
      { id: "street", type: "raster", source: "street", layout: { visibility: vis(opts.basemap === "street") } },
      { id: "sma", type: "raster", source: "sma", layout: { visibility: vis(opts.showPublic) }, paint: { "raster-opacity": opts.publicOpacity } },
      { id: "roads", type: "raster", source: "roads", layout: { visibility: vis(hybrid) } },
      { id: "places", type: "raster", source: "places", layout: { visibility: vis(hybrid && opts.showLabels) } },
      { id: "units-casing", type: "line", source: "units", paint: { "line-color": "#1a1408", "line-width": 3.25, "line-opacity": 0.55 } },
      { id: "units-line", type: "line", source: "units", paint: { "line-color": "#e7d7a8", "line-width": 1.6, "line-opacity": 0.92 } },
      { id: "scent-fill", type: "fill", source: "scent", paint: { "fill-color": "#d7e2c8", "fill-opacity": 0.28 } },
      { id: "scent-line", type: "line", source: "scent", paint: { "line-color": "#f3f1ea", "line-width": 1.5, "line-opacity": 0.9 } },
      { id: "rings", type: "line", source: "rings", paint: { "line-color": "#f3f1ea", "line-width": 1.25, "line-opacity": 0.8, "line-dasharray": [1.4, 1.1] } },
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
  const onMarkerClickRef = useRef(props.onMarkerClick);
  const onViewRef = useRef(props.onView);
  const onDragRef = useRef(props.onDragStart);
  const terrainRef = useRef(props.terrain);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  onMapClickRef.current = props.onMapClick;
  onMarkerClickRef.current = props.onMarkerClick;
  onViewRef.current = props.onView;
  onDragRef.current = props.onDragStart;
  terrainRef.current = props.terrain;

  useImperativeHandle(ref, () => ({
    easeTo(lng, lat, zoom) {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ center: [lng, lat], zoom: zoom ?? Math.max(map.getZoom(), 13), duration: 700 });
    },
    fit(points) {
      const map = mapRef.current;
      if (!map || points.length === 0) return;
      if (points.length === 1) {
        map.easeTo({ center: [points[0].lng, points[0].lat], zoom: Math.max(map.getZoom(), 14), duration: 700 });
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
        { padding: 72, duration: 700, maxZoom: 15 },
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
      map.easeTo({ bearing: 0, pitch: terrainRef.current ? Math.max(map.getPitch(), 48) : 0, duration: 450 });
    },
  }));

  useEffect(() => {
    if (!props.hydrated || !containerRef.current) return;
    const el = containerRef.current;
    let map: MlMap | null = null;
    let dead = false;
    let observer: ResizeObserver | null = null;

    void (async () => {
      try {
        const ml = await import("maplibre-gl");
        if (dead) return;
        ml.setWorkerUrl(maplibreWorkerUrl);
        installTileProtocol(ml);
        mlRef.current = ml;
        const saved = useHunt.getState().lastView ?? DEFAULT_VIEW;
        const state = useHunt.getState();
        map = new ml.Map({
          container: el,
          style: buildStyle({
            basemap: state.basemap,
            showPublic: state.showPublic,
            showLabels: state.showLabels,
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
          canvasContextAttributes: { failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: true },
        });
        map.touchPitch.disable();
        const scale = new ml.ScaleControl({ maxWidth: 110, unit: state.imperial ? "imperial" : "metric" });
        scaleRef.current = scale;
        map.addControl(scale, "bottom-left");
        const fit = () => {
          if (map && !dead) fitStage(map, el);
        };
        observer = new ResizeObserver(fit);
        if (stageRef.current) observer.observe(stageRef.current);
        map.on("load", () => {
          if (dead || !map) return;
          mapRef.current = map;
          fit();
          if (useHunt.getState().terrain) {
            map.setTerrain({ source: "dem", exaggeration: 1.15 });
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
        });
        map.on("error", (event) => {
          const message = event.error?.message ?? "";
          if (/webgl|failed to initialize/i.test(message)) setMapError("This browser can't draw the map.");
        });
        map.on("click", (event) => onMapClickRef.current(event.lngLat.lng, event.lngLat.lat));
        map.on("dragstart", () => onDragRef.current());
        let last = 0;
        const publish = () => {
          if (!map) return;
          const now = performance.now();
          if (now - last < 80) return;
          last = now;
          const center = map.getCenter();
          onViewRef.current({
            lng: center.lng,
            lat: center.lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          });
        };
        map.on("move", publish);
        map.on("moveend", () => {
          last = 0;
          publish();
        });
        fit();
      } catch (error) {
        if (!dead) setMapError(error instanceof Error ? error.message : "Map failed to start.");
      }
    })();

    return () => {
      dead = true;
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
    const show = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", vis(on));
    const hybrid = props.basemap === "hybrid";
    const imagery = props.basemap === "satellite" || hybrid;
    const shade = props.showShade && imagery;
    show("hillshade", shade);
    show("satellite", imagery);
    show("topo", props.basemap === "topo");
    show("street", props.basemap === "street");
    show("roads", hybrid);
    show("places", hybrid && props.showLabels);
    show("sma", props.showPublic);
    map.setPaintProperty("sma", "raster-opacity", props.publicOpacity);
    map.setPaintProperty("satellite", "raster-opacity", shade ? 0.78 : 1);
  }, [ready, props.basemap, props.showPublic, props.showLabels, props.showShade, props.publicOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (props.terrain) {
      map.setTerrain({ source: "dem", exaggeration: 1.15 });
      map.touchPitch.enable();
      if (map.getPitch() < 20) map.easeTo({ pitch: 52, duration: 500 });
    } else {
      map.touchPitch.disable();
      map.setTerrain(null);
      if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 400 });
    }
  }, [ready, props.terrain]);

  useEffect(() => {
    scaleRef.current?.setUnit(props.imperial ? "imperial" : "metric");
  }, [props.imperial, ready]);

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
    const ml = mlRef.current;
    if (!ready || !map || !ml || !props.showUnits || props.unitLabels.length === 0) return;
    const entries = props.unitLabels.map((label) => {
      const el = document.createElement("div");
      el.className = "unit-tag";
      el.textContent = label.gmu;
      const marker = new ml.Marker({ element: el, anchor: "center" }).setLngLat([label.lng, label.lat]).addTo(map);
      return { marker, el, lng: label.lng, lat: label.lat };
    });
    const apply = () => {
      const zoom = map.getZoom();
      const bounds = map.getBounds();
      const show = zoom >= 8;
      for (const entry of entries) {
        entry.el.style.display = show && bounds.contains([entry.lng, entry.lat]) ? "" : "none";
      }
    };
    apply();
    map.on("move", apply);
    return () => {
      map.off("move", apply);
      for (const entry of entries) entry.marker.remove();
    };
  }, [ready, props.showUnits, props.unitLabels]);

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
    if (props.showScent && props.windFrom != null) {
      const drift = (props.windFrom + 180) % 360;
      features.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [sectorPolygon(props.scentAt.lng, props.scentAt.lat, scentReach(props.windMps), drift, 42)],
        },
      });
    }
    setGeo(map, "scent", { type: "FeatureCollection", features });
  }, [ready, props.showScent, props.windFrom, props.windMps, props.scentAt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const radii = props.imperial ? [91.44, 182.88, 365.76] : [100, 200, 400];
    const features: JsonFeature[] =
      props.showRings && props.ringAt
        ? radii.map((radius) => ({
            type: "Feature",
            properties: {},
            geometry: { type: "Polygon", coordinates: [circlePolygon(props.ringAt!.lng, props.ringAt!.lat, radius)] },
          }))
        : [];
    setGeo(map, "rings", { type: "FeatureCollection", features });
  }, [ready, props.showRings, props.ringAt, props.imperial]);

  return (
    <div ref={stageRef} className="map-stage">
      <div ref={containerRef} className={props.tool === "none" ? "h-full w-full" : "h-full w-full cursor-crosshair"} />
      {mapError ? <p className="absolute inset-x-6 top-1/2 z-10 -translate-y-1/2 text-center text-muted">{mapError}</p> : null}
    </div>
  );
});
