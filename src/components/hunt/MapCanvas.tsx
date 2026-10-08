import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { circlePolygon } from "@/lib/hunt/format";
import { MARKS } from "@/components/hunt/marks";
import type { Basemap, LngLat, MapView, Track, TrackPoint, Waypoint } from "@/lib/hunt/types";
import { DEFAULT_VIEW } from "@/lib/hunt/types";
import { useHunt } from "@/lib/hunt/store";

export type GpsFix = { lng: number; lat: number; accuracy: number; heading: number | null };

export type MapHandle = {
  easeTo: (lng: number, lat: number, zoom?: number) => void;
  fit: (points: LngLat[]) => void;
  getCenter: () => LngLat;
  resetNorth: () => void;
};

type Tool = "none" | "drop" | "measure";

type Props = {
  hydrated: boolean;
  basemap: Basemap;
  showPublic: boolean;
  publicOpacity: number;
  showLabels: boolean;
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
  publicOpacity: number;
}): StyleSpecification {
  const hybrid = opts.basemap === "hybrid";
  return {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      topo: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 16,
        attribution: "Topo © Esri, USGS, NOAA",
      },
      street: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap",
      },
      roads: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
      },
      places: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
      },
      sma: {
        type: "raster",
        tiles: ["https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 16,
        attribution: "Public land © BLM Surface Management Agency",
      },
      dem: {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
        attribution: "Terrain © AWS Terrain Tiles",
      },
      tracks: { type: "geojson", data: EMPTY },
      live: { type: "geojson", data: EMPTY },
      measure: { type: "geojson", data: EMPTY },
      accuracy: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: vis(opts.basemap === "satellite" || hybrid) } },
      { id: "topo", type: "raster", source: "topo", layout: { visibility: vis(opts.basemap === "topo") } },
      { id: "street", type: "raster", source: "street", layout: { visibility: vis(opts.basemap === "street") } },
      {
        id: "sma",
        type: "raster",
        source: "sma",
        layout: { visibility: vis(opts.showPublic) },
        paint: { "raster-opacity": opts.publicOpacity },
      },
      { id: "roads", type: "raster", source: "roads", layout: { visibility: vis(hybrid) } },
      { id: "places", type: "raster", source: "places", layout: { visibility: vis(hybrid && opts.showLabels) } },
      {
        id: "accuracy",
        type: "fill",
        source: "accuracy",
        paint: { "fill-color": "#d7e2c8", "fill-opacity": 0.18 },
      },
      {
        id: "accuracy-line",
        type: "line",
        source: "accuracy",
        paint: { "line-color": "#d7e2c8", "line-width": 1, "line-opacity": 0.75 },
      },
      { id: "tracks-casing", type: "line", source: "tracks", paint: { "line-color": "#121410", "line-width": 5 } },
      { id: "tracks", type: "line", source: "tracks", paint: { "line-color": "#d7e2c8", "line-width": 2.5 } },
      { id: "live-casing", type: "line", source: "live", paint: { "line-color": "#121410", "line-width": 5 } },
      {
        id: "live",
        type: "line",
        source: "live",
        paint: { "line-color": "#f3f1ea", "line-width": 2.5, "line-dasharray": [1.4, 1.2] },
      },
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
        paint: {
          "circle-radius": 4,
          "circle-color": "#f3f1ea",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#121410",
        },
      },
    ],
  };
}

function setGeo(map: MlMap, id: string, data: FC) {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  source?.setData(data);
}

export const MapCanvas = forwardRef<MapHandle, Props>(function MapCanvas(props, ref) {
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
      map.easeTo({
        center: [lng, lat],
        zoom: zoom ?? Math.max(map.getZoom(), 13),
        duration: 700,
      });
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
    resetNorth() {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({
        bearing: 0,
        pitch: terrainRef.current ? Math.max(map.getPitch(), 48) : 0,
        duration: 450,
      });
    },
  }));

  useEffect(() => {
    if (!props.hydrated || !containerRef.current) return;
    const el = containerRef.current;
    let map: MlMap | null = null;
    let dead = false;

    void (async () => {
      try {
        const ml = await import("maplibre-gl");
        if (dead) return;
        ml.setWorkerUrl(maplibreWorkerUrl);
        mlRef.current = ml;
        const saved = useHunt.getState().lastView ?? DEFAULT_VIEW;
        const state = useHunt.getState();
        map = new ml.Map({
          container: el,
          style: buildStyle({
            basemap: state.basemap,
            showPublic: state.showPublic,
            showLabels: state.showLabels,
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
        });
        map.touchPitch.disable();
        const scale = new ml.ScaleControl({ maxWidth: 110, unit: state.imperial ? "imperial" : "metric" });
        scaleRef.current = scale;
        map.addControl(scale, "bottom-left");
        map.on("load", () => {
          if (dead || !map) return;
          mapRef.current = map;
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
        });
        map.on("error", (event) => {
          const message = event.error?.message ?? "";
          if (/webgl/i.test(message)) setMapError("This browser can't draw the map.");
        });
        map.on("click", (event) => {
          onMapClickRef.current(event.lngLat.lng, event.lngLat.lat);
        });
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
      } catch (error) {
        if (!dead) setMapError(error instanceof Error ? error.message : "Map failed to start.");
      }
    })();

    return () => {
      dead = true;
      setReady(false);
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
    show("satellite", props.basemap === "satellite" || hybrid);
    show("topo", props.basemap === "topo");
    show("street", props.basemap === "street");
    show("roads", hybrid);
    show("places", hybrid && props.showLabels);
    show("sma", props.showPublic);
    map.setPaintProperty("sma", "raster-opacity", props.publicOpacity);
  }, [ready, props.basemap, props.showPublic, props.showLabels, props.publicOpacity]);

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
        const button = document.createElement("button");
        button.type = "button";
        button.className = `mark-pin ${meta.pinClass}${waypoint.id === props.selectedId ? " mark-pin-on" : ""}`;
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
  }, [ready, props.waypoints, props.showMarks, props.selectedId]);

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
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: props.livePoints.map((point) => [point.lng, point.lat]) },
            },
          ]
        : [];
    setGeo(map, "live", { type: "FeatureCollection", features });
  }, [ready, props.livePoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features: JsonFeature[] = [];
    const coords = props.measurePoints.map((point) => [point.lng, point.lat] as [number, number]);
    if (props.measureClosed && coords.length >= 3) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...coords, coords[0]]] },
      });
    } else if (coords.length >= 2) {
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    }
    for (const coord of coords) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coord } });
    }
    setGeo(map, "measure", { type: "FeatureCollection", features });
  }, [ready, props.measurePoints, props.measureClosed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const accuracy = props.gps?.accuracy ?? 0;
    const features: JsonFeature[] =
      props.gps && accuracy > 0 && accuracy < 4000
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates: [circlePolygon(props.gps.lng, props.gps.lat, accuracy)] },
            },
          ]
        : [];
    setGeo(map, "accuracy", { type: "FeatureCollection", features });
  }, [ready, props.gps]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className={`absolute inset-0 ${props.tool === "none" ? "" : "cursor-crosshair"}`} />
      {mapError ? (
        <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-muted">{mapError}</p>
      ) : null}
    </div>
  );
});
