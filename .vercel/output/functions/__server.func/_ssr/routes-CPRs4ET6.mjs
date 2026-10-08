import { i as __toESM } from "../_runtime.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { n as require_jsx_runtime } from "../_libs/radix-ui__react-context+react.mjs";
import { _ as Compass, a as Tent, b as Bookmark, c as MapPinned, d as Layers, f as Fence, g as Crosshair, h as DoorOpen, i as TreePine, l as MapPin, m as Download, n as Upload, o as Search, p as Droplets, s as Ruler, t as X, u as LocateFixed, v as Car, x as Binoculars, y as Camera } from "../_libs/lucide-react.mjs";
import { n as TSS_SERVER_FUNCTION, r as getServerFnById, t as createServerFn } from "./ssr.mjs";
import { n as SwitchThumb, t as Switch } from "../_libs/@radix-ui/react-switch+[...].mjs";
import { t as require_client } from "../_libs/react-dom+scheduler.mjs";
import { n as persist, r as create, t as createJSONStorage } from "../_libs/zustand.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-CPRs4ET6.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var import_client = require_client();
var maplibre_gl_worker_default = "/assets/maplibre-gl-worker-VaXr2Fck.mjs";
var R = 6371e3;
function haversine(a, b) {
	const φ1 = a.lat * Math.PI / 180;
	const φ2 = b.lat * Math.PI / 180;
	const dφ = (b.lat - a.lat) * Math.PI / 180;
	const dλ = (b.lng - a.lng) * Math.PI / 180;
	const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function pathLength(pts) {
	let meters = 0;
	for (let i = 1; i < pts.length; i++) meters += haversine(pts[i - 1], pts[i]);
	return meters;
}
function ringArea(pts) {
	if (pts.length < 3) return 0;
	const lat0 = pts.reduce((sum, p) => sum + p.lat, 0) / pts.length * (Math.PI / 180);
	const mPerDegLat = 111132;
	const mPerDegLng = 111320 * Math.cos(lat0);
	const xy = pts.map((p) => [p.lng * mPerDegLng, p.lat * mPerDegLat]);
	let area = 0;
	for (let i = 0; i < xy.length; i++) {
		const j = (i + 1) % xy.length;
		area += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1];
	}
	return Math.abs(area) / 2;
}
function formatDistance(meters, imperial) {
	if (!Number.isFinite(meters)) return "—";
	if (!imperial) {
		if (meters < 1e3) return `${Math.round(meters)} m`;
		const km = meters / 1e3;
		return `${km.toFixed(km < 10 ? 2 : 1)} km`;
	}
	const miles = meters / 1609.344;
	if (miles >= 1) return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
	return `${Math.round(meters * 1.0936133)} yd`;
}
function formatArea(m2, imperial) {
	if (!Number.isFinite(m2) || m2 <= 0) return "—";
	if (!imperial) {
		const ha = m2 / 1e4;
		if (ha < 1) return `${Math.round(m2)} m²`;
		return `${ha.toFixed(ha < 10 ? 2 : 1)} ha`;
	}
	const acres = m2 / 4046.8564224;
	if (acres < .1) return `${Math.round(m2 * 10.7639104)} ft²`;
	return `${acres.toFixed(acres < 10 ? 2 : 1)} ac`;
}
function formatElev(meters, imperial) {
	if (!Number.isFinite(meters)) return "—";
	if (!imperial) return `${Math.round(meters).toLocaleString("en-US")} m`;
	return `${Math.round(meters * 3.28084).toLocaleString("en-US")} ft`;
}
function toDms(value, lat) {
	const hemi = lat ? value >= 0 ? "N" : "S" : value >= 0 ? "E" : "W";
	const abs = Math.abs(value);
	const deg = Math.floor(abs);
	const minFloat = (abs - deg) * 60;
	const min = Math.floor(minFloat);
	const sec = (minFloat - min) * 60;
	return `${deg}°${String(min).padStart(2, "0")}′${sec.toFixed(0).padStart(2, "0")}″${hemi}`;
}
function formatDd(lng, lat) {
	return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}   ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? "E" : "W"}`;
}
function formatDms(lng, lat) {
	return `${toDms(lat, true)}   ${toDms(lng, false)}`;
}
function formatPair(lng, lat) {
	return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function bearingDeg(a, b) {
	const φ1 = a.lat * Math.PI / 180;
	const φ2 = b.lat * Math.PI / 180;
	const Δλ = (b.lng - a.lng) * Math.PI / 180;
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
var DIRS = [
	"N",
	"NNE",
	"NE",
	"ENE",
	"E",
	"ESE",
	"SE",
	"SSE",
	"S",
	"SSW",
	"SW",
	"WSW",
	"W",
	"WNW",
	"NW",
	"NNW"
];
function cardinal(deg) {
	const wrapped = (deg % 360 + 360) % 360;
	return DIRS[Math.round(wrapped / 22.5) % 16];
}
function formatClock(iso) {
	if (!iso) return "—";
	const time = iso.split("T")[1]?.slice(0, 5);
	if (!time) return "—";
	const [hRaw, mRaw] = time.split(":");
	const h = Number(hRaw);
	const m = Number(mRaw);
	if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
	return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function formatDuration(ms) {
	const total = Math.max(0, Math.floor(ms / 1e3));
	const h = Math.floor(total / 3600);
	const m = Math.floor(total % 3600 / 60);
	const s = total % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}
function circlePolygon(lng, lat, radiusM, steps = 64) {
	const coords = [];
	const mPerDegLat = 111132;
	const mPerDegLng = Math.max(1, 111320 * Math.cos(lat * Math.PI / 180));
	for (let i = 0; i <= steps; i++) {
		const θ = i / steps * Math.PI * 2;
		const dx = Math.cos(θ) * radiusM;
		const dy = Math.sin(θ) * radiusM;
		coords.push([lng + dx / mPerDegLng, lat + dy / mPerDegLat]);
	}
	return coords;
}
function cToF(c) {
	return c * 9 / 5 + 32;
}
function mpsToMph(mps) {
	return mps * 2.236936;
}
var MARK_ORDER = [
	"stand",
	"blind",
	"camp",
	"camera",
	"parking",
	"gate",
	"water",
	"glass",
	"pin"
];
var MARKS = {
	stand: {
		label: "Stand",
		icon: TreePine,
		pinClass: "bg-mark-stand text-accent-fg"
	},
	blind: {
		label: "Blind",
		icon: Fence,
		pinClass: "bg-mark-blind text-fg"
	},
	camp: {
		label: "Camp",
		icon: Tent,
		pinClass: "bg-mark-camp text-accent-fg"
	},
	camera: {
		label: "Camera",
		icon: Camera,
		pinClass: "bg-mark-camera text-fg"
	},
	parking: {
		label: "Parking",
		icon: Car,
		pinClass: "bg-mark-parking text-fg"
	},
	gate: {
		label: "Gate",
		icon: DoorOpen,
		pinClass: "bg-mark-gate text-fg"
	},
	water: {
		label: "Water",
		icon: Droplets,
		pinClass: "bg-mark-water text-fg"
	},
	glass: {
		label: "Glass",
		icon: Binoculars,
		pinClass: "bg-mark-glass text-accent-fg"
	},
	pin: {
		label: "Pin",
		icon: MapPin,
		pinClass: "bg-mark-pin text-accent-fg"
	}
};
var JUMPS = [
	{
		name: "Four Peaks",
		hint: "Tonto",
		lng: -111.32,
		lat: 33.68,
		zoom: 11
	},
	{
		name: "Mogollon Rim",
		hint: "Payson",
		lng: -111.2,
		lat: 34.42,
		zoom: 10
	},
	{
		name: "White Mountains",
		hint: "Eastern AZ",
		lng: -109.45,
		lat: 33.9,
		zoom: 9
	},
	{
		name: "Kaibab Plateau",
		hint: "North Kaibab",
		lng: -112.15,
		lat: 36.6,
		zoom: 9
	},
	{
		name: "Arizona Strip",
		hint: "BLM",
		lng: -113.3,
		lat: 36.65,
		zoom: 8
	},
	{
		name: "Wind River",
		hint: "Wyoming",
		lng: -109.4,
		lat: 43.2,
		zoom: 9
	},
	{
		name: "Pike Forest",
		hint: "Colorado",
		lng: -105.2,
		lat: 39.15,
		zoom: 9
	}
];
var DEFAULT_VIEW = {
	lng: -111.38,
	lat: 33.95,
	zoom: 9,
	bearing: 0,
	pitch: 0
};
var useHunt = create()(persist((set) => ({
	waypoints: [],
	tracks: [],
	basemap: "hybrid",
	showPublic: true,
	publicOpacity: .62,
	showLabels: true,
	terrain: false,
	showMarks: true,
	imperial: true,
	lastKind: "stand",
	activeHunt: "",
	introDismissed: false,
	lastView: null,
	addWaypoint: (waypoint) => set((s) => ({ waypoints: [waypoint, ...s.waypoints] })),
	updateWaypoint: (id, patch) => set((s) => ({ waypoints: s.waypoints.map((w) => w.id === id ? {
		...w,
		...patch
	} : w) })),
	removeWaypoint: (id) => set((s) => ({ waypoints: s.waypoints.filter((w) => w.id !== id) })),
	addTrack: (track) => set((s) => ({ tracks: [track, ...s.tracks] })),
	toggleTrack: (id) => set((s) => ({ tracks: s.tracks.map((t) => t.id === id ? {
		...t,
		visible: !t.visible
	} : t) })),
	removeTrack: (id) => set((s) => ({ tracks: s.tracks.filter((t) => t.id !== id) })),
	importAll: (waypoints, tracks) => set((s) => ({
		waypoints: [...waypoints, ...s.waypoints],
		tracks: [...tracks, ...s.tracks]
	})),
	setBasemap: (basemap) => set({ basemap }),
	setShowPublic: (showPublic) => set({ showPublic }),
	setPublicOpacity: (publicOpacity) => set({ publicOpacity }),
	setShowLabels: (showLabels) => set({ showLabels }),
	setTerrain: (terrain) => set({ terrain }),
	setShowMarks: (showMarks) => set({ showMarks }),
	setImperial: (imperial) => set({ imperial }),
	setLastKind: (lastKind) => set({ lastKind }),
	setActiveHunt: (activeHunt) => set({ activeHunt }),
	dismissIntro: () => set({ introDismissed: true }),
	setLastView: (lastView) => set({ lastView })
}), {
	name: "fieldline-v1",
	storage: createJSONStorage(() => localStorage),
	skipHydration: true,
	partialize: (s) => ({
		waypoints: s.waypoints,
		tracks: s.tracks,
		basemap: s.basemap,
		showPublic: s.showPublic,
		publicOpacity: s.publicOpacity,
		showLabels: s.showLabels,
		terrain: s.terrain,
		showMarks: s.showMarks,
		imperial: s.imperial,
		lastKind: s.lastKind,
		activeHunt: s.activeHunt,
		introDismissed: s.introDismissed,
		lastView: s.lastView
	})
}));
var EMPTY = {
	type: "FeatureCollection",
	features: []
};
function vis(on) {
	return on ? "visible" : "none";
}
function buildStyle(opts) {
	const hybrid = opts.basemap === "hybrid";
	return {
		version: 8,
		sources: {
			satellite: {
				type: "raster",
				tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
				tileSize: 256,
				maxzoom: 19,
				attribution: "Imagery © Esri, Maxar, Earthstar Geographics"
			},
			topo: {
				type: "raster",
				tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
				tileSize: 256,
				maxzoom: 16,
				attribution: "Topo © Esri, USGS, NOAA"
			},
			street: {
				type: "raster",
				tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
				tileSize: 256,
				maxzoom: 19,
				attribution: "© OpenStreetMap"
			},
			roads: {
				type: "raster",
				tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
				tileSize: 256,
				maxzoom: 19
			},
			places: {
				type: "raster",
				tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
				tileSize: 256,
				maxzoom: 19
			},
			sma: {
				type: "raster",
				tiles: ["https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}"],
				tileSize: 256,
				maxzoom: 16,
				attribution: "Public land © BLM Surface Management Agency"
			},
			dem: {
				type: "raster-dem",
				tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
				encoding: "terrarium",
				tileSize: 256,
				maxzoom: 15,
				attribution: "Terrain © AWS Terrain Tiles"
			},
			tracks: {
				type: "geojson",
				data: EMPTY
			},
			live: {
				type: "geojson",
				data: EMPTY
			},
			measure: {
				type: "geojson",
				data: EMPTY
			},
			accuracy: {
				type: "geojson",
				data: EMPTY
			}
		},
		layers: [
			{
				id: "satellite",
				type: "raster",
				source: "satellite",
				layout: { visibility: vis(opts.basemap === "satellite" || hybrid) }
			},
			{
				id: "topo",
				type: "raster",
				source: "topo",
				layout: { visibility: vis(opts.basemap === "topo") }
			},
			{
				id: "street",
				type: "raster",
				source: "street",
				layout: { visibility: vis(opts.basemap === "street") }
			},
			{
				id: "sma",
				type: "raster",
				source: "sma",
				layout: { visibility: vis(opts.showPublic) },
				paint: { "raster-opacity": opts.publicOpacity }
			},
			{
				id: "roads",
				type: "raster",
				source: "roads",
				layout: { visibility: vis(hybrid) }
			},
			{
				id: "places",
				type: "raster",
				source: "places",
				layout: { visibility: vis(hybrid && opts.showLabels) }
			},
			{
				id: "accuracy",
				type: "fill",
				source: "accuracy",
				paint: {
					"fill-color": "#d7e2c8",
					"fill-opacity": .18
				}
			},
			{
				id: "accuracy-line",
				type: "line",
				source: "accuracy",
				paint: {
					"line-color": "#d7e2c8",
					"line-width": 1,
					"line-opacity": .75
				}
			},
			{
				id: "tracks-casing",
				type: "line",
				source: "tracks",
				paint: {
					"line-color": "#121410",
					"line-width": 5
				}
			},
			{
				id: "tracks",
				type: "line",
				source: "tracks",
				paint: {
					"line-color": "#d7e2c8",
					"line-width": 2.5
				}
			},
			{
				id: "live-casing",
				type: "line",
				source: "live",
				paint: {
					"line-color": "#121410",
					"line-width": 5
				}
			},
			{
				id: "live",
				type: "line",
				source: "live",
				paint: {
					"line-color": "#f3f1ea",
					"line-width": 2.5,
					"line-dasharray": [1.4, 1.2]
				}
			},
			{
				id: "measure-fill",
				type: "fill",
				source: "measure",
				filter: [
					"==",
					["geometry-type"],
					"Polygon"
				],
				paint: {
					"fill-color": "#d7e2c8",
					"fill-opacity": .22
				}
			},
			{
				id: "measure-casing",
				type: "line",
				source: "measure",
				paint: {
					"line-color": "#121410",
					"line-width": 5
				}
			},
			{
				id: "measure",
				type: "line",
				source: "measure",
				paint: {
					"line-color": "#f3f1ea",
					"line-width": 2
				}
			},
			{
				id: "measure-pts",
				type: "circle",
				source: "measure",
				filter: [
					"==",
					["geometry-type"],
					"Point"
				],
				paint: {
					"circle-radius": 4,
					"circle-color": "#f3f1ea",
					"circle-stroke-width": 2,
					"circle-stroke-color": "#121410"
				}
			}
		]
	};
}
function setGeo(map, id, data) {
	map.getSource(id)?.setData(data);
}
var MapCanvas = (0, import_react.forwardRef)(function MapCanvas(props, ref) {
	const containerRef = (0, import_react.useRef)(null);
	const mapRef = (0, import_react.useRef)(null);
	const mlRef = (0, import_react.useRef)(null);
	const scaleRef = (0, import_react.useRef)(null);
	const onMapClickRef = (0, import_react.useRef)(props.onMapClick);
	const onMarkerClickRef = (0, import_react.useRef)(props.onMarkerClick);
	const onViewRef = (0, import_react.useRef)(props.onView);
	const onDragRef = (0, import_react.useRef)(props.onDragStart);
	const terrainRef = (0, import_react.useRef)(props.terrain);
	const [ready, setReady] = (0, import_react.useState)(false);
	const [mapError, setMapError] = (0, import_react.useState)(null);
	onMapClickRef.current = props.onMapClick;
	onMarkerClickRef.current = props.onMarkerClick;
	onViewRef.current = props.onView;
	onDragRef.current = props.onDragStart;
	terrainRef.current = props.terrain;
	(0, import_react.useImperativeHandle)(ref, () => ({
		easeTo(lng, lat, zoom) {
			const map = mapRef.current;
			if (!map) return;
			map.easeTo({
				center: [lng, lat],
				zoom: zoom ?? Math.max(map.getZoom(), 13),
				duration: 700
			});
		},
		fit(points) {
			const map = mapRef.current;
			if (!map || points.length === 0) return;
			if (points.length === 1) {
				map.easeTo({
					center: [points[0].lng, points[0].lat],
					zoom: Math.max(map.getZoom(), 14),
					duration: 700
				});
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
			map.fitBounds([[west, south], [east, north]], {
				padding: 72,
				duration: 700,
				maxZoom: 15
			});
		},
		getCenter() {
			const center = mapRef.current?.getCenter();
			return center ? {
				lng: center.lng,
				lat: center.lat
			} : {
				lng: DEFAULT_VIEW.lng,
				lat: DEFAULT_VIEW.lat
			};
		},
		resetNorth() {
			const map = mapRef.current;
			if (!map) return;
			map.easeTo({
				bearing: 0,
				pitch: terrainRef.current ? Math.max(map.getPitch(), 48) : 0,
				duration: 450
			});
		}
	}));
	(0, import_react.useEffect)(() => {
		if (!props.hydrated || !containerRef.current) return;
		const el = containerRef.current;
		let map = null;
		let dead = false;
		(async () => {
			try {
				const ml = await import("../_libs/maplibre-gl.mjs").then((n) => n.t);
				if (dead) return;
				ml.setWorkerUrl(maplibre_gl_worker_default);
				mlRef.current = ml;
				const saved = useHunt.getState().lastView ?? DEFAULT_VIEW;
				const state = useHunt.getState();
				map = new ml.Map({
					container: el,
					style: buildStyle({
						basemap: state.basemap,
						showPublic: state.showPublic,
						showLabels: state.showLabels,
						publicOpacity: state.publicOpacity
					}),
					center: [saved.lng, saved.lat],
					zoom: saved.zoom,
					bearing: saved.bearing,
					pitch: saved.pitch,
					maxPitch: 72,
					attributionControl: { compact: true },
					maplibreLogo: false,
					fadeDuration: 0
				});
				map.touchPitch.disable();
				const scale = new ml.ScaleControl({
					maxWidth: 110,
					unit: state.imperial ? "imperial" : "metric"
				});
				scaleRef.current = scale;
				map.addControl(scale, "bottom-left");
				map.on("load", () => {
					if (dead || !map) return;
					mapRef.current = map;
					if (useHunt.getState().terrain) {
						map.setTerrain({
							source: "dem",
							exaggeration: 1.15
						});
						map.touchPitch.enable();
					}
					const center = map.getCenter();
					onViewRef.current({
						lng: center.lng,
						lat: center.lat,
						zoom: map.getZoom(),
						bearing: map.getBearing(),
						pitch: map.getPitch()
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
						pitch: map.getPitch()
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
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		const show = (id, on) => map.setLayoutProperty(id, "visibility", vis(on));
		const hybrid = props.basemap === "hybrid";
		show("satellite", props.basemap === "satellite" || hybrid);
		show("topo", props.basemap === "topo");
		show("street", props.basemap === "street");
		show("roads", hybrid);
		show("places", hybrid && props.showLabels);
		show("sma", props.showPublic);
		map.setPaintProperty("sma", "raster-opacity", props.publicOpacity);
	}, [
		ready,
		props.basemap,
		props.showPublic,
		props.showLabels,
		props.publicOpacity
	]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		if (props.terrain) {
			map.setTerrain({
				source: "dem",
				exaggeration: 1.15
			});
			map.touchPitch.enable();
			if (map.getPitch() < 20) map.easeTo({
				pitch: 52,
				duration: 500
			});
		} else {
			map.touchPitch.disable();
			map.setTerrain(null);
			if (map.getPitch() > 0) map.easeTo({
				pitch: 0,
				duration: 400
			});
		}
	}, [ready, props.terrain]);
	(0, import_react.useEffect)(() => {
		scaleRef.current?.setUnit(props.imperial ? "imperial" : "metric");
	}, [props.imperial, ready]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		if (props.tool === "drop" || props.tool === "measure") map.doubleClickZoom.disable();
		else map.doubleClickZoom.enable();
	}, [ready, props.tool]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		const ml = mlRef.current;
		if (!ready || !map || !ml) return;
		const entries = [];
		if (props.showMarks) for (const waypoint of props.waypoints) {
			const meta = MARKS[waypoint.kind];
			const button = document.createElement("button");
			button.type = "button";
			button.className = `mark-pin ${meta.pinClass}${waypoint.id === props.selectedId ? " mark-pin-on" : ""}`;
			button.setAttribute("aria-label", waypoint.name);
			const slot = document.createElement("span");
			slot.className = "grid place-items-center";
			button.appendChild(slot);
			const root = (0, import_client.createRoot)(slot);
			const Icon = meta.icon;
			root.render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, {
				className: "size-4",
				strokeWidth: 2.25,
				"aria-hidden": true
			}));
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				onMarkerClickRef.current(waypoint.id);
			});
			const marker = new ml.Marker({
				element: button,
				anchor: "center"
			}).setLngLat([waypoint.lng, waypoint.lat]).addTo(map);
			entries.push({
				marker,
				root
			});
		}
		return () => {
			for (const entry of entries) {
				entry.root.unmount();
				entry.marker.remove();
			}
		};
	}, [
		ready,
		props.waypoints,
		props.showMarks,
		props.selectedId
	]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		const ml = mlRef.current;
		if (!ready || !map || !ml || !props.gps) return;
		const button = document.createElement("div");
		button.className = "gps-dot";
		button.setAttribute("aria-hidden", "true");
		const marker = new ml.Marker({
			element: button,
			rotationAlignment: "map",
			pitchAlignment: "map"
		}).setLngLat([props.gps.lng, props.gps.lat]).setRotation(props.gps.heading ?? 0).addTo(map);
		return () => {
			marker.remove();
		};
	}, [ready, props.gps]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		setGeo(map, "tracks", {
			type: "FeatureCollection",
			features: props.tracks.filter((track) => track.visible && track.points.length > 1).map((track) => ({
				type: "Feature",
				properties: { id: track.id },
				geometry: {
					type: "LineString",
					coordinates: track.points.map((point) => [point.lng, point.lat])
				}
			}))
		});
	}, [ready, props.tracks]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		setGeo(map, "live", {
			type: "FeatureCollection",
			features: props.livePoints.length > 1 ? [{
				type: "Feature",
				properties: {},
				geometry: {
					type: "LineString",
					coordinates: props.livePoints.map((point) => [point.lng, point.lat])
				}
			}] : []
		});
	}, [ready, props.livePoints]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		const features = [];
		const coords = props.measurePoints.map((point) => [point.lng, point.lat]);
		if (props.measureClosed && coords.length >= 3) features.push({
			type: "Feature",
			properties: {},
			geometry: {
				type: "Polygon",
				coordinates: [[...coords, coords[0]]]
			}
		});
		else if (coords.length >= 2) features.push({
			type: "Feature",
			properties: {},
			geometry: {
				type: "LineString",
				coordinates: coords
			}
		});
		for (const coord of coords) features.push({
			type: "Feature",
			properties: {},
			geometry: {
				type: "Point",
				coordinates: coord
			}
		});
		setGeo(map, "measure", {
			type: "FeatureCollection",
			features
		});
	}, [
		ready,
		props.measurePoints,
		props.measureClosed
	]);
	(0, import_react.useEffect)(() => {
		const map = mapRef.current;
		if (!ready || !map) return;
		const accuracy = props.gps?.accuracy ?? 0;
		setGeo(map, "accuracy", {
			type: "FeatureCollection",
			features: props.gps && accuracy > 0 && accuracy < 4e3 ? [{
				type: "Feature",
				properties: {},
				geometry: {
					type: "Polygon",
					coordinates: [circlePolygon(props.gps.lng, props.gps.lat, accuracy)]
				}
			}] : []
		});
	}, [ready, props.gps]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "absolute inset-0",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			ref: containerRef,
			className: `absolute inset-0 ${props.tool === "none" ? "" : "cursor-crosshair"}`
		}), mapError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
			className: "absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-muted",
			children: mapError
		}) : null]
	});
});
var KINDS = /* @__PURE__ */ new Set([
	"stand",
	"blind",
	"camp",
	"camera",
	"parking",
	"gate",
	"water",
	"glass",
	"pin"
]);
function esc(value) {
	return value.replace(/[&<>"]/g, (ch) => {
		if (ch === "&") return "&amp;";
		if (ch === "<") return "&lt;";
		if (ch === ">") return "&gt;";
		return "&quot;";
	});
}
function toGpx(waypoints, tracks) {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Fieldline" xmlns="http://www.topografix.com/GPX/1/1">\n${waypoints.map((w) => `  <wpt lat="${w.lat}" lon="${w.lng}"><name>${esc(w.name)}</name><desc>${esc(w.notes)}</desc><type>${w.kind}</type>${w.hunt ? `<cmt>${esc(w.hunt)}</cmt>` : ""}</wpt>`).join("\n")}\n${tracks.map((track) => {
		const pts = track.points.map((p) => `        <trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join("\n");
		return `  <trk><name>${esc(track.name)}</name><trkseg>\n${pts}\n      </trkseg></trk>`;
	}).join("\n")}\n</gpx>\n`;
}
function parseGpx(text) {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	if (doc.querySelector("parsererror")) throw new Error("That file is not GPX.");
	const waypoints = [...doc.getElementsByTagName("wpt")].flatMap((node) => {
		const lat = Number(node.getAttribute("lat"));
		const lng = Number(node.getAttribute("lon"));
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
		const kindRaw = (node.getElementsByTagName("type")[0]?.textContent ?? "pin").trim().toLowerCase();
		const kind = KINDS.has(kindRaw) ? kindRaw : "pin";
		return [{
			name: (node.getElementsByTagName("name")[0]?.textContent ?? "Mark").trim().slice(0, 60) || "Mark",
			kind,
			lng,
			lat,
			notes: (node.getElementsByTagName("desc")[0]?.textContent ?? "").trim().slice(0, 500),
			hunt: (node.getElementsByTagName("cmt")[0]?.textContent ?? "").trim().slice(0, 40)
		}];
	});
	const tracks = [...doc.getElementsByTagName("trk")].flatMap((node) => {
		const points = [...node.getElementsByTagName("trkpt")].flatMap((pt) => {
			const lat = Number(pt.getAttribute("lat"));
			const lng = Number(pt.getAttribute("lon"));
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
			const time = pt.getElementsByTagName("time")[0]?.textContent;
			const t = time ? Date.parse(time) : Date.now();
			return [{
				lng,
				lat,
				t: Number.isFinite(t) ? t : Date.now()
			}];
		});
		if (points.length < 2) return [];
		return [{
			name: (node.getElementsByTagName("name")[0]?.textContent ?? "Track").trim().slice(0, 60) || "Track",
			points
		}];
	});
	if (waypoints.length === 0 && tracks.length === 0) throw new Error("No waypoints or tracks in that file.");
	return {
		waypoints,
		tracks
	};
}
var AGENCIES = {
	BLM: {
		label: "Bureau of Land Management",
		swatch: "#f8e078",
		tone: "public"
	},
	USFS: {
		label: "US Forest Service",
		swatch: "#c8e8c0",
		tone: "public"
	},
	NPS: {
		label: "National Park Service",
		swatch: "#c8b8d8",
		tone: "park"
	},
	USFW: {
		label: "US Fish & Wildlife",
		swatch: "#9fd0c8",
		tone: "refuge"
	},
	FWS: {
		label: "US Fish & Wildlife",
		swatch: "#9fd0c8",
		tone: "refuge"
	},
	USBR: {
		label: "Bureau of Reclamation",
		swatch: "#9ec4d8",
		tone: "public"
	},
	BOR: {
		label: "Bureau of Reclamation",
		swatch: "#9ec4d8",
		tone: "public"
	},
	DOD: {
		label: "Department of Defense",
		swatch: "#f8b0c8",
		tone: "restricted"
	},
	BIA: {
		label: "Bureau of Indian Affairs",
		swatch: "#f8b068",
		tone: "tribal"
	},
	STATE: {
		label: "State land",
		swatch: "#b0e0e8",
		tone: "state"
	},
	STAT: {
		label: "State land",
		swatch: "#b0e0e8",
		tone: "state"
	},
	ST: {
		label: "State land",
		swatch: "#b0e0e8",
		tone: "state"
	},
	LOCAL: {
		label: "Local government",
		swatch: "#d8d4c8",
		tone: "public"
	},
	LOC: {
		label: "Local government",
		swatch: "#d8d4c8",
		tone: "public"
	},
	OTHF: {
		label: "Other federal",
		swatch: "#d0d0c8",
		tone: "public"
	}
};
var LEGEND = [
	{
		label: "BLM",
		swatch: "#f8e078"
	},
	{
		label: "Forest Service",
		swatch: "#c8e8c0"
	},
	{
		label: "Park Service",
		swatch: "#c8b8d8"
	},
	{
		label: "Fish & Wildlife",
		swatch: "#9fd0c8"
	},
	{
		label: "State",
		swatch: "#b0e0e8"
	},
	{
		label: "Tribal",
		swatch: "#f8b068"
	},
	{
		label: "Defense",
		swatch: "#f8b0c8"
	}
];
function noteFor(tone, state) {
	if (tone === "park") return "National Park land. Hunting is prohibited in most parks.";
	if (tone === "refuge") return "Wildlife refuge. Hunt only where that refuge allows it.";
	if (tone === "restricted") return "Military land. Stay out unless the range is open.";
	if (tone === "tribal") return "Tribal land, not public. Access follows tribal rules only.";
	if (tone === "state") return state === "AZ" ? "Arizona State Trust land needs a recreation permit." : "State land. Permits and rules change by state.";
	if (tone === "private") return "Private surface. Get permission before you cross.";
	if (tone === "unknown") return "No agency polygon here. Treat it as private until you verify.";
	return "Public surface. Seasons, weapons, and closures still apply.";
}
function clean(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "null") return null;
	return trimmed;
}
function toHit(raw) {
	const attrs = raw.attributes ?? {};
	const code = (clean(attrs.ADMIN_AGENCY_CODE) ?? "").toUpperCase();
	if (!code || code === "PVT") return null;
	const meta = AGENCIES[code] ?? {
		label: clean(raw.layerName) ?? code,
		swatch: "#d0d0c8",
		tone: "public"
	};
	const state = clean(attrs.ADMIN_ST);
	const area = Number(attrs.Shape_Area);
	return {
		agency: code,
		label: meta.label,
		swatch: meta.swatch,
		tone: meta.tone,
		state,
		unit: clean(attrs.ADMIN_UNIT_NAME),
		note: noteFor(meta.tone, state),
		area: Number.isFinite(area) ? area : Number.POSITIVE_INFINITY
	};
}
async function identifyLand(lng, lat, signal) {
	const pad = .008;
	const layers = lat > 51 ? "all:4,5,6,7,8,9,10,11,12,13,14,15" : "all:6,7,8,9,10,11,12,13,14,15";
	const params = new URLSearchParams({
		geometry: `${lng},${lat}`,
		geometryType: "esriGeometryPoint",
		sr: "4326",
		layers,
		tolerance: "2",
		mapExtent: `${lng - pad},${lat - pad},${lng + pad},${lat + pad}`,
		imageDisplay: "400,400,96",
		returnGeometry: "false",
		f: "json"
	});
	const res = await fetch(`https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/identify?${params}`, { signal });
	if (!res.ok) throw new Error("Land service unavailable");
	const hits = ((await res.json()).results ?? []).map(toHit).filter((hit) => hit !== null).sort((a, b) => a.area - b.area);
	const unique = [];
	for (const hit of hits) if (!unique.some((item) => item.agency === hit.agency)) unique.push(hit);
	const primary = unique[0];
	if (!primary) return {
		agency: "PVT",
		label: "Likely private",
		swatch: null,
		tone: "private",
		state: null,
		unit: null,
		note: noteFor("private", null)
	};
	const extra = unique.slice(1, 3).map((hit) => hit.label).join(", ");
	return {
		agency: primary.agency,
		label: primary.label,
		swatch: primary.swatch,
		tone: primary.tone,
		state: primary.state,
		unit: primary.unit,
		note: extra ? `${primary.note} Also nearby: ${extra}.` : primary.note
	};
}
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
function trimQuery(input) {
	return {
		q: (input.q ?? "").trim().slice(0, 80),
		lng: typeof input.lng === "number" ? input.lng : -111.38,
		lat: typeof input.lat === "number" ? input.lat : 33.95
	};
}
var searchPlaces = createServerFn({ method: "GET" }).validator(trimQuery).handler(createSsrRpc("5ba6f415d28131cd8d41ad398db534ee47cf75a14e79245f88731dee521aef86"));
async function fetchFieldWeather(lng, lat, signal) {
	const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
	forecastUrl.searchParams.set("latitude", lat.toFixed(4));
	forecastUrl.searchParams.set("longitude", lng.toFixed(4));
	forecastUrl.searchParams.set("current", "temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m");
	forecastUrl.searchParams.set("daily", "sunrise,sunset");
	forecastUrl.searchParams.set("timezone", "auto");
	forecastUrl.searchParams.set("forecast_days", "1");
	forecastUrl.searchParams.set("wind_speed_unit", "ms");
	const elevUrl = new URL("https://api.open-meteo.com/v1/elevation");
	elevUrl.searchParams.set("latitude", lat.toFixed(4));
	elevUrl.searchParams.set("longitude", lng.toFixed(4));
	const [forecastRes, elevRes] = await Promise.all([fetch(forecastUrl, { signal }), fetch(elevUrl, { signal })]);
	if (!forecastRes.ok) throw new Error("Weather unavailable");
	const forecast = await forecastRes.json();
	let elevationM = null;
	if (elevRes.ok) {
		const value = (await elevRes.json()).elevation?.[0];
		elevationM = typeof value === "number" ? value : null;
	}
	const current = forecast.current ?? {};
	return {
		tempC: current.temperature_2m ?? 0,
		windMps: current.wind_speed_10m ?? 0,
		gustMps: current.wind_gusts_10m ?? 0,
		windFrom: current.wind_direction_10m ?? 0,
		sunrise: forecast.daily?.sunrise?.[0] ?? null,
		sunset: forecast.daily?.sunset?.[0] ?? null,
		elevationM
	};
}
var BASEMAPS = [
	{
		id: "hybrid",
		label: "Hybrid"
	},
	{
		id: "satellite",
		label: "Satellite"
	},
	{
		id: "topo",
		label: "Topo"
	},
	{
		id: "street",
		label: "Street"
	}
];
function HuntApp() {
	const store = useHunt();
	const mapRef = (0, import_react.useRef)(null);
	const watchRef = (0, import_react.useRef)(null);
	const followRef = (0, import_react.useRef)(false);
	const recRef = (0, import_react.useRef)(false);
	const lastRecRef = (0, import_react.useRef)(null);
	const fileRef = (0, import_react.useRef)(null);
	const searchReq = (0, import_react.useRef)(0);
	const landAbort = (0, import_react.useRef)(null);
	const [hydrated, setHydrated] = (0, import_react.useState)(false);
	const [view, setView] = (0, import_react.useState)(DEFAULT_VIEW);
	const [tool, setTool] = (0, import_react.useState)("none");
	const [sheet, setSheet] = (0, import_react.useState)(null);
	const [selectedId, setSelectedId] = (0, import_react.useState)(null);
	const [measurePts, setMeasurePts] = (0, import_react.useState)([]);
	const [measureClosed, setMeasureClosed] = (0, import_react.useState)(false);
	const [gps, setGps] = (0, import_react.useState)(null);
	const [gpsError, setGpsError] = (0, import_react.useState)(null);
	const [follow, setFollow] = (0, import_react.useState)(false);
	const [recording, setRecording] = (0, import_react.useState)(false);
	const [recPts, setRecPts] = (0, import_react.useState)([]);
	const [recStart, setRecStart] = (0, import_react.useState)(null);
	const [now, setNow] = (0, import_react.useState)(() => Date.now());
	const [land, setLand] = (0, import_react.useState)(null);
	const [weather, setWeather] = (0, import_react.useState)(null);
	const [query, setQuery] = (0, import_react.useState)("");
	const [hits, setHits] = (0, import_react.useState)([]);
	const [searchOpen, setSearchOpen] = (0, import_react.useState)(false);
	const [searching, setSearching] = (0, import_react.useState)(false);
	const [notice, setNotice] = (0, import_react.useState)(null);
	const [coordMode, setCoordMode] = (0, import_react.useState)("dd");
	const selected = store.waypoints.find((waypoint) => waypoint.id === selectedId) ?? null;
	(0, import_react.useEffect)(() => {
		let live = true;
		Promise.resolve(useHunt.persist.rehydrate()).then(() => {
			if (!live) return;
			const saved = useHunt.getState().lastView;
			if (saved) setView(saved);
			setHydrated(true);
		});
		return () => {
			live = false;
		};
	}, []);
	(0, import_react.useEffect)(() => {
		return () => {
			if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
		};
	}, []);
	(0, import_react.useEffect)(() => {
		if (!recording || recStart == null) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1e3);
		return () => window.clearInterval(timer);
	}, [recording, recStart]);
	(0, import_react.useEffect)(() => {
		if (!hydrated) return;
		const timer = window.setTimeout(() => useHunt.getState().setLastView(view), 700);
		return () => window.clearTimeout(timer);
	}, [view, hydrated]);
	const weatherKey = `${view.lat.toFixed(2)},${view.lng.toFixed(2)}`;
	(0, import_react.useEffect)(() => {
		if (!hydrated) return;
		const [lat, lng] = weatherKey.split(",").map(Number);
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			fetchFieldWeather(lng, lat, controller.signal).then(setWeather).catch(() => {
				if (!controller.signal.aborted) setWeather(null);
			});
		}, 500);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [hydrated, weatherKey]);
	const viewRef = (0, import_react.useRef)(view);
	viewRef.current = view;
	(0, import_react.useEffect)(() => {
		const q = query.trim();
		if (q.length < 2) {
			setHits([]);
			setSearching(false);
			return;
		}
		const id = ++searchReq.current;
		setSearching(true);
		const timer = window.setTimeout(() => {
			const here = viewRef.current;
			searchPlaces({ data: {
				q,
				lng: here.lng,
				lat: here.lat
			} }).then((rows) => {
				if (searchReq.current === id) setHits(rows);
			}).catch(() => {
				if (searchReq.current === id) setHits([]);
			}).finally(() => {
				if (searchReq.current === id) setSearching(false);
			});
		}, 320);
		return () => window.clearTimeout(timer);
	}, [query]);
	(0, import_react.useEffect)(() => {
		function onKey(event) {
			if (event.key !== "Escape") return;
			if (sheet) setSheet(null);
			else if (tool !== "none") setTool("none");
			else setLand(null);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [sheet, tool]);
	(0, import_react.useEffect)(() => {
		if (!notice) return;
		const timer = window.setTimeout(() => setNotice(null), 2400);
		return () => window.clearTimeout(timer);
	}, [notice]);
	function ensureWatch() {
		if (!navigator.geolocation) {
			setGpsError("This browser has no location.");
			return;
		}
		if (watchRef.current != null) return;
		setGpsError(null);
		watchRef.current = navigator.geolocation.watchPosition((pos) => {
			const next = {
				lng: pos.coords.longitude,
				lat: pos.coords.latitude,
				accuracy: pos.coords.accuracy,
				heading: typeof pos.coords.heading === "number" && pos.coords.heading >= 0 ? pos.coords.heading : null
			};
			setGps(next);
			setGpsError(null);
			if (followRef.current) mapRef.current?.easeTo(next.lng, next.lat);
			if (recRef.current) {
				const prev = lastRecRef.current;
				if (!prev || haversine(prev, next) >= 8) {
					lastRecRef.current = next;
					setRecPts((points) => [...points, {
						lng: next.lng,
						lat: next.lat,
						t: Date.now()
					}]);
				}
			}
		}, (err) => setGpsError(err.code === 1 ? "Location permission denied." : "Couldn't get a GPS fix."), {
			enableHighAccuracy: true,
			maximumAge: 2e3,
			timeout: 15e3
		});
	}
	function onLocate() {
		ensureWatch();
		followRef.current = true;
		setFollow(true);
		if (gps) mapRef.current?.easeTo(gps.lng, gps.lat, Math.max(view.zoom, 14));
	}
	function dropAt(lng, lat) {
		const kind = store.lastKind;
		const count = store.waypoints.filter((waypoint) => waypoint.kind === kind).length + 1;
		const id = crypto.randomUUID();
		store.addWaypoint({
			id,
			name: `${MARKS[kind].label} ${count}`,
			kind,
			lng,
			lat,
			notes: "",
			hunt: store.activeHunt,
			createdAt: Date.now()
		});
		setSelectedId(id);
		setSheet("edit");
		setTool("none");
		setLand(null);
	}
	function runIdentify(lng, lat) {
		landAbort.current?.abort();
		const controller = new AbortController();
		landAbort.current = controller;
		setLand({
			status: "loading",
			lng,
			lat
		});
		identifyLand(lng, lat, controller.signal).then((hit) => {
			if (!controller.signal.aborted) setLand({
				status: "ready",
				lng,
				lat,
				hit
			});
		}).catch((error) => {
			if (controller.signal.aborted) return;
			if (error instanceof DOMException && error.name === "AbortError") return;
			setLand({
				status: "error",
				lng,
				lat
			});
		});
	}
	function onMapClick(lng, lat) {
		if (tool === "drop") {
			dropAt(lng, lat);
			return;
		}
		if (tool === "measure") {
			if (measureClosed) return;
			setMeasurePts((points) => [...points, {
				lng,
				lat
			}]);
			return;
		}
		runIdentify(lng, lat);
	}
	function toggleRecord() {
		if (recording) {
			recRef.current = false;
			setRecording(false);
			if (recPts.length < 2) {
				setNotice("Track was too short to save.");
				setRecPts([]);
				setRecStart(null);
				lastRecRef.current = null;
				return;
			}
			const stamp = /* @__PURE__ */ new Date();
			store.addTrack({
				id: crypto.randomUUID(),
				name: `Track ${stamp.toLocaleString("en-US", {
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit"
				})}`,
				points: recPts,
				createdAt: stamp.getTime(),
				visible: true
			});
			setRecPts([]);
			setRecStart(null);
			lastRecRef.current = null;
			setNotice("Track saved on this device.");
			return;
		}
		ensureWatch();
		recRef.current = true;
		lastRecRef.current = gps;
		setRecPts(gps ? [{
			lng: gps.lng,
			lat: gps.lat,
			t: Date.now()
		}] : []);
		setRecStart(Date.now());
		setRecording(true);
		setSheet(null);
	}
	function discardTrack() {
		recRef.current = false;
		setRecording(false);
		setRecPts([]);
		setRecStart(null);
		lastRecRef.current = null;
	}
	function goTo(lng, lat, zoom = 12) {
		mapRef.current?.easeTo(lng, lat, zoom);
		setSearchOpen(false);
		setQuery("");
		setHits([]);
	}
	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
			setNotice("Copied coordinates.");
		} catch {
			setNotice("Couldn't copy from this browser.");
		}
	}
	function onImport(file) {
		file.text().then((text) => {
			const parsed = parseGpx(text);
			const nowStamp = Date.now();
			store.importAll(parsed.waypoints.map((waypoint) => ({
				...waypoint,
				id: crypto.randomUUID(),
				createdAt: nowStamp
			})), parsed.tracks.map((track) => ({
				...track,
				id: crypto.randomUUID(),
				createdAt: nowStamp,
				visible: true
			})));
			setNotice(`Imported ${parsed.waypoints.length} marks and ${parsed.tracks.length} tracks.`);
		}).catch((error) => setNotice(error instanceof Error ? error.message : "Import failed."));
	}
	function onExport() {
		if (store.waypoints.length === 0 && store.tracks.length === 0) return;
		const blob = new Blob([toGpx(store.waypoints, store.tracks)], { type: "application/gpx+xml" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "fieldline.gpx";
		link.click();
		URL.revokeObjectURL(url);
	}
	const windSpeed = weather ? store.imperial ? `${Math.round(mpsToMph(weather.windMps))} mph` : `${weather.windMps.toFixed(1)} m/s` : null;
	const tempLabel = weather ? `${Math.round(store.imperial ? cToF(weather.tempC) : weather.tempC)}°` : null;
	const measureLength = pathLength(measureClosed && measurePts.length > 2 ? [...measurePts, measurePts[0]] : measurePts);
	const measureArea = measureClosed ? ringArea(measurePts) : 0;
	const hunts = [...new Set(store.waypoints.map((waypoint) => waypoint.hunt).filter(Boolean))];
	const tilted = Math.abs(view.bearing) > 2 || view.pitch > 8;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "map-shell relative h-dvh w-full overflow-hidden bg-bg",
		"data-sheet": sheet ? "1" : "0",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MapCanvas, {
				ref: mapRef,
				hydrated,
				basemap: store.basemap,
				showPublic: store.showPublic,
				publicOpacity: store.publicOpacity,
				showLabels: store.showLabels,
				terrain: store.terrain,
				imperial: store.imperial,
				showMarks: store.showMarks,
				waypoints: store.waypoints,
				selectedId,
				tracks: store.tracks,
				livePoints: recPts,
				measurePoints: measurePts,
				measureClosed,
				gps,
				tool,
				onMapClick,
				onMarkerClick: (id) => {
					setSelectedId(id);
					setSheet("edit");
					setTool("none");
				},
				onView: setView,
				onDragStart: () => {
					followRef.current = false;
					setFollow(false);
				}
			}),
			tool !== "none" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Reticle, {}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex flex-col gap-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-display text-lg leading-none tracking-widest text-fg sm:hidden",
							children: "FIELDLINE"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center gap-2",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "hidden font-display text-xl tracking-widest text-fg sm:block",
									children: "FIELDLINE"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", {
									className: "relative min-w-0 flex-1",
									onSubmit: (event) => {
										event.preventDefault();
										const first = hits[0];
										if (first) goTo(first.lng, first.lat, 12);
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Search, { className: "pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											value: query,
											onChange: (event) => {
												setQuery(event.target.value);
												setSearchOpen(true);
											},
											onFocus: () => setSearchOpen(true),
											placeholder: "Search town or country",
											"aria-label": "Search places",
											autoCapitalize: "off",
											autoCorrect: "off",
											className: "field h-11 pr-10 pl-9"
										}),
										query ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
											type: "button",
											"aria-label": "Clear search",
											className: "absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted",
											onClick: () => {
												setQuery("");
												setHits([]);
											},
											children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "size-4" })
										}) : null,
										searchOpen ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											className: "absolute inset-x-0 top-12 overflow-hidden rounded-lg border border-line bg-surface shadow-lg",
											children: query.trim().length < 2 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "p-2",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
													className: "px-2 py-1 text-xs tracking-wide text-subtle uppercase",
													children: "Jump"
												}), JUMPS.map((place) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "flex min-h-11 w-full items-center justify-between rounded-md px-2 text-left hover:bg-surface-2",
													onClick: () => goTo(place.lng, place.lat, place.zoom),
													children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: place.name }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
														className: "text-sm text-muted",
														children: place.hint
													})]
												}, place.name))]
											}) : searching && hits.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
												className: "px-3 py-3 text-sm text-muted",
												children: "Searching…"
											}) : hits.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
												className: "px-3 py-3 text-sm text-muted",
												children: "No matches."
											}) : hits.map((hit) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "flex min-h-11 w-full flex-col items-start justify-center px-3 text-left hover:bg-surface-2",
												onClick: () => goTo(hit.lng, hit.lat, 13),
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: hit.name }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
													className: "text-sm text-muted",
													children: hit.detail
												})]
											}, hit.id))
										}) : null
									]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									type: "button",
									onClick: () => {
										setSheet(sheet === "wind" ? null : "wind");
										setSearchOpen(false);
									},
									className: "flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-fg",
									"aria-label": "Wind and light",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(WindArrow, { deg: weather?.windFrom ?? 0 }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "font-mono tabular-nums",
										children: windSpeed ?? "Wind"
									})]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex items-start justify-between gap-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setCoordMode((mode) => mode === "dd" ? "dms" : "dd"),
							className: "rounded-md bg-surface/95 px-2.5 py-1.5 text-left font-mono text-xs leading-relaxed text-fg tabular-nums",
							children: [coordMode === "dd" ? formatDd(view.lng, view.lat) : formatDms(view.lng, view.lat), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "mt-0.5 block text-muted",
								children: [weather?.elevationM != null ? `${formatElev(weather.elevationM, store.imperial)} elev` : "Elev —", tempLabel ? ` · ${tempLabel}` : ""]
							})]
						}), tilted ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => mapRef.current?.resetNorth(),
							className: "grid size-11 place-items-center rounded-full border border-line bg-surface text-fg",
							"aria-label": "Reset north",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Compass, {
								className: "size-5",
								style: { transform: `rotate(${-view.bearing}deg)` }
							})
						}) : null]
					}),
					hydrated && !store.introDismissed ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-muted",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "Color is federal, state, or tribal surface from the BLM. Blank ground is usually private. Owner names are not in this free map." }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							"aria-label": "Dismiss",
							className: "grid size-8 shrink-0 place-items-center text-fg",
							onClick: store.dismissIntro,
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "size-4" })
						})]
					}) : null
				]
			}),
			searchOpen ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": "Close search",
				className: "absolute inset-0 z-10 cursor-default",
				onClick: () => setSearchOpen(false)
			}) : null,
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "pointer-events-none absolute inset-x-0 bottom-[max(5.5rem,calc(4.5rem+env(safe-area-inset-bottom)))] z-20 flex flex-col items-center gap-2 px-3",
				children: [
					notice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-fg",
						children: notice
					}) : null,
					gpsError && follow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-muted",
						children: gpsError
					}) : null,
					recording ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-surface px-3 py-1.5 text-sm",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "size-2 rounded-full bg-danger" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "font-mono tabular-nums",
								children: [
									formatDistance(pathLength(recPts), store.imperial),
									" · ",
									formatDuration(now - (recStart ?? now))
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "text-danger",
								onClick: discardTrack,
								children: "Discard"
							})
						]
					}) : null,
					tool === "drop" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-3 text-sm",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Tap the map, or" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							className: "h-9 rounded-full bg-accent px-3 font-medium text-accent-fg",
							onClick: () => {
								const center = mapRef.current?.getCenter() ?? {
									lng: view.lng,
									lat: view.lat
								};
								dropAt(center.lng, center.lat);
							},
							children: "Drop at crosshair"
						})]
					}) : null,
					tool === "measure" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "font-mono tabular-nums",
								children: [measurePts.length < 2 ? "Tap points" : formatDistance(measureLength, store.imperial), measureClosed ? ` · ${formatArea(measureArea, store.imperial)}` : ""]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "h-9 px-1 text-muted",
								onClick: () => setMeasurePts((points) => points.slice(0, -1)),
								disabled: measurePts.length === 0,
								children: "Undo"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "h-9 px-1 text-fg",
								disabled: measurePts.length < 3 || measureClosed,
								onClick: () => setMeasureClosed(true),
								children: "Area"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "h-9 px-1 text-muted",
								onClick: () => {
									setMeasurePts([]);
									setMeasureClosed(false);
								},
								children: "Clear"
							})
						]
					}) : null,
					land && tool === "none" && !sheet ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LandCard, {
						land,
						onClose: () => setLand(null),
						onCopy: copyText,
						onMark: () => dropAt(land.lng, land.lat)
					}) : null
				]
			}),
			sheet === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
				className: "absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-3",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex max-w-full items-stretch gap-0.5 overflow-x-auto rounded-full border border-line bg-surface p-1",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: follow ? "Follow" : "GPS",
							on: follow,
							icon: LocateFixed,
							onClick: onLocate
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: "Mark",
							on: tool === "drop",
							icon: Crosshair,
							onClick: () => {
								setTool(tool === "drop" ? "none" : "drop");
								setSheet(null);
								setSearchOpen(false);
							}
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: "Measure",
							on: tool === "measure",
							icon: Ruler,
							onClick: () => {
								setTool(tool === "measure" ? "none" : "measure");
								setMeasureClosed(false);
								setSheet(null);
							}
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: recording ? "Stop" : "Track",
							on: recording,
							danger: recording,
							icon: MapPinned,
							onClick: toggleRecord
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: "Layers",
							on: false,
							icon: Layers,
							onClick: () => {
								setSheet("layers");
								setSearchOpen(false);
							}
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DockButton, {
							label: "Saved",
							on: false,
							icon: Bookmark,
							onClick: () => {
								setSheet("saved");
								setSearchOpen(false);
							}
						})
					]
				})
			}) : null,
			sheet === "layers" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Panel, {
				title: "Layers",
				onClose: () => setSheet(null),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "grid grid-cols-4 gap-1 rounded-lg bg-bg p-2",
						children: BASEMAPS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							"data-on": store.basemap === item.id,
							onClick: () => store.setBasemap(item.id),
							className: "h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg",
							children: item.label
						}, item.id))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
						checked: store.showPublic,
						onChange: store.setShowPublic,
						label: "Public land",
						hint: "BLM surface management. Not a survey."
					}),
					store.showPublic ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						className: "block pb-2 text-sm text-muted",
						children: ["Overlay strength", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "range",
							min: .3,
							max: .9,
							step: .05,
							value: store.publicOpacity,
							"aria-label": "Public land opacity",
							onChange: (event) => store.setPublicOpacity(Number(event.target.value))
						})]
					}) : null,
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
						checked: store.showLabels,
						onChange: store.setShowLabels,
						label: "Place names",
						hint: "Roads and labels on the hybrid map."
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
						checked: store.terrain,
						onChange: store.setTerrain,
						label: "3D terrain",
						hint: "Tilt the map. Heavier on a phone."
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, {
						checked: store.showMarks,
						onChange: store.setShowMarks,
						label: "My marks"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "grid grid-cols-2 gap-1 rounded-lg bg-bg p-2",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							"data-on": store.imperial,
							onClick: () => store.setImperial(true),
							className: "h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg",
							children: "Yards / miles"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							"data-on": !store.imperial,
							onClick: () => store.setImperial(false),
							className: "h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg",
							children: "Meters"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
						className: "mt-4 grid grid-cols-2 gap-y-2",
						children: LEGEND.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
							className: "flex items-center gap-2 text-sm text-muted",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "size-3 rounded-sm border border-line",
								style: { background: item.swatch }
							}), item.label]
						}, item.label))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-3 text-sm text-subtle",
						children: "Private land stays uncolored. This is not onX, and it is not legal advice. Confirm boundaries and seasons before you hunt."
					})
				]
			}) : null,
			sheet === "wind" && weather ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Panel, {
				title: "Wind",
				onClose: () => setSheet(null),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-end justify-between gap-4",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "font-display text-5xl leading-none tracking-wide",
							children: cardinal(weather.windFrom)
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "mt-2 text-muted",
							children: ["From ", cardinal(weather.windFrom)]
						})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WindArrow, {
							deg: weather.windFrom,
							large: true
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
						className: "mt-5 grid grid-cols-2 gap-3",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Wind",
								value: windSpeed ?? "—"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Gusts",
								value: store.imperial ? `${Math.round(mpsToMph(weather.gustMps))} mph` : `${weather.gustMps.toFixed(1)} m/s`
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Temp",
								value: tempLabel ?? "—"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Scent drifts",
								value: cardinal(weather.windFrom + 180)
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Sunrise",
								value: formatClock(weather.sunrise)
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
								label: "Sunset",
								value: formatClock(weather.sunset)
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-4 text-sm text-subtle",
						children: "Legal shooting light is not the same as sunrise. Check your state wildlife agency. Wind is the Open-Meteo model at the map center, not a ridge-top reading."
					})
				]
			}) : null,
			sheet === "wind" && !weather ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
				title: "Wind",
				onClose: () => setSheet(null),
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-muted",
					children: "Weather hasn't answered yet. Pan somewhere with a connection and try again."
				})
			}) : null,
			sheet === "saved" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Panel, {
				title: "Saved",
				onClose: () => setSheet(null),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mb-3 flex gap-2",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: onExport,
								disabled: store.waypoints.length + store.tracks.length === 0,
								className: "flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm disabled:opacity-40",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { className: "size-4" }), " Export GPX"]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => fileRef.current?.click(),
								className: "flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Upload, { className: "size-4" }), " Import"]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								ref: fileRef,
								type: "file",
								accept: ".gpx,application/gpx+xml,.xml",
								className: "hidden",
								onChange: (event) => {
									const file = event.target.files?.[0];
									event.target.value = "";
									if (file) onImport(file);
								}
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
						className: "font-display text-xl tracking-wide",
						children: "Marks"
					}),
					store.waypoints.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "py-3 text-sm text-muted",
						children: "No marks yet. Tap Mark, then tap the stand, gate, or camp."
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
						className: "mt-1",
						children: store.waypoints.map((waypoint) => {
							const meta = MARKS[waypoint.kind];
							const Icon = meta.icon;
							const away = gps ? formatDistance(haversine(gps, waypoint), store.imperial) : null;
							const heading = gps ? cardinal(bearingDeg(gps, waypoint)) : null;
							return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-2",
								onClick: () => {
									setSelectedId(waypoint.id);
									setSheet("edit");
									mapRef.current?.easeTo(waypoint.lng, waypoint.lat, 15);
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									className: `grid size-8 shrink-0 place-items-center rounded-full ${meta.pinClass}`,
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "size-4" })
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									className: "min-w-0 flex-1",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "block truncate",
										children: waypoint.name
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										className: "block truncate text-sm text-muted",
										children: [waypoint.hunt || meta.label, away && heading ? ` · ${away} ${heading}` : ""]
									})]
								})]
							}) }, waypoint.id);
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
						className: "mt-4 font-display text-xl tracking-wide",
						children: "Tracks"
					}),
					store.tracks.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "py-3 text-sm text-muted",
						children: "No tracks yet. Tap Track and walk. Stop saves it here."
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
						className: "mt-1",
						children: store.tracks.map((track) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
							className: "flex min-h-12 items-center gap-2",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "min-w-0 flex-1 truncate text-left",
									onClick: () => mapRef.current?.fit(track.points),
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "block truncate",
										children: track.name
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										className: "text-sm text-muted",
										children: formatDistance(pathLength(track.points), store.imperial)
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									type: "button",
									className: "h-9 px-2 text-sm text-muted",
									onClick: () => store.toggleTrack(track.id),
									children: track.visible ? "Hide" : "Show"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									type: "button",
									className: "h-9 px-2 text-sm text-danger",
									onClick: () => store.removeTrack(track.id),
									children: "Delete"
								})
							]
						}, track.id))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-4 text-sm text-subtle",
						children: "Marks and tracks stay on this phone or browser. Export GPX if you want a copy."
					})
				]
			}) : null,
			sheet === "edit" && selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Panel, {
				title: "Mark",
				onClose: () => setSheet(null),
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EditMark, {
					name: selected.name,
					kind: selected.kind,
					hunt: selected.hunt,
					notes: selected.notes,
					hunts,
					lng: selected.lng,
					lat: selected.lat,
					away: gps ? `${formatDistance(haversine(gps, selected), store.imperial)} ${cardinal(bearingDeg(gps, selected))}` : null,
					onChange: (patch) => {
						store.updateWaypoint(selected.id, patch);
						if (patch.kind) store.setLastKind(patch.kind);
						if (typeof patch.hunt === "string") store.setActiveHunt(patch.hunt);
					},
					onCopy: () => void copyText(`${selected.name}\n${formatPair(selected.lng, selected.lat)}`),
					onDelete: () => {
						store.removeWaypoint(selected.id);
						setSelectedId(null);
						setSheet(null);
					}
				}, selected.id)
			}) : null
		]
	});
}
function Reticle() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "pointer-events-none absolute top-1/2 left-1/2 z-10 size-10 -translate-x-1/2 -translate-y-1/2",
		"aria-hidden": true,
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-0 left-1/2 h-3 w-px -translate-x-1/2 bg-fg" }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-fg" }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 bg-fg" }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute top-1/2 right-0 h-px w-3 -translate-y-1/2 bg-fg" })
		]
	});
}
function WindArrow({ deg, large = false }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 24 24",
		className: large ? "size-16 text-fg" : "size-4 text-field",
		style: { transform: `rotate(${(deg + 180) % 360}deg)` },
		"aria-hidden": true,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
			d: "M12 3.5v13M7.5 12.5 12 19l4.5-6.5",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: large ? 1.5 : 1.75,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})
	});
}
function DockButton({ label, on, danger = false, icon: Icon, onClick }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		"data-on": on,
		onClick,
		className: `flex min-w-12 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-xs ${on ? danger ? "bg-danger text-fg" : "bg-accent text-accent-fg" : "text-muted"}`,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "size-5" }), label]
	});
}
function Panel({ title, onClose, children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		role: "dialog",
		"aria-label": title,
		className: "fixed inset-x-0 bottom-0 z-30 flex max-h-[min(78dvh,40rem)] flex-col rounded-t-xl border border-line bg-surface shadow-lg md:inset-y-4 md:left-4 md:w-96 md:rounded-xl",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "flex items-center justify-between gap-3 px-4 pt-4 pb-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "font-display text-2xl leading-none tracking-wide",
				children: title
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: onClose,
				"aria-label": "Close",
				className: "grid size-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "size-5" })
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
			children
		})]
	});
}
function Toggle({ checked, onChange, label, hint }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
		className: "flex min-h-11 items-center justify-between gap-4 py-1.5",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "block",
			children: label
		}), hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "block text-sm text-muted",
			children: hint
		}) : null] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Switch, {
			checked,
			onCheckedChange: onChange,
			"aria-label": label,
			className: "relative h-7 w-12 shrink-0 rounded-full bg-surface-2 data-[state=checked]:bg-field",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SwitchThumb, { className: "block size-5 translate-x-1 rounded-full bg-fg transition-transform duration-150 data-[state=checked]:translate-x-6" })
		})]
	});
}
function Stat({ label, value }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-md bg-bg px-3 py-2",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
			className: "text-xs tracking-wide text-subtle uppercase",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
			className: "font-mono text-lg tabular-nums",
			children: value
		})]
	});
}
function LandCard({ land, onClose, onCopy, onMark }) {
	const title = land.status === "ready" ? land.hit.label : land.status === "loading" ? "Checking this spot…" : "Land layer didn't answer";
	const place = land.status === "ready" ? [land.hit.unit, land.hit.state].filter(Boolean).join(" · ") : "";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
		className: "pointer-events-auto w-full max-w-md rounded-lg border border-line bg-surface p-3 text-left shadow-lg",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start gap-3",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "mt-1 size-3 shrink-0 rounded-sm border border-line",
					style: { background: land.status === "ready" ? land.hit.swatch ?? "transparent" : "transparent" }
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0 flex-1",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
							className: "text-base leading-tight",
							children: title
						}),
						place ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-0.5 text-sm text-muted",
							children: place
						}) : null,
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-1 font-mono text-xs text-subtle tabular-nums",
							children: formatPair(land.lng, land.lat)
						}),
						land.status === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "mt-2 text-sm text-muted",
							children: land.hit.note
						}) : null
					]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-label": "Close land card",
					className: "grid size-8 place-items-center text-muted",
					onClick: onClose,
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "size-4" })
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-3 flex gap-2",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				className: "h-10 flex-1 rounded-md bg-accent text-sm font-medium text-accent-fg",
				onClick: onMark,
				children: "Mark here"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				className: "h-10 flex-1 rounded-md border border-line text-sm",
				onClick: () => onCopy(formatPair(land.lng, land.lat)),
				children: "Copy"
			})]
		})]
	});
}
function EditMark({ name, kind, hunt, notes, hunts, lng, lat, away, onChange, onCopy, onDelete }) {
	const [confirm, setConfirm] = (0, import_react.useState)(false);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
				className: "text-sm text-muted",
				children: ["Name", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
					className: "field mt-1",
					value: name,
					maxLength: 60,
					onChange: (event) => onChange({ name: event.target.value })
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "grid grid-cols-3 gap-1.5",
				children: MARK_ORDER.map((item) => {
					const meta = MARKS[item];
					const Icon = meta.icon;
					return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						"data-on": kind === item,
						onClick: () => onChange({ kind: item }),
						className: "flex h-11 items-center justify-center gap-1.5 rounded-md border border-transparent bg-bg text-sm text-muted data-[on=true]:border-line data-[on=true]:text-fg",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Icon, { className: "size-4" }), meta.label]
					}, item);
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
				className: "text-sm text-muted",
				children: [
					"Hunt",
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						className: "field mt-1",
						value: hunt,
						maxLength: 40,
						list: "hunt-names",
						placeholder: "Unit or camp name",
						onChange: (event) => onChange({ hunt: event.target.value })
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", {
						id: "hunt-names",
						children: hunts.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: item }, item))
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
				className: "text-sm text-muted",
				children: ["Notes", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
					className: "field mt-1",
					rows: 3,
					maxLength: 500,
					value: notes,
					onChange: (event) => onChange({ notes: event.target.value })
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "font-mono text-xs text-muted tabular-nums",
				children: [formatDd(lng, lat), away ? ` · ${away} from you` : ""]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex gap-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "h-11 flex-1 rounded-md border border-line text-sm",
					onClick: onCopy,
					children: "Copy"
				}), confirm ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "h-11 flex-1 rounded-md bg-danger text-sm text-fg",
					onClick: onDelete,
					children: "Confirm delete"
				}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "h-11 flex-1 rounded-md border border-line text-sm text-danger",
					onClick: () => setConfirm(true),
					children: "Delete"
				})]
			})
		]
	});
}
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HuntApp, {});
}
//#endregion
export { Home as component };
