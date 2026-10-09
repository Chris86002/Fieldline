import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import * as Switch from "@radix-ui/react-switch";
import {
  Bookmark,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Compass,
  Crosshair,
  Download,
  Layers,
  LocateFixed,
  MapPinned,
  Mic,
  Ruler,
  Search,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { MapCanvas, type GpsFix, type MapHandle } from "@/components/hunt/MapCanvas";
import { MARK_ORDER, MARKS } from "@/components/hunt/marks";
import {
  AZ_SHOOT_LEAD_MIN,
  bearingDeg,
  cardinal,
  cToF,
  formatArea,
  formatClock,
  formatDd,
  formatDistance,
  formatDms,
  formatDuration,
  formatElev,
  formatPair,
  formatPressure,
  haversine,
  mpsToMph,
  pathLength,
  ringArea,
  shiftLocalIso,
  WIND_CHOICES,
  windFits,
} from "@/lib/hunt/format";
import { toGpx } from "@/lib/hunt/gpx";
import { guessRegion, readTrailFile, trackKey, waypointKey } from "@/lib/hunt/transfer";
import { identifyLand } from "@/lib/hunt/land";
import { LEGEND } from "@/lib/hunt/land";
import { azBorder } from "@/lib/hunt/az-border";
import { idBorder } from "@/lib/hunt/id-border";
import { searchPlaces, type PlaceHit } from "@/lib/hunt/search.functions";
import { getHuntStorageWarning, useHunt } from "@/lib/hunt/store";
import { packTiles, TILES, tileCacheLabel } from "@/lib/hunt/tiles";
import { DEFAULT_VIEW, ID_JUMPS, JUMPS, REGION_VIEW, type Basemap, type HuntRegion, type LandHit, type LngLat, type MapView, type MarkKind, type Track, type TrackPoint, type Waypoint } from "@/lib/hunt/types";
import { loadFieldWeather } from "@/lib/hunt/weather.functions";
import type { DayOutlook, FieldWeather, WindHour } from "@/lib/hunt/weather";
import { weatherLabel } from "@/lib/hunt/weather";
import { hitFromUnit, identifyUnit, loadUnits, matchUnit, unitAt, unitsCollection, type HuntUnit, type UnitHit } from "@/lib/hunt/units";
import { formatUtm, localDate, localMinutes, sunPosition, zoneAt } from "@/lib/hunt/sun";
import { noiseWord, rmsDb } from "@/lib/hunt/noise";

type Tool = "none" | "drop" | "measure";
type Sheet = null | "layers" | "saved" | "wind" | "edit";
type LandState =
  | { status: "loading"; lng: number; lat: number }
  | { status: "ready"; lng: number; lat: number; hit: LandHit }
  | { status: "error"; lng: number; lat: number };

type Spot = { lng: number; lat: number; x: number; y: number };
type Detail = Spot & { unit: UnitHit | null; land: LandHit | null; pending: boolean };

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "hybrid", label: "Hybrid" },
  { id: "satellite", label: "Satellite" },
  { id: "topo", label: "Topo" },
  { id: "street", label: "Street" },
];

export function HuntApp() {
  const store = useHunt();
  const mapRef = useRef<MapHandle>(null);
  const watchRef = useRef<number | null>(null);
  const followRef = useRef(false);
  const recRef = useRef(false);
  const recordPendingRef = useRef(false);
  const lastRecRef = useRef<LngLat | null>(null);
  const recPtsRef = useRef<TrackPoint[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const searchReq = useRef(0);
  const landAbort = useRef<AbortController | null>(null);
  const unitAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const unitsRef = useRef<HuntUnit[]>([]);
  const pinnedRef = useRef<Spot | null>(null);
  const landTimer = useRef<number | null>(null);
  const landKey = useRef("");

  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [tool, setTool] = useState<Tool>("none");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [shadeMin, setShadeMin] = useState<number | null>(null);
  const [shadeNow, setShadeNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measurePts, setMeasurePts] = useState<LngLat[]>([]);
  const [measureClosed, setMeasureClosed] = useState(false);
  const [gps, setGps] = useState<GpsFix | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordPending, setRecordPending] = useState(false);
  const [recPts, setRecPts] = useState<TrackPoint[]>([]);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [land, setLand] = useState<LandState | null>(null);
  const [spotUnit, setSpotUnit] = useState<UnitHit | null>(null);
  const [pinned, setPinned] = useState<Spot | null>(null);
  const [hover, setHover] = useState<Spot | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [installDismissed, setInstallDismissed] = useState<boolean | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [listening, setListening] = useState(false);
  const [finePointer, setFinePointer] = useState(false);
  const [units, setUnits] = useState<HuntUnit[]>([]);
  const [weather, setWeather] = useState<FieldWeather | null>(null);
  const [weatherAt, setWeatherAt] = useState<{ lng: number; lat: number } | null>(null);
  const [weatherRefresh, setWeatherRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropHot, setDropHot] = useState(false);
  const [coordMode, setCoordMode] = useState<"dd" | "dms" | "utm">("dd");
  const [packNote, setPackNote] = useState<string | null>(null);
  const [packing, setPacking] = useState(false);

  const selected = store.waypoints.find((waypoint) => waypoint.id === selectedId) ?? null;
  unitsRef.current = units;
  pinnedRef.current = pinned;
  const region: HuntRegion = store.huntRegion === "id" ? "id" : "az";
  const jumps = region === "id" ? ID_JUMPS : JUMPS;
  const clockZone = zoneAt(view.lng, view.lat);

  useEffect(() => {
    const iosBar = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || iosBar);
    try {
      setInstallDismissed(localStorage.getItem("fieldline-install-dismissed") === "1");
    } catch {
      setInstallDismissed(false);
    }
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const apply = () => setFinePointer(!media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => useHunt.persist.rehydrate())
      .catch(() => undefined)
      .then(() => {
        if (!live) return;
        const saved = useHunt.getState().lastView;
        if (saved) setView(saved);
        setHydrated(true);
        const warning = getHuntStorageWarning();
        if (warning) setNotice(warning);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onStorageError = () => {
      const warning = getHuntStorageWarning();
      if (warning) setNotice(warning);
    };
    window.addEventListener("fieldline:storage-error", onStorageError);
    return () => window.removeEventListener("fieldline:storage-error", onStorageError);
  }, []);

  useEffect(() => {
    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, []);

  useEffect(() => {
    if (!recording || recStart == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording, recStart]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => useHunt.getState().setLastView(view), 700);
    return () => window.clearTimeout(timer);
  }, [view, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    void tileCacheLabel().then((label) => {
      if (label) setPackNote(label);
    });
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const region: HuntRegion = useHunt.getState().huntRegion === "id" ? "id" : "az";
    let live = true;
    void loadUnits(region)
      .then((rows) => {
        if (live) setUnits(rows);
      })
      .catch(() => {
        /* the unit layer stays off if the service is down */
      });
    return () => {
      live = false;
    };
  }, [hydrated, store.huntRegion]);

  useEffect(() => {
    if (!detail || land?.status !== "ready") return;
    if (Math.abs(land.lng - detail.lng) > 1e-4 || Math.abs(land.lat - detail.lat) > 1e-4) return;
    if (detail.land && !detail.pending) return;
    const hit = land.hit;
    setDetail((current) => {
      if (!current || current.land) return current;
      if (Math.abs(land.lng - current.lng) > 1e-4 || Math.abs(land.lat - current.lat) > 1e-4) return current;
      return { ...current, land: hit, pending: false };
    });
  }, [land, detail]);

  useEffect(() => {
    if (units.length === 0) return;
    const point = hover ?? pinned;
    if (!point) return;
    const local = unitAt(units, point.lng, point.lat);
    const next = local ? hitFromUnit(local, false) : null;
    setSpotUnit((prev) => (prev?.gmu === next?.gmu && prev?.forest === next?.forest && prev?.species === next?.species ? prev : next));
  }, [units, hover, pinned]);

  const unitsGeo = useMemo(() => unitsCollection(units), [units]);
  const unitLabels = useMemo(() => units.map((unit) => ({ gmu: unit.gmu, lng: unit.label.lng, lat: unit.label.lat })), [units]);
  const unitMatch = query.trim() ? matchUnit(units, query) : null;

  const probe = hover ?? pinned;
  const readLng = probe?.lng ?? view.lng;
  const readLat = probe?.lat ?? view.lat;
  const weatherKey = `${readLat.toFixed(2)},${readLng.toFixed(2)}`;
  const landHit =
    land?.status === "ready" && probe && Math.abs(land.lng - probe.lng) < 0.003 && Math.abs(land.lat - probe.lat) < 0.003 ? land.hit : null;

  useEffect(() => {
    if (!hydrated) return;
    const [lat, lng] = weatherKey.split(",").map(Number);
    const controller = new AbortController();
    setWeather(null);
    setWeatherAt(null);
    const timer = window.setTimeout(() => {
      void loadFieldWeather({ data: { lng, lat } })
        .then((next) => {
          if (controller.signal.aborted) return;
          setWeather(next);
          setWeatherAt({ lng, lat });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setWeather(null);
          setWeatherAt(null);
        });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hydrated, weatherKey, weatherRefresh]);

  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    searchReq.current += 1;
    setHits([]);
    setSearching(false);
  }, [query]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (sheet) setSheet(null);
      else if (tool !== "none") setTool("none");
      else if (detail) setDetail(null);
      else if (installHelp) setInstallHelp(false);
      else {
        setPinned(null);
        setHover(null);
        setLand(null);
        setSpotUnit(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, tool, detail, installHelp]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function ensureWatch(): boolean {
    if (!navigator.geolocation) {
      setGpsError("This browser has no location.");
      return false;
    }
    if (watchRef.current != null) return true;
    setGpsError(null);
    try {
      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const next: GpsFix = {
            lng: pos.coords.longitude,
            lat: pos.coords.latitude,
            accuracy: pos.coords.accuracy,
            heading: typeof pos.coords.heading === "number" && pos.coords.heading >= 0 ? pos.coords.heading : null,
          };
          if (
            !Number.isFinite(next.lng) ||
            next.lng < -180 ||
            next.lng > 180 ||
            !Number.isFinite(next.lat) ||
            next.lat < -90 ||
            next.lat > 90 ||
            !Number.isFinite(next.accuracy) ||
            next.accuracy < 0
          ) {
            setGpsError("The browser returned an invalid GPS fix.");
            return;
          }
          setGps(next);
          setGpsError(null);
          if (followRef.current) mapRef.current?.easeTo(next.lng, next.lat);
          if (recordPendingRef.current) {
            recordPendingRef.current = false;
            setRecordPending(false);
            recRef.current = true;
            const start = Date.now();
            const points = [{ lng: next.lng, lat: next.lat, t: start }];
            recPtsRef.current = points;
            setRecPts(points);
            setRecStart(start);
            setRecording(true);
            setSheet(null);
            setNotice("Track recording started.");
          } else if (recRef.current) {
            const prev = lastRecRef.current;
            if (!prev || haversine(prev, next) >= 8) {
              lastRecRef.current = next;
              const points = [...recPtsRef.current, { lng: next.lng, lat: next.lat, t: Date.now() }];
              recPtsRef.current = points;
              setRecPts(points);
            }
          }
        },
        (err) => {
          const message = err.code === 1 ? "Location permission denied." : "Couldn't get a GPS fix.";
          if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
          watchRef.current = null;
          followRef.current = false;
          setFollow(false);
          setGpsError(message);
          if (recordPendingRef.current) {
            recordPendingRef.current = false;
            setRecordPending(false);
            setNotice(`Track not started: ${message}`);
          } else if (recRef.current) {
            recRef.current = false;
            setRecording(false);
            saveRecordedTrack(recPtsRef.current);
            recPtsRef.current = [];
            setRecPts([]);
            setRecStart(null);
            lastRecRef.current = null;
            setNotice("GPS was lost. Recording stopped; any recorded points were saved.");
          }
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
      );
      return true;
    } catch {
      setGpsError("Couldn't start location on this device.");
      return false;
    }
  }

  function onLocate() {
    if (!ensureWatch()) return;
    followRef.current = true;
    setFollow(true);
    if (gps) mapRef.current?.easeTo(gps.lng, gps.lat, Math.max(view.zoom, 14));
  }

  function dropAt(lng: number, lat: number) {
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
      goodWinds: [],
      createdAt: Date.now(),
    });
    setSelectedId(id);
    setSheet("edit");
    setTool("none");
    setPinned(null);
    setHover(null);
    setDetail(null);
    setLand(null);
    setSpotUnit(null);
  }

  function syncUnit(lng: number, lat: number) {
    const rows = unitsRef.current;
    if (rows.length > 0) {
      const local = unitAt(rows, lng, lat);
      const next = local ? hitFromUnit(local, false) : null;
      setSpotUnit((prev) => (prev?.gmu === next?.gmu && prev?.forest === next?.forest && prev?.species === next?.species ? prev : next));
      return;
    }
    unitAbort.current?.abort();
    const unitController = new AbortController();
    unitAbort.current = unitController;
    void identifyUnit(lng, lat, unitController.signal, region)
      .then((hit) => {
        if (!unitController.signal.aborted) setSpotUnit(hit);
      })
      .catch(() => {
        if (!unitController.signal.aborted) setSpotUnit(null);
      })
      .finally(() => {
      });
  }

  function runIdentify(lng: number, lat: number) {
    landAbort.current?.abort();
    const controller = new AbortController();
    landAbort.current = controller;
    setLand((prev) => (prev ? prev : { status: "loading", lng, lat }));
    void identifyLand(lng, lat, controller.signal)
      .then((hit) => {
        if (!controller.signal.aborted) setLand({ status: "ready", lng, lat, hit });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLand({ status: "error", lng, lat });
      });
  }

  function queueLand(lng: number, lat: number, immediate: boolean) {
    if (landTimer.current != null) window.clearTimeout(landTimer.current);
    landTimer.current = null;
    const key = `${lng.toFixed(3)},${lat.toFixed(3)}`;
    const fire = () => {
      landTimer.current = null;
      if (landKey.current === key) return;
      landKey.current = key;
      runIdentify(lng, lat);
    };
    if (immediate) fire();
    else landTimer.current = window.setTimeout(fire, 280);
  }

  function onPointerMove(lng: number, lat: number, x: number, y: number) {
    if (!finePointer || tool !== "none" || sheet || detail) return;
    setHover({ lng, lat, x, y });
    syncUnit(lng, lat);
    queueLand(lng, lat, false);
  }

  function onPointerLeave() {
    setHover(null);
    const pin = pinnedRef.current;
    if (!pin) {
      setSpotUnit(null);
      setLand(null);
      landKey.current = "";
      return;
    }
    syncUnit(pin.lng, pin.lat);
    queueLand(pin.lng, pin.lat, true);
  }

  function openDetail(lng: number, lat: number, x: number, y: number) {
    if (sheet) return;
    const rows = unitsRef.current;
    const local = rows.length ? unitAt(rows, lng, lat) : null;
    setDetail({ lng, lat, x, y, unit: local ? hitFromUnit(local, false) : null, land: null, pending: true });
    setPinned({ lng, lat, x, y });
    setHover(null);
    syncUnit(lng, lat);
    queueLand(lng, lat, true);
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    void identifyLand(lng, lat, controller.signal)
      .then((hit) => {
        if (controller.signal.aborted) return;
        setDetail((current) => (current && current.lng === lng && current.lat === lat ? { ...current, land: hit, pending: false } : current));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetail((current) => (current && current.lng === lng && current.lat === lat ? { ...current, pending: false } : current));
      });
    if (!local) {
      void identifyUnit(lng, lat, controller.signal, region)
        .then((hit) => {
          if (!controller.signal.aborted) {
            setDetail((current) => (current && current.lng === lng && current.lat === lat ? { ...current, unit: hit ?? current.unit } : current));
          }
        })
        .catch(() => undefined);
    }
  }

  function onMapClick(lng: number, lat: number, x = 0, y = 0) {
    if (tool === "drop") {
      dropAt(lng, lat);
      return;
    }
    if (tool === "measure") {
      if (measureClosed) return;
      setMeasurePts((points) => [...points, { lng, lat }]);
      return;
    }
    setDetail(null);
    setPinned({ lng, lat, x, y });
    syncUnit(lng, lat);
    queueLand(lng, lat, true);
  }

  function saveRecordedTrack(points: TrackPoint[]) {
    if (points.length < 2) return false;
    const stamp = new Date();
    store.addTrack({
      id: crypto.randomUUID(),
      name: `Track ${stamp.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      points,
      createdAt: stamp.getTime(),
      visible: true,
    });
    return true;
  }

  function toggleRecord() {
    if (recordPending) {
      recordPendingRef.current = false;
      setRecordPending(false);
      setNotice("Track recording cancelled.");
      return;
    }
    if (recording) {
      recRef.current = false;
      setRecording(false);
      const points = recPtsRef.current;
      if (!saveRecordedTrack(points)) {
        setNotice("Track was too short to save.");
      } else {
        setNotice("Track saved on this device.");
      }
      recPtsRef.current = [];
      setRecPts([]);
      setRecStart(null);
      lastRecRef.current = null;
      return;
    }
    if (!ensureWatch()) return;
    recordPendingRef.current = true;
    setRecordPending(true);
    recPtsRef.current = [];
    setRecPts([]);
    lastRecRef.current = null;
    setNotice("Waiting for a GPS fix before recording starts.");
    setSheet(null);
  }

  function discardTrack() {
    recRef.current = false;
    recordPendingRef.current = false;
    setRecording(false);
    setRecordPending(false);
    recPtsRef.current = [];
    setRecPts([]);
    setRecStart(null);
    lastRecRef.current = null;
  }

  function goTo(lng: number, lat: number, zoom = 12) {
    mapRef.current?.easeTo(lng, lat, zoom);
    setSearchOpen(false);
    setQuery("");
    setHits([]);
  }

  async function submitPlaceSearch() {
    const q = query.trim();
    if (q.length < 2) return;
    const id = ++searchReq.current;
    const here = viewRef.current;
    setSearching(true);
    setHits([]);
    try {
      const rows = await searchPlaces({ data: { q, lng: here.lng, lat: here.lat } });
      if (searchReq.current === id) setHits(rows);
    } catch {
      if (searchReq.current === id) {
        setHits([]);
        setNotice("Place search is unavailable. Try again when you have a connection.");
      }
    } finally {
      if (searchReq.current === id) setSearching(false);
    }
  }

  function goToUnit(unit: HuntUnit) {
    mapRef.current?.fit([
      { lng: unit.west, lat: unit.south },
      { lng: unit.east, lat: unit.north },
    ]);
    setSearchOpen(false);
    setQuery("");
    setHits([]);
  }

  function pickRegion(next: HuntRegion) {
    const target = REGION_VIEW[next];
    if (store.huntRegion !== next) {
      store.setHuntRegion(next);
      setUnits([]);
      setSpotUnit(null);
      setDetail(null);
      setHover(null);
      setPinned(null);
      setLand(null);
      landKey.current = "";
    }
    mapRef.current?.easeTo(target.lng, target.lat, target.zoom);
    setSearchOpen(false);
  }

  async function saveArea() {
    const bounds = mapRef.current?.getBounds();
    if (!bounds || packing) return;
    const templates: string[] = [];
    if (store.basemap === "topo") templates.push(TILES.topo);
    else if (store.basemap !== "street") templates.push(TILES.satellite);
    if (store.showPublic) templates.push(TILES.sma);
    if (templates.length === 0) {
      setPackNote("Street roads and labels are streamed live. Switch to Satellite or Topo to save a base map.");
      return;
    }
    setPacking(true);
    setPackNote("Preparing this view…");
    try {
      const result = await packTiles({
        ...bounds,
        templates,
        onProgress: (done, total) => {
          if (done === total || done % 4 === 0) setPackNote(`Saving map tiles ${done} of ${total}…`);
        },
      });
      if (result.skipped) {
        setPackNote(`Zoom in, then try again. This view needs ${result.total} tiles; the limit is 220.`);
      } else {
        const parts = [`${result.saved} new`, `${result.reused} already saved`];
        if (result.failed) parts.push(`${result.failed} not saved`);
        setPackNote(`${parts.join(", ")}. One zoom level only; roads, labels, weather, and search still need a connection.`);
        void tileCacheLabel().then((label) => {
          if (label) setPackNote(`${parts.join(", ")}. ${label}. Roads, labels, weather, and search still need a connection.`);
        });
      }
    } catch {
      setPackNote("Couldn't save tiles from here.");
    } finally {
      setPacking(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied coordinates.");
    } catch {
      setNotice("Couldn't copy from this browser.");
    }
  }

  async function copyAppLink() {
    const url = `${window.location.origin}/`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied. Safari on an iPhone, Chrome on Android.");
    } catch {
      setNotice("Couldn't copy the link from this browser.");
    }
  }

  function dismissInstall() {
    setInstallDismissed(true);
    try {
      localStorage.setItem("fieldline-install-dismissed", "1");
    } catch {
      /* private mode */
    }
  }

  async function addToPhone() {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") dismissInstall();
      return;
    }
    setSheet(null);
    setInstallHelp(true);
  }

  async function ingest(files: File[]) {
    const seenMarks = new Set(store.waypoints.map(waypointKey));
    const seenTracks = new Set(store.tracks.map(trackKey));
    const waypoints: Waypoint[] = [];
    const tracks: Track[] = [];
    let skipped = 0;
    let trimmed = false;
    const failed: string[] = [];
    const stamp = Date.now();
    for (const file of files) {
      try {
        const parsed = await readTrailFile(file);
        if (parsed.trimmed) trimmed = true;
        for (const mark of parsed.waypoints) {
          const key = waypointKey(mark);
          if (seenMarks.has(key)) {
            skipped += 1;
            continue;
          }
          seenMarks.add(key);
          waypoints.push({ ...mark, id: crypto.randomUUID(), createdAt: stamp });
        }
        for (const track of parsed.tracks) {
          const key = trackKey(track);
          if (seenTracks.has(key)) {
            skipped += 1;
            continue;
          }
          seenTracks.add(key);
          tracks.push({ ...track, id: crypto.randomUUID(), createdAt: stamp, visible: true });
        }
      } catch (error) {
        failed.push(error instanceof Error ? error.message : "Import failed.");
      }
    }
    if (waypoints.length || tracks.length) {
      store.importAll(waypoints, tracks);
      const regionHit = guessRegion([
        ...waypoints.map((mark) => ({ lng: mark.lng, lat: mark.lat })),
        ...tracks.flatMap((track) => [track.points[0], track.points[track.points.length - 1]]),
      ]);
      if (regionHit && regionHit !== useHunt.getState().huntRegion) {
        useHunt.getState().setHuntRegion(regionHit);
        setUnits([]);
        setSpotUnit(null);
        setDetail(null);
        setHover(null);
        setPinned(null);
        setLand(null);
        landKey.current = "";
      }
      const fitPts = [
        ...waypoints.map((mark) => ({ lng: mark.lng, lat: mark.lat })),
        ...tracks.flatMap((track) => {
          const step = Math.max(1, Math.floor(track.points.length / 40));
          const sample = track.points.filter((_, index) => index % step === 0);
          sample.push(track.points[track.points.length - 1]);
          return sample;
        }),
      ];
      window.setTimeout(() => mapRef.current?.fit(fitPts), 80);
    }
    if (waypoints.length + tracks.length === 0 && failed.length && skipped === 0) {
      setNotice(failed[0]);
      return;
    }
    const brought = [
      waypoints.length ? `${waypoints.length} mark${waypoints.length === 1 ? "" : "s"}` : "",
      tracks.length ? `${tracks.length} track${tracks.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    if (!brought.length && skipped) {
      setNotice("Those marks and tracks are already on this map.");
      return;
    }
    let message = brought.length ? `Brought in ${brought.join(" and ")}.` : "Nothing new in that file.";
    if (skipped) message += ` ${skipped} already here.`;
    if (trimmed) message += " A long file was shortened so the map stays fast.";
    if (failed.length) message += " One of the files couldn't be read.";
    setNotice(message);
  }

  function hasDragFiles(event: { dataTransfer: DataTransfer }) {
    return [...event.dataTransfer.types].includes("Files");
  }

  function onDragEnter(event: DragEvent) {
    if (!hasDragFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropHot(true);
  }

  function onDragOver(event: DragEvent) {
    if (!hasDragFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropHot(false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDropHot(false);
    const files = [...event.dataTransfer.files];
    if (files.length) void ingest(files);
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

  const windSpeed = weather
    ? store.imperial
      ? `${Math.round(mpsToMph(weather.windMps))} mph`
      : `${weather.windMps.toFixed(1)} m/s`
    : null;
  const tempLabel = weather ? `${Math.round(store.imperial ? cToF(weather.tempC) : weather.tempC)}°` : null;
  const feelsLabel = weather ? `${Math.round(store.imperial ? cToF(weather.apparentC) : weather.apparentC)}°` : null;
  const highLabel = weather ? `${Math.round(store.imperial ? cToF(weather.highC) : weather.highC)}°` : null;
  const lowLabel = weather ? `${Math.round(store.imperial ? cToF(weather.lowC) : weather.lowC)}°` : null;
  const skyLabel = weather ? weatherLabel(weather.code, true) : null;
  const shootStart = weather ? formatClock(shiftLocalIso(weather.sunrise, -AZ_SHOOT_LEAD_MIN)) : null;
  const shootEnd = weather ? formatClock(shiftLocalIso(weather.sunset, AZ_SHOOT_LEAD_MIN)) : null;
  const shootLabel = shootStart && shootEnd && shootStart !== "—" && shootEnd !== "—" ? `${shootStart}–${shootEnd}` : null;
  const measureLength = pathLength(measureClosed && measurePts.length > 2 ? [...measurePts, measurePts[0]] : measurePts);
  const measureArea = measureClosed ? ringArea(measurePts) : 0;
  const measureBearing =
    !measureClosed && measurePts.length >= 2
      ? bearingDeg(measurePts[measurePts.length - 2], measurePts[measurePts.length - 1])
      : null;
  const sunAz = useMemo(() => {
    if (weather?.sunriseAt == null || weather.sunsetAt == null) return { rise: null as number | null, set: null as number | null };
    const lng = selected?.lng ?? view.lng;
    const lat = selected?.lat ?? view.lat;
    return {
      rise: sunPosition(lng, lat, new Date(weather.sunriseAt)).azimuth,
      set: sunPosition(lng, lat, new Date(weather.sunsetAt)).azimuth,
    };
  }, [selected, view.lng, view.lat, weather?.sunriseAt, weather?.sunsetAt]);
  useEffect(() => {
    if (!store.showShade || shadeMin != null) return;
    const id = window.setInterval(() => setShadeNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [store.showShade, shadeMin]);
  const shadeSun = useMemo(() => {
    const when = shadeMin == null ? new Date(shadeNow) : localDate(clockZone, shadeMin);
    const sun = sunPosition(view.lng, view.lat, when);
    return { azimuth: Math.round(sun.azimuth), elevation: Math.round(sun.elevation) };
  }, [view.lng, view.lat, shadeMin, shadeNow, clockZone]);
  const liveAz = useMemo(() => {
    if (!selected) return null;
    const when = shadeMin == null ? new Date(shadeNow) : localDate(clockZone, shadeMin);
    const sun = sunPosition(selected.lng, selected.lat, when);
    return sun.elevation > 0 ? Math.round(sun.azimuth) : null;
  }, [selected, shadeMin, shadeNow, clockZone]);
  const pressureLabel =
    weather?.pressureHpa == null
      ? null
      : `${formatPressure(weather.pressureHpa, store.imperial)}${weather.pressureTrend ? ` · ${weather.pressureTrend}` : ""}`;
  const spotWeather =
    detail && weather && weatherAt && Math.abs(weatherAt.lat - detail.lat) < 0.02 && Math.abs(weatherAt.lng - detail.lng) < 0.02 ? weather : null;
  const hunts = [...new Set(store.waypoints.map((waypoint) => waypoint.hunt).filter(Boolean))];
  const tilted = Math.abs(view.bearing) > 2 || view.pitch > 8;

  return (
    <main
      className="map-shell relative h-dvh w-full overflow-hidden bg-bg"
      data-sheet={sheet ? "1" : "0"}
      onDragEnterCapture={onDragEnter}
      onDragOverCapture={onDragOver}
      onDragLeaveCapture={onDragLeave}
      onDropCapture={onDrop}
    >
      <input
        ref={fileRef}
        suppressHydrationWarning
        type="file"
        multiple
        accept=".gpx,.kml,.kmz,.geojson,.json,.csv,.xml,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,text/csv,text/xml"
        className="hidden"
        onChange={(event) => {
          const files = event.target.files ? [...event.target.files] : [];
          event.target.value = "";
          if (files.length) void ingest(files);
        }}
      />
      {sheet === null ? (
        <aside className="absolute inset-y-0 left-0 z-20 hidden w-96 flex-col border-r border-line bg-bg lg:flex">
          <div className="shrink-0 border-b border-line px-4 pt-4 pb-3">
            <p className="font-display text-3xl leading-none tracking-widest">FIELDLINE</p>
            <p className="mt-2 text-sm leading-snug text-muted">Plan the hunt here. The phone is the copy you take into the field.</p>
            <button
              type="button"
              onClick={() => {
                setSheet("wind");
                setSearchOpen(false);
              }}
              className="mt-3 flex h-11 w-full items-center justify-between rounded-md border border-line bg-surface px-3 text-left text-sm"
            >
              <span className="flex items-center gap-2">
                <WindArrow deg={weather?.windFrom ?? 0} />
                <span className="font-mono tabular-nums">{weather ? `${cardinal(weather.windFrom)} · ${windSpeed}` : "Wind"}</span>
              </span>
              <span className="text-muted">{[tempLabel, skyLabel].filter(Boolean).join(" · ")}</span>
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="h-11 rounded-md border border-line bg-surface text-sm"
                onClick={() => {
                  setSheet("layers");
                  setSearchOpen(false);
                }}
              >
                Layers
              </button>
              <button
                type="button"
                onClick={onExport}
                disabled={store.waypoints.length + store.tracks.length === 0}
                className="h-11 rounded-md border border-line bg-surface text-sm disabled:opacity-40"
              >
                Export GPX
              </button>
            </div>
            <button type="button" onClick={() => fileRef.current?.click()} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line text-sm">
              <Upload className="size-4" /> Bring in file
            </button>
            <button type="button" onClick={() => setInstallHelp(true)} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line text-sm">
              <Download className="size-4" /> Add to a phone
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <GaiaNote />
            <h2 className="mt-4 font-display text-xl tracking-wide">Marks</h2>
            <WaypointRows
              waypoints={store.waypoints}
              gps={gps}
              imperial={store.imperial}
              onOpen={(id, lng, lat) => {
                setSelectedId(id);
                setSheet("edit");
                mapRef.current?.easeTo(lng, lat, 15);
              }}
            />
            <h2 className="mt-4 font-display text-xl tracking-wide">Tracks</h2>
            <TrackRows tracks={store.tracks} imperial={store.imperial} onFit={(points) => mapRef.current?.fit(points)} onToggle={store.toggleTrack} onDelete={store.removeTrack} />
          </div>
        </aside>
      ) : null}
      <div ref={mapWrapRef} className="absolute inset-0 lg:left-96">
      <MapCanvas
        ref={mapRef}
        hydrated={hydrated}
        basemap={store.basemap}
        showPublic={store.showPublic}
        publicOpacity={store.publicOpacity}
        showLabels={store.showLabels}
        showRoads={store.showRoads}
        showTracks={store.showTracks}
        showCreeks={store.showCreeks}
        showPeaks={store.showPeaks}
        showUnitLabels={store.showUnitLabels}
        showBorder={store.showBorder}
        terrain={store.terrain}
        imperial={store.imperial}
        showMarks={store.showMarks}
        waypoints={store.waypoints}
        selectedId={selectedId}
        tracks={store.tracks}
        livePoints={recPts}
        measurePoints={measurePts}
        measureClosed={measureClosed}
        gps={gps}
        tool={tool}
        showShade={store.showShade}
        showSun={store.showSun}
        showRings={store.showRings}
        showUnits={store.showUnits}
        unitsGeo={unitsGeo}
        borderGeo={region === "id" ? idBorder : azBorder}
        unitLabels={unitLabels}
        windFrom={weather?.windFrom ?? null}
        sunLng={selected?.lng ?? null}
        sunLat={selected?.lat ?? null}
        riseAz={sunAz.rise}
        setAz={sunAz.set}
        liveAz={store.showSun ? liveAz : null}
        shadeAz={store.showShade && store.basemap !== "topo" ? shadeSun.azimuth : null}
        shadeEl={store.showShade && store.basemap !== "topo" ? shadeSun.elevation : null}
        viewZoom={view.zoom}
        ringAt={selected ? { lng: selected.lng, lat: selected.lat } : null}
        onMapClick={onMapClick}
        onContextMenu={openDetail}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onMarkerClick={(id) => {
          setSelectedId(id);
          setSheet("edit");
          setTool("none");
          setPinned(null);
          setHover(null);
          setDetail(null);
        }}
        onView={setView}
        onDragStart={() => {
          followRef.current = false;
          setFollow(false);
          setPinned(null);
        }}
      />

      {tool !== "none" ? <Reticle /> : null}

      {detail && tool === "none" && !sheet ? (
        <div
          data-spot-info
          className="pointer-events-auto absolute z-30 flex flex-col overflow-hidden overscroll-contain rounded-lg border border-line bg-surface shadow-lg touch-pan-y"
          style={placeDetail(detail, mapWrapRef.current, store.showShade && store.basemap !== "topo" ? 1.7 : 0)}
        >
          <SpotInfo
            detail={detail}
            weather={spotWeather}
            imperial={store.imperial}
            onClose={() => setDetail(null)}
            onCopy={copyText}
            onMark={() => dropAt(detail.lng, detail.lat)}
          />
        </div>
      ) : null}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex flex-col gap-2">
          <p className="font-display text-lg leading-none tracking-widest text-fg sm:hidden">FIELDLINE</p>
          <div className="flex items-center gap-2">
            <p className="hidden font-display text-xl tracking-widest text-fg sm:block lg:hidden">FIELDLINE</p>
          <form
            className="relative min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (unitMatch) {
                goToUnit(unitMatch);
                return;
              }
              if (hits[0]) {
                goTo(hits[0].lng, hits[0].lat, 12);
                return;
              }
              void submitPlaceSearch();
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-subtle" />
            <input
              suppressHydrationWarning
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search a unit, town, or ridge"
              aria-label="Search places"
              autoCapitalize="off"
              autoCorrect="off"
              className="field field-search h-11"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted"
                onClick={() => {
                  setQuery("");
                }}
              >
                <X className="size-4" />
              </button>
            ) : null}
            {searchOpen ? (
              <div className="absolute inset-x-0 top-12 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
                {unitMatch ? (
                  <button
                    type="button"
                    className="flex min-h-11 w-full flex-col items-start justify-center px-3 text-left hover:bg-surface-2"
                    onClick={() => goToUnit(unitMatch)}
                  >
                    <span>Unit {unitMatch.gmu}</span>
                    <span className="text-sm text-muted">
                      {[unitMatch.regionName, unitMatch.forest].filter(Boolean).join(" · ") || (region === "id" ? "Idaho game unit" : "Arizona game unit")}
                    </span>
                  </button>
                ) : null}
                {query.trim().length < 2 ? (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs tracking-wide text-subtle uppercase">Jump</p>
                    {jumps.map((place) => (
                      <button
                        key={place.name}
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between rounded-md px-2 text-left hover:bg-surface-2"
                        onClick={() => goTo(place.lng, place.lat, place.zoom)}
                      >
                        <span>{place.name}</span>
                        <span className="text-sm text-muted">{place.hint}</span>
                      </button>
                    ))}
                  </div>
                ) : searching && hits.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted" role="status">Searching nearby places…</p>
                ) : hits.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted">Press Enter to search nearby places.</p>
                ) : (
                  hits.map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      className="flex min-h-11 w-full flex-col items-start justify-center px-3 text-left hover:bg-surface-2"
                      onClick={() => goTo(hit.lng, hit.lat, 13)}
                    >
                      <span>{hit.name}</span>
                      <span className="text-sm text-muted">{hit.detail}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </form>
          <div className="flex h-11 shrink-0 overflow-hidden rounded-full border border-line bg-surface" role="group" aria-label="Hunt state">
            <button
              type="button"
              data-on={region === "az"}
              className="h-11 px-2.5 text-sm font-medium text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
              onClick={() => pickRegion("az")}
            >
              AZ
            </button>
            <button
              type="button"
              data-on={region === "id"}
              className="h-11 px-2.5 text-sm font-medium text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
              onClick={() => pickRegion("id")}
            >
              ID
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setSheet(sheet === "wind" ? null : "wind");
              setSearchOpen(false);
            }}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-fg lg:hidden"
            aria-label="Weather"
          >
            {weather ? <WeatherMark code={weather.code} /> : <WindArrow deg={0} />}
            {tempLabel ? <span className="font-mono tabular-nums">{tempLabel}</span> : null}
            <span className="font-mono text-muted tabular-nums">{windSpeed ?? "Wind"}</span>
          </button>
          </div>
        </div>

        <div className="pointer-events-auto flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => setCoordMode((mode) => (mode === "dd" ? "dms" : mode === "dms" ? "utm" : "dd"))}
            className="rounded-md bg-surface/95 px-2.5 py-1.5 text-left font-mono text-xs leading-relaxed text-fg tabular-nums"
          >
            {coordMode === "dd" ? formatDd(readLng, readLat) : coordMode === "dms" ? formatDms(readLng, readLat) : formatUtm(readLng, readLat)}
            <span className="mt-0.5 block max-w-[18rem] truncate text-muted">
              {probe && spotUnit ? `Unit ${spotUnit.gmu}` : null}
              {probe && spotUnit ? " · " : ""}
              {landHit ? `${landHit.tone === "private" ? "Private" : landHit.agency} · ` : ""}
              {shootLabel ? `Light ${shootLabel}` : null}
              {shootLabel ? " · " : ""}
              {weather?.elevationM != null ? `${formatElev(weather.elevationM, store.imperial)} elev` : "Elev —"}
              {weather?.slopePct != null ? ` · ${Math.round(weather.slopePct)}%${weather.fallsDeg != null ? ` falls ${cardinal(weather.fallsDeg)}` : ""}` : ""}
              {tempLabel ? ` · ${tempLabel}` : ""}
              {skyLabel ? ` ${skyLabel}` : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-start gap-2">
            {tilted ? (
              <button
                type="button"
                onClick={() => mapRef.current?.resetNorth()}
                className="grid size-11 place-items-center rounded-full border border-line bg-surface text-fg"
                aria-label="Reset north"
              >
                <Compass className="size-5" style={{ transform: `rotate(${-view.bearing}deg)` }} />
              </button>
            ) : null}
            <button
              type="button"
              data-on={listening}
              aria-label={listening ? "Stop noise meter" : "Noise meter"}
              onClick={() => setListening((on) => !on)}
              className="grid size-11 place-items-center rounded-full border border-line bg-surface text-fg data-[on=true]:bg-accent data-[on=true]:text-accent-fg"
            >
              <Mic className="size-5" />
            </button>
          </div>
        </div>

        {hydrated && !store.introDismissed ? (
          <div className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-muted lg:hidden">
            <p>
              Color shows who manages the surface. Pale and amber lines from a mark show today's sunrise and sunset. Green rings on a stand mean today's wind matches the directions you saved.
            </p>
            <button type="button" aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center text-fg" onClick={store.dismissIntro}>
              <X className="size-4" />
            </button>
          </div>
        ) : null}
        {hydrated && store.introDismissed && installDismissed === false && !standalone ? (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 lg:hidden">
            <p className="min-w-0 flex-1 text-sm text-fg">Add Fieldline to this phone. No app store.</p>
            <button type="button" className="h-10 shrink-0 rounded-full bg-accent px-3 text-sm font-medium text-accent-fg" onClick={() => void addToPhone()}>
              Add
            </button>
            <button type="button" aria-label="Dismiss install" className="grid size-10 shrink-0 place-items-center text-muted" onClick={dismissInstall}>
              <X className="size-4" />
            </button>
          </div>
        ) : null}
      </header>

      {searchOpen ? (
        <button type="button" aria-label="Close search" className="absolute inset-0 z-10 cursor-default" onClick={() => setSearchOpen(false)} />
      ) : null}

      <div
        className={`pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-2 px-3 ${
          store.showShade && store.basemap !== "topo" && sheet === null
            ? "bottom-[max(7.25rem,calc(6.4rem+env(safe-area-inset-bottom)))]"
            : "bottom-[max(5.5rem,calc(4.5rem+env(safe-area-inset-bottom)))]"
        }`}
      >
        {notice ? <p role="status" aria-live="polite" className="pointer-events-auto max-w-sm rounded-lg bg-surface px-3 py-1.5 text-center text-sm text-fg">{notice}</p> : null}
        {gpsError ? <p role="alert" aria-live="assertive" className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-muted">{gpsError}</p> : null}
        {recordPending ? <p role="status" aria-live="polite" className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-muted">Waiting for GPS before recording.</p> : null}
        {listening ? <NoiseMeter /> : null}
        {recording ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <span className="size-2 rounded-full bg-danger" />
            <span className="font-mono tabular-nums">
              {formatDistance(pathLength(recPts), store.imperial)} · {formatDuration(now - (recStart ?? now))}
            </span>
            <button type="button" className="text-danger" onClick={discardTrack}>
              Discard
            </button>
          </div>
        ) : null}
        {tool === "drop" ? (
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-3 text-sm">
            <span>Tap the map, or</span>
            <button
              type="button"
              className="h-9 rounded-full bg-accent px-3 font-medium text-accent-fg"
              onClick={() => {
                const center = mapRef.current?.getCenter() ?? { lng: view.lng, lat: view.lat };
                dropAt(center.lng, center.lat);
              }}
            >
              Drop at crosshair
            </button>
          </div>
        ) : null}
        {tool === "measure" ? (
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <span className="font-mono tabular-nums">
              {measurePts.length < 2 ? "Tap points" : formatDistance(measureLength, store.imperial)}
              {measureBearing != null ? ` · ${Math.round(measureBearing)}° ${cardinal(measureBearing)}` : ""}
              {measureClosed ? ` · ${formatArea(measureArea, store.imperial)}` : ""}
            </span>
            <button type="button" className="h-9 px-1 text-muted" onClick={() => setMeasurePts((points) => points.slice(0, -1))} disabled={measurePts.length === 0}>
              Undo
            </button>
            <button
              type="button"
              className="h-9 px-1 text-fg"
              disabled={measurePts.length < 3 || measureClosed}
              onClick={() => setMeasureClosed(true)}
            >
              Area
            </button>
            <button
              type="button"
              className="h-9 px-1 text-muted"
              onClick={() => {
                setMeasurePts([]);
                setMeasureClosed(false);
              }}
            >
              Clear
            </button>
          </div>
        ) : null}
      </div>

      {store.showShade && store.basemap !== "topo" && sheet === null ? (
        <ShadeBar
          minutes={shadeMin ?? localMinutes(clockZone)}
          live={shadeMin == null}
          azimuth={shadeSun.azimuth}
          elevation={shadeSun.elevation}
          onChange={setShadeMin}
          onNow={() => setShadeMin(null)}
        />
      ) : null}

      {sheet === null ? (
        <nav className="absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-3">
          <div className="flex max-w-full items-stretch gap-0.5 overflow-x-auto rounded-full border border-line bg-surface p-1">
            <DockButton label={follow ? "Follow" : "GPS"} on={follow} icon={LocateFixed} onClick={onLocate} />
            <DockButton
              label="Mark"
              on={tool === "drop"}
              icon={Crosshair}
              onClick={() => {
                setTool(tool === "drop" ? "none" : "drop");
                setSheet(null);
                setSearchOpen(false);
              }}
            />
            <DockButton
              label="Measure"
              on={tool === "measure"}
              icon={Ruler}
              onClick={() => {
                setTool(tool === "measure" ? "none" : "measure");
                setMeasureClosed(false);
                setSheet(null);
              }}
            />
            <DockButton
              label={recordPending ? "Cancel" : recording ? "Stop" : "Track"}
              on={recording || recordPending}
              danger={recording}
              icon={MapPinned}
              onClick={toggleRecord}
            />
            <DockButton
              label="Layers"
              on={false}
              icon={Layers}
              className="lg:hidden"
              onClick={() => {
                setSheet("layers");
                setSearchOpen(false);
              }}
            />
            <DockButton
              label="Saved"
              on={false}
              icon={Bookmark}
              className="lg:hidden"
              onClick={() => {
                setSheet("saved");
                setSearchOpen(false);
              }}
            />
          </div>
        </nav>
      ) : null}
      </div>

      {installHelp ? <InstallSheet onClose={() => setInstallHelp(false)} onCopy={() => void copyAppLink()} /> : null}

      {sheet === "layers" ? (
        <Panel title="Layers" onClose={() => setSheet(null)}>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-bg p-2">
            {BASEMAPS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-on={store.basemap === item.id}
                onClick={() => store.setBasemap(item.id)}
                className="h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
              >
                {item.label}
              </button>
            ))}
          </div>
          <Toggle checked={store.showPublic} onChange={store.setShowPublic} label="Public land" hint="BLM surface management. Blank ground is usually private." />
          <Toggle checked={store.showUnits} onChange={store.setShowUnits} label="Hunt units" hint={region === "id" ? "Idaho Fish and Game units. Reference lines, not the legal boundary." : "Arizona game management units. The lines meet at shared borders."} />
          <Toggle checked={store.showBorder} onChange={store.setShowBorder} label="State border" hint={region === "id" ? "The Idaho state line, closed around the whole state." : "The Arizona state line, closed around the whole state."} />
          <Toggle checked={store.showUnitLabels} onChange={store.setShowUnitLabels} label="Unit numbers" hint="They hide when you zoom out." />
          <Toggle checked={store.showRoads} onChange={store.setShowRoads} label="Roads" hint="Freeways are orange, highways gold, local roads gray. Off on the topo scan." />
          <Toggle checked={store.showTracks} onChange={store.setShowTracks} label="Forest tracks" hint="Tracks and trails, from closer zoom." />
          <Toggle checked={store.showCreeks} onChange={store.setShowCreeks} label="Creeks" hint="Rivers and named creeks." />
          <Toggle checked={store.showPeaks} onChange={store.setShowPeaks} label="Peaks" hint="Summit names and elevation." />
          <Toggle checked={store.showLabels} onChange={store.setShowLabels} label="Towns" hint="Cities, towns, and small places. Off on the topo scan." />
          <Toggle checked={listening} onChange={setListening} label="Noise meter" hint="How much louder you are than the moment you turned it on. A phone mic is not a lab meter." />
          <button type="button" className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line text-sm" onClick={() => void addToPhone()}>
            <Download className="size-4" /> Add to home screen
          </button>
          {store.showPublic ? (
            <label className="block pb-2 text-sm text-muted">
              Overlay strength
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={store.publicOpacity}
                aria-label="Public land opacity"
                onChange={(event) => store.setPublicOpacity(Number(event.target.value))}
              />
            </label>
          ) : null}
          <Toggle checked={store.showShade} onChange={store.setShowShade} label="Sun shade" hint="Shaded faces follow the sun. Scrub the time bar to move through the day. Off on the topo scan." />
          <Toggle checked={store.showSun} onChange={store.setShowSun} label="Sun lines" hint="From the selected mark. Pale is sunrise, amber is sunset, white is the sun at the time on the shade bar." />
          <Toggle checked={store.showRings} onChange={store.setShowRings} label="Range rings" hint={store.imperial ? "100, 200, and 400 yards around the selected mark." : "100, 200, and 400 meters around the selected mark."} />
          <Toggle checked={store.terrain} onChange={store.setTerrain} label="3D terrain" hint="Tilt the map. Heavier on a phone." />
          <Toggle checked={store.showMarks} onChange={store.setShowMarks} label="My marks" />
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-2">
            <button type="button" data-on={store.imperial} onClick={() => store.setImperial(true)} className="h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg">
              Yards / miles
            </button>
            <button type="button" data-on={!store.imperial} onClick={() => store.setImperial(false)} className="h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg">
              Meters
            </button>
          </div>
          <ul className="mt-4 grid grid-cols-2 gap-y-2">
            {LEGEND.map((item) => (
              <li key={item.label} className="flex items-center gap-2 text-sm text-muted">
                <span className="size-3 rounded-sm border border-line" style={{ background: item.swatch }} />
                {item.label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-subtle">Right-click a spot, or press and hold, for the unit, who manages the ground, and the weather there. {region === "id" ? "Unit lines are Idaho Fish and Game reference geometry, not the legal description." : "Unit lines are Arizona Game and Fish reference geometry, not the legal description in Commission Rule R12-4-108."} Owner names are a paid dataset. Fieldline shows the managing agency and wind for each stand. A small, one-zoom tile cache is available for Satellite or Topo; streets, labels, units, weather, and search remain online.</p>
          <button type="button" disabled={packing} onClick={() => void saveArea()} className="mt-3 h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-50">
            {packing ? "Saving tiles…" : "Save this view offline"}
          </button>
          {packNote ? <p className="mt-2 text-sm text-muted">{packNote}</p> : null}
        </Panel>
      ) : null}

      {sheet === "wind" && weather ? (
        <Panel title="Weather" onClose={() => setSheet(null)}>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm text-muted">{weatherLabel(weather.code)}</p>
              <p className="font-display text-5xl leading-none tracking-wide">{tempLabel}</p>
              <p className="mt-2 text-muted">
                {highLabel} high · {lowLabel} low
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <WeatherMark code={weather.code} large />
              <span className="flex items-center gap-1.5 text-sm">
                <WindArrow deg={weather.windFrom} />
                <span className="font-mono tabular-nums">
                  {cardinal(weather.windFrom)} {windSpeed}
                </span>
              </span>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <Stat label="Wind" value={windSpeed ?? "—"} />
            <Stat
              label="Gusts"
              value={store.imperial ? `${Math.round(mpsToMph(weather.gustMps))} mph` : `${weather.gustMps.toFixed(1)} m/s`}
            />
            <Stat label="Feels" value={feelsLabel ?? "—"} />
            <Stat label="Humidity" value={`${Math.round(weather.humidity)}%`} />
            <Stat label="Clouds" value={`${Math.round(weather.cloud)}%`} />
            <Stat label="Rain" value={`${Math.round(weather.pop)}%`} />
            <Stat label="Moon" value={`${Math.round(weather.moonIllum * 100)}%`} />
            <Stat label="Phase" value={weather.moonName} />
            <Stat label="Barometer" value={pressureLabel ?? "—"} />
            <Stat label="Sun rises" value={sunAz.rise == null ? "—" : `${Math.round(sunAz.rise)}° ${cardinal(sunAz.rise)}`} />
            <Stat label="Sun sets" value={sunAz.set == null ? "—" : `${Math.round(sunAz.set)}° ${cardinal(sunAz.set)}`} />
            <Stat label="Sunrise" value={formatClock(weather.sunrise)} />
            <Stat label="Sunset" value={formatClock(weather.sunset)} />
            <Stat label="Shoot starts" value={shootStart ?? "—"} />
            <Stat label="Shoot ends" value={shootEnd ?? "—"} />
          </dl>
          <p className="mt-4 text-sm text-subtle">
            {region === "id"
              ? "Idaho big game shooting hours run a half hour before sunrise until a half hour after sunset. Wild turkey and migratory birds stop at sunset."
              : "Arizona big game shooting hours run a half hour before sunrise until a half hour after sunset."}{" "}
            That clock follows the pointer, or the map center when you are not pointing at a spot. Wind and the barometer are the Open-Meteo model, not a ridgetop reading. The trend compares now with three hours ago. Sun direction is for the selected mark. Rain is the day's peak chance.
          </p>
          <DayStrip days={weather.days} imperial={store.imperial} />
          <HourStrip hours={weather.hours} imperial={store.imperial} goodWinds={selected?.goodWinds} standName={selected?.name ?? null} />
          <StandWind waypoints={store.waypoints} windFrom={weather.windFrom} onOpen={(id, lng, lat) => {
            setSelectedId(id);
            mapRef.current?.easeTo(lng, lat, 15);
            setSheet("edit");
          }} />
        </Panel>
      ) : null}
      {sheet === "wind" && !weather ? (
        <Panel title="Weather" onClose={() => setSheet(null)}>
          <p className="text-muted">Weather hasn't answered yet. Check your connection and try again.</p>
          <button
            type="button"
            className="mt-3 h-11 w-full rounded-md border border-line text-sm"
            onClick={() => setWeatherRefresh((refresh) => refresh + 1)}
          >
            Try again
          </button>
        </Panel>
      ) : null}

      {sheet === "saved" ? (
        <Panel title="Saved" onClose={() => setSheet(null)}>
          <div className="mb-3 flex gap-2">
            <button type="button" onClick={onExport} disabled={store.waypoints.length + store.tracks.length === 0} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm disabled:opacity-40">
              <Download className="size-4" /> Export GPX
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm">
              <Upload className="size-4" /> Bring in file
            </button>
          </div>
          <GaiaNote />
          <h3 className="mt-4 font-display text-xl tracking-wide">Marks</h3>
          <WaypointRows
            waypoints={store.waypoints}
            gps={gps}
            imperial={store.imperial}
            onOpen={(id, lng, lat) => {
              setSelectedId(id);
              setSheet("edit");
              mapRef.current?.easeTo(lng, lat, 15);
            }}
          />
          <h3 className="mt-4 font-display text-xl tracking-wide">Tracks</h3>
          <TrackRows
            tracks={store.tracks}
            imperial={store.imperial}
            onFit={(points) => mapRef.current?.fit(points)}
            onToggle={store.toggleTrack}
            onDelete={store.removeTrack}
          />
        </Panel>
      ) : null}

      {sheet === "edit" && selected ? (
        <Panel title="Mark" onClose={() => setSheet(null)}>
          <EditMark
            key={selected.id}
            name={selected.name}
            kind={selected.kind}
            hunt={selected.hunt}
            notes={selected.notes}
            goodWinds={selected.goodWinds ?? []}
            hunts={hunts}
            lng={selected.lng}
            lat={selected.lat}
            away={gps ? `${formatDistance(haversine(gps, selected), store.imperial)} ${cardinal(bearingDeg(gps, selected))}` : null}
            onChange={(patch) => {
              store.updateWaypoint(selected.id, patch);
              if (patch.kind) store.setLastKind(patch.kind);
              if (typeof patch.hunt === "string") store.setActiveHunt(patch.hunt);
            }}
            onCopy={() => void copyText(`${selected.name}\n${formatPair(selected.lng, selected.lat)}`)}
            onDelete={() => {
              store.removeWaypoint(selected.id);
              setSelectedId(null);
              setSheet(null);
            }}
          />
        </Panel>
      ) : null}
      {dropHot ? (
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-bg/80 px-6">
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-center text-sm">
            Drop the Gaia export
            <span className="mt-1 block text-muted">GPX, KML, KMZ, or GeoJSON</span>
          </p>
        </div>
      ) : null}
    </main>
  );
}

function GaiaNote() {
  return (
    <p className="text-sm leading-snug text-subtle">
      From Gaia, open Saved, file the marks and tracks into one folder, then Share and export GPX or KML. Drop that file on the map, or use Bring in file. Routes and areas come in as tracks. The same file won't add twice.
    </p>
  );
}

function WaypointRows({
  waypoints,
  gps,
  imperial,
  onOpen,
}: {
  waypoints: Waypoint[];
  gps: GpsFix | null;
  imperial: boolean;
  onOpen: (id: string, lng: number, lat: number) => void;
}) {
  if (waypoints.length === 0) {
    return <p className="py-3 text-sm text-muted">No marks yet. Use Mark, then the stand, gate, or camp.</p>;
  }
  return (
    <ul className="mt-1">
      {waypoints.map((waypoint) => {
        const meta = MARKS[waypoint.kind];
        const Icon = meta.icon;
        const away = gps ? formatDistance(haversine(gps, waypoint), imperial) : null;
        const heading = gps ? cardinal(bearingDeg(gps, waypoint)) : null;
        return (
          <li key={waypoint.id}>
            <button
              type="button"
              className="flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-2"
              onClick={() => onOpen(waypoint.id, waypoint.lng, waypoint.lat)}
            >
              <span className={`grid size-8 shrink-0 place-items-center rounded-full ${meta.pinClass}`}>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{waypoint.name}</span>
                <span className="block truncate text-sm text-muted">
                  {waypoint.hunt || meta.label}
                  {away && heading ? ` · ${away} ${heading}` : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TrackRows({
  tracks,
  imperial,
  onFit,
  onToggle,
  onDelete,
}: {
  tracks: Track[];
  imperial: boolean;
  onFit: (points: TrackPoint[]) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (tracks.length === 0) {
    return <p className="py-3 text-sm text-muted">No tracks yet. Track a walk, then stop to keep it.</p>;
  }
  return (
    <ul className="mt-1">
      {tracks.map((track) => (
        <li key={track.id} className="flex min-h-12 items-center gap-2">
          <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onFit(track.points)}>
            <span className="block truncate">{track.name}</span>
            <span className="text-sm text-muted">{formatDistance(pathLength(track.points), imperial)}</span>
          </button>
          <button type="button" className="h-9 px-2 text-sm text-muted" onClick={() => onToggle(track.id)}>
            {track.visible ? "Hide" : "Show"}
          </button>
          {confirmId === track.id ? (
            <>
              <button
                type="button"
                className="h-9 px-2 text-sm text-danger"
                onClick={() => {
                  onDelete(track.id);
                  setConfirmId(null);
                }}
              >
                Confirm
              </button>
              <button type="button" className="h-9 px-2 text-sm" onClick={() => setConfirmId(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={`Delete ${track.name}`}
              className="h-9 px-2 text-sm text-danger"
              onClick={() => setConfirmId(track.id)}
            >
              Delete
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function StandWind({
  waypoints,
  windFrom,
  onOpen,
}: {
  waypoints: { id: string; name: string; kind: MarkKind; lng: number; lat: number; goodWinds?: number[] }[];
  windFrom: number;
  onOpen: (id: string, lng: number, lat: number) => void;
}) {
  const marked = waypoints.filter((waypoint) => (waypoint.goodWinds?.length ?? 0) > 0);
  if (marked.length === 0) {
    return <p className="mt-4 text-sm text-muted">Open a stand and tick the winds you can hunt. Matching stands get a green ring.</p>;
  }
  return (
    <ul className="mt-4">
      {marked.map((waypoint) => {
        const ok = windFits(windFrom, waypoint.goodWinds);
        return (
          <li key={waypoint.id}>
            <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 text-left" onClick={() => onOpen(waypoint.id, waypoint.lng, waypoint.lat)}>
              <span className="truncate">{waypoint.name}</span>
              <span className={ok ? "text-field" : "text-danger"}>{ok ? "Sit it" : "Stay off"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Reticle() {
  return (
    <div className="pointer-events-none absolute top-1/2 left-1/2 z-10 size-10 -translate-x-1/2 -translate-y-1/2" aria-hidden>
      <span className="absolute top-0 left-1/2 h-3 w-px -translate-x-1/2 bg-fg" />
      <span className="absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-fg" />
      <span className="absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 bg-fg" />
      <span className="absolute top-1/2 right-0 h-px w-3 -translate-y-1/2 bg-fg" />
    </div>
  );
}

function NoiseMeter() {
  const [above, setAbove] = useState<number | null>(null);
  const [peak, setPeak] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    const warmup: number[] = [];
    let floor = -50;
    let smoothed = -50;
    let armed = false;
    let peakDelta = 0;
    let peakAt = 0;
    let lastUi = 0;

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser has no microphone.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
        if (dead) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        ctx = new AudioContext();
        if (ctx.state === "suspended") await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const tick = () => {
          if (dead) return;
          analyser.getFloatTimeDomainData(data);
          const db = rmsDb(data);
          smoothed = smoothed * 0.7 + db * 0.3;
          const now = performance.now();
          if (!armed) {
            warmup.push(smoothed);
            if (warmup.length >= 14) {
              floor = warmup.reduce((sum, value) => sum + value, 0) / warmup.length;
              armed = true;
            }
          } else if (now - lastUi > 120) {
            lastUi = now;
            const delta = Math.max(0, smoothed - floor);
            if (delta >= peakDelta) {
              peakDelta = delta;
              peakAt = now;
            } else if (now - peakAt > 2000) {
              peakDelta = Math.max(delta, peakDelta - 0.6);
              peakAt = now;
            }
            const next = Math.round(delta);
            const nextPeak = Math.round(peakDelta);
            setAbove((prev) => (prev === next ? prev : next));
            setPeak((prev) => (prev === nextPeak ? prev : nextPeak));
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!dead) setError("Mic is blocked. Allow it, then tap the mic again.");
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close();
    };
  }, []);

  const hot = (above ?? 0) >= 18;
  return (
    <div className="pointer-events-auto w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-2">
      {error ? (
        <p className="text-sm text-muted">{error}</p>
      ) : above == null ? (
        <p className="text-sm text-fg">Hold still. Setting the quiet level.</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-2xl leading-none tabular-nums">+{above}</p>
            <p className={`text-sm ${hot ? "text-danger" : "text-fg"}`}>{noiseWord(above)}</p>
            <p className="font-mono text-xs text-muted tabular-nums">Peak +{peak}</p>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg" aria-hidden>
            <div className={`h-full rounded-full ${hot ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.min(100, (above / 30) * 100)}%` }} />
          </div>
        </>
      )}
      <p className="mt-1.5 text-xs leading-snug text-muted">0 is as quiet as when you turned this on. A phone mic shows change, not a real decibel number.</p>
    </div>
  );
}

function WindArrow({ deg, large = false }: { deg: number; large?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={large ? "size-16 text-fg" : "size-4 text-field"} style={{ transform: `rotate(${(deg + 180) % 360}deg)` }} aria-hidden>
      <path d="M12 3.5v13M7.5 12.5 12 19l4.5-6.5" fill="none" stroke="currentColor" strokeWidth={large ? 1.5 : 1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DockButton({
  label,
  on,
  danger = false,
  icon: Icon,
  onClick,
  className = "",
}: {
  label: string;
  on: boolean;
  danger?: boolean;
  icon: typeof LocateFixed;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-on={on}
      onClick={onClick}
      className={`flex min-w-12 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-xs ${
        on ? (danger ? "bg-danger text-fg" : "bg-accent text-accent-fg") : "text-muted"
      } ${className}`}
    >
      <Icon className="size-5" />
      {label}
    </button>
  );
}

function phoneOs(): "ios" | "android" | "other" {
  const ua = navigator.userAgent;
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || iPad) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function InstallSheet({ onClose, onCopy }: { onClose: () => void; onCopy: () => void }) {
  const os = phoneOs();
  const title = os === "ios" ? "iPhone" : os === "android" ? "Android" : "Family phones";
  return (
    <Panel title={title} onClose={onClose}>
      <p className="text-sm text-muted">Same map on every phone. There is no store. Each phone keeps its own marks.</p>
      {os !== "android" ? (
        <div className="mt-4">
          <h3 className="font-display text-lg tracking-wide">iPhone</h3>
          <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm">
            <li>Open the link in Safari. Chrome on an iPhone cannot install it.</li>
            <li>Tap Share, then Add to Home Screen.</li>
            <li>Tap Add. The icon then opens Fieldline full screen.</li>
          </ol>
        </div>
      ) : null}
      {os !== "ios" ? (
        <div className="mt-4">
          <h3 className="font-display text-lg tracking-wide">Android</h3>
          <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm">
            <li>Open the link in Chrome, not inside a text or Facebook preview.</li>
            <li>Tap the three dots at the top right.</li>
            <li>Tap Install app. If that line is missing, tap Add to Home screen, then Add.</li>
          </ol>
        </div>
      ) : null}
      <button type="button" className="mt-4 h-11 w-full rounded-full bg-accent text-sm font-medium text-accent-fg" onClick={onCopy}>
        Copy link
      </button>
    </Panel>
  );
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () =>
      [...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter((element) => element.getClientRects().length > 0);
    const focusable = getFocusable();
    (focusable[0] ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panel) return;
      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[min(78dvh,40rem)] flex-col rounded-t-xl border border-line bg-surface shadow-lg md:inset-y-4 md:left-4 md:w-96 md:max-h-none md:rounded-xl lg:inset-y-0 lg:left-0 lg:w-96 lg:rounded-none lg:border-y-0 lg:border-l-0 lg:shadow-none"
    >
      <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
        <h2 id={titleId} className="font-display text-2xl leading-none tracking-wide">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
          <X className="size-5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 py-1.5">
      <span>
        <span className="block">{label}</span>
        {hint ? <span className="block text-sm text-muted">{hint}</span> : null}
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        className="relative h-7 w-12 shrink-0 rounded-full bg-surface-2 data-[state=checked]:bg-field"
      >
        <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-fg transition-transform duration-150 data-[state=checked]:translate-x-6" />
      </Switch.Root>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-bg px-3 py-2">
      <dt className="text-xs tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="font-mono text-base leading-snug tabular-nums">{value}</dd>
    </div>
  );
}

function weekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? iso;
}

function DayStrip({ days, imperial }: { days: DayOutlook[]; imperial: boolean }) {
  if (days.length === 0) return null;
  return (
    <div className="mt-4 grid grid-cols-4 gap-2">
      {days.map((day, index) => (
        <div key={day.date} className="rounded-md bg-bg px-1 py-2 text-center">
          <p className="text-xs tracking-wide text-subtle uppercase">{index === 0 ? "Today" : weekday(day.date)}</p>
          <p className="mt-1 text-sm leading-tight">{weatherLabel(day.code, true)}</p>
          <p className="font-mono text-sm tabular-nums">
            {Math.round(imperial ? cToF(day.highC) : day.highC)}°
            <span className="text-muted"> {Math.round(imperial ? cToF(day.lowC) : day.lowC)}°</span>
          </p>
          <p className="text-xs text-muted">{Math.round(day.pop)}% rain</p>
        </div>
      ))}
    </div>
  );
}

function WeatherMark({ code, large = false }: { code: number; large?: boolean }) {
  const Icon = code === 0 ? Sun : code <= 2 ? CloudSun : code === 3 ? Cloud : code <= 49 ? CloudFog : code <= 69 || (code >= 80 && code <= 82) ? CloudRain : code <= 86 ? CloudSnow : CloudLightning;
  return <Icon className={large ? "size-14 text-field" : "size-4 text-field"} strokeWidth={1.75} aria-hidden />;
}

function HourStrip({
  hours,
  imperial,
  goodWinds,
  standName,
}: {
  hours: WindHour[];
  imperial: boolean;
  goodWinds: number[] | undefined;
  standName: string | null;
}) {
  if (hours.length === 0) return null;
  const marked = (goodWinds?.length ?? 0) > 0;
  return (
    <div className="mt-4">
      <p className="text-sm text-muted">{marked && standName ? `Green hours fit ${standName}.` : "Wind by the hour, from now."}</p>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {hours.map((hour) => {
          const ok = marked ? windFits(hour.windFrom, goodWinds) : null;
          const speed = imperial ? `${Math.round(mpsToMph(hour.windMps))}` : hour.windMps.toFixed(1);
          return (
            <div
              key={hour.at}
              className={`min-w-16 shrink-0 rounded-md px-2 py-2 text-center ${ok === true ? "bg-field text-accent-fg" : ok === false ? "bg-danger/25 text-fg" : "bg-bg"}`}
            >
              <p className="font-mono text-xs tabular-nums">{formatClock(hour.time)}</p>
              <p className="text-sm">{cardinal(hour.windFrom)}</p>
              <p className="font-mono text-xs tabular-nums">{speed}</p>
              {hour.pop >= 20 ? <p className="font-mono text-xs tabular-nums">{Math.round(hour.pop)}%</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SHADE_MIN = 5 * 60;
const SHADE_MAX = 20 * 60 + 30;

function formatMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const hr = hour % 12 || 12;
  return `${hr}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

function ShadeBar({
  minutes,
  live,
  azimuth,
  elevation,
  onChange,
  onNow,
}: {
  minutes: number;
  live: boolean;
  azimuth: number;
  elevation: number;
  onChange: (minutes: number) => void;
  onNow: () => void;
}) {
  const value = Math.min(SHADE_MAX, Math.max(SHADE_MIN, Math.round(minutes / 15) * 15));
  return (
    <div className="pointer-events-auto absolute inset-x-3 bottom-[max(4.75rem,calc(3.95rem+env(safe-area-inset-bottom)))] z-20 mx-auto flex h-9 w-auto max-w-[18rem] items-center gap-1.5 rounded-full border border-line bg-surface/95 px-1.5">
      <span className="w-[4.4rem] shrink-0 text-center font-mono text-[11px] tabular-nums">{formatMinutes(minutes)}</span>
      <input
        type="range"
        className="shade-range min-w-0 flex-1"
        min={SHADE_MIN}
        max={SHADE_MAX}
        step={15}
        value={value}
        aria-label="Time of day for slope shade"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-[3.4rem] shrink-0 truncate text-center text-[11px] text-muted">{elevation <= 0 ? "Down" : `${cardinal(azimuth)} ${elevation}°`}</span>
      <button type="button" className="h-8 shrink-0 rounded-full px-2 text-[11px] text-fg disabled:text-subtle" disabled={live} onClick={onNow}>
        Now
      </button>
    </div>
  );
}

function placeDetail(at: Spot, node: HTMLDivElement | null, lift = 0): CSSProperties {
  const width = node?.clientWidth ?? 800;
  const height = node?.clientHeight ?? 700;
  if (width < 520) {
    return {
      left: 12,
      right: 12,
      bottom: `calc(${5.5 + lift}rem + env(safe-area-inset-bottom, 0px))`,
      maxHeight: `calc(100% - ${14.5 + lift}rem - env(safe-area-inset-bottom, 0px))`,
    };
  }
  const cardW = 304;
  const edge = 12;
  const dock = 80 + Math.round(lift * 16);
  const topLimit = edge;
  const bottomLimit = Math.max(topLimit + 160, height - dock);
  const usable = bottomLimit - topLimit;
  const preferLeft = at.x > width - cardW - 20;
  const left = preferLeft
    ? Math.max(edge, at.x - cardW - 14)
    : Math.min(Math.max(edge, at.x + 14), Math.max(edge, width - cardW - edge));
  const spaceAbove = Math.max(0, at.y - 16 - topLimit);
  const spaceBelow = Math.max(0, bottomLimit - (at.y + 16));
  if (Math.max(spaceAbove, spaceBelow) < 200) {
    return { left, top: topLimit, width: cardW, maxHeight: usable };
  }
  if (spaceBelow >= spaceAbove) {
    const top = Math.min(Math.max(topLimit, at.y + 16), bottomLimit - 160);
    return { left, top, width: cardW, maxHeight: Math.max(160, bottomLimit - top) };
  }
  const bottom = Math.max(dock, height - at.y + 16);
  return { left, bottom, width: cardW, maxHeight: Math.max(160, height - bottom - topLimit) };
}

function SpotInfo({
  detail,
  weather,
  imperial,
  onClose,
  onCopy,
  onMark,
}: {
  detail: Detail;
  weather: FieldWeather | null;
  imperial: boolean;
  onClose: () => void;
  onCopy: (text: string) => void;
  onMark: () => void;
}) {
  const land = detail.land;
  const unit = detail.unit;
  const title = land?.label ?? (unit ? `Unit ${unit.gmu}` : detail.pending ? "This spot" : "Likely private");
  const species = unit?.species.split(/,\s*/).map((name) => name.trim()).filter(Boolean) ?? [];
  const shootStart = weather ? formatClock(shiftLocalIso(weather.sunrise, -AZ_SHOOT_LEAD_MIN)) : null;
  const shootEnd = weather ? formatClock(shiftLocalIso(weather.sunset, AZ_SHOOT_LEAD_MIN)) : null;
  const light = shootStart && shootEnd && shootStart !== "—" && shootEnd !== "—" ? `${shootStart}–${shootEnd}` : null;
  const wind = weather
    ? `${cardinal(weather.windFrom)} ${imperial ? `${Math.round(mpsToMph(weather.windMps))} mph` : `${weather.windMps.toFixed(1)} m/s`}${
        weather.gustMps > weather.windMps + 1.5
          ? `, gusts ${imperial ? `${Math.round(mpsToMph(weather.gustMps))}` : weather.gustMps.toFixed(0)}`
          : ""
      }`
    : null;
  const temp = weather ? `${Math.round(imperial ? cToF(weather.tempC) : weather.tempC)}° ${weatherLabel(weather.code)}` : null;
  const pressure = weather?.pressureHpa == null ? null : `${formatPressure(weather.pressureHpa, imperial)}${weather.pressureTrend ? ` · ${weather.pressureTrend}` : ""}`;
  const slope =
    weather?.slopePct == null ? null : `${Math.round(weather.slopePct)}%${weather.fallsDeg != null ? ` falls ${cardinal(weather.fallsDeg)}` : ""}`;
  const copyBlock = [formatPair(detail.lng, detail.lat), formatDms(detail.lng, detail.lat), formatUtm(detail.lng, detail.lat)].join("\n");
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden text-left">
      <div className="flex shrink-0 items-start gap-2 px-3 pt-2.5">
        <span className="mt-1 size-3 shrink-0 rounded-sm border border-line" style={{ background: land?.swatch ?? "transparent" }} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-tight">{title}</h2>
          {unit ? (
            <p className="mt-0.5 text-sm text-muted">
              Unit {unit.gmu}
              {unit.regionName ? ` · ${unit.regionName}` : ""}
              {unit.sqMiles != null ? ` · ${Math.round(unit.sqMiles).toLocaleString("en-US")} sq mi` : ""}
            </p>
          ) : null}
        </div>
        <button type="button" aria-label="Close spot info" className="grid size-8 shrink-0 place-items-center text-muted" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 pt-2 pb-1 text-sm text-muted">
        {detail.pending && !land ? <p>Checking the surface…</p> : null}
        {land?.note ? <p>{land.note}</p> : null}
        {land?.unit ? <p className="mt-1">{land.unit}</p> : null}
        {unit?.forest ? <p className="mt-1">{unit.forest}</p> : null}
        {unit?.land && unit.land !== unit.forest && unit.land !== land?.label ? <p className="mt-1">{unit.land}</p> : null}
        {species.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {species.map((name) => (
              <span key={name} className="rounded-md bg-bg px-1.5 py-0.5 text-xs text-fg">
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
          <SpotFact label="Elevation" value={weather?.elevationM != null ? formatElev(weather.elevationM, imperial) : null} />
          <SpotFact label="Slope" value={slope} />
          <SpotFact label="Air" value={temp} />
          <SpotFact label="Pressure" value={pressure} />
          <SpotFact label="Wind" value={wind} wide />
          <SpotFact label="Shooting light" value={light} wide />
        </div>
        {!weather ? <p className="mt-2 text-xs text-subtle">Reading elevation and weather…</p> : null}
        <p className="mt-2 font-mono text-xs leading-relaxed text-subtle tabular-nums">
          {formatPair(detail.lng, detail.lat)}
          <span className="mt-0.5 block">{formatDms(detail.lng, detail.lat)}</span>
          <span className="mt-0.5 block">{formatUtm(detail.lng, detail.lat)}</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5 border-t border-line px-3 py-2.5">
        <button type="button" className="h-9 flex-1 rounded-md bg-accent text-sm font-medium text-accent-fg" onClick={onMark}>
          Mark
        </button>
        <button type="button" className="h-9 flex-1 rounded-md border border-line text-sm" onClick={() => onCopy(copyBlock)}>
          Copy
        </button>
      </div>
    </article>
  );
}

function SpotFact({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  if (!value) return null;
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <p className="text-[10px] tracking-wide text-subtle uppercase">{label}</p>
      <p className="text-sm text-fg">{value}</p>
    </div>
  );
}

function EditMark({
  name,
  kind,
  hunt,
  notes,
  goodWinds,
  hunts,
  lng,
  lat,
  away,
  onChange,
  onCopy,
  onDelete,
}: {
  name: string;
  kind: MarkKind;
  hunt: string;
  notes: string;
  goodWinds: number[];
  hunts: string[];
  lng: number;
  lat: number;
  away: string | null;
  onChange: (patch: Partial<{ name: string; kind: MarkKind; hunt: string; notes: string; goodWinds: number[] }>) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm text-muted">
        Name
        <input className="field mt-1" value={name} maxLength={60} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      <div className="grid grid-cols-3 gap-1.5">
        {MARK_ORDER.map((item) => {
          const meta = MARKS[item];
          const Icon = meta.icon;
          return (
            <button
              key={item}
              type="button"
              data-on={kind === item}
              onClick={() => onChange({ kind: item })}
              className="flex h-11 items-center justify-center gap-1.5 rounded-md border border-transparent bg-bg text-sm text-muted data-[on=true]:border-line data-[on=true]:text-fg"
            >
              <Icon className="size-4" />
              {meta.label}
            </button>
          );
        })}
      </div>
      <label className="text-sm text-muted">
        Hunt
        <input className="field mt-1" value={hunt} maxLength={40} list="hunt-names" placeholder="Unit or camp name" onChange={(event) => onChange({ hunt: event.target.value })} />
        <datalist id="hunt-names">
          {hunts.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </label>
      <div className="text-sm text-muted">
        Good wind from
        <div className="mt-1 grid grid-cols-4 gap-1">
          {WIND_CHOICES.map((choice) => {
            const on = goodWinds.includes(choice.deg);
            return (
              <button
                key={choice.deg}
                type="button"
                data-on={on}
                onClick={() =>
                  onChange({
                    goodWinds: on ? goodWinds.filter((deg) => deg !== choice.deg) : [...goodWinds, choice.deg].sort((a, b) => a - b),
                  })
                }
                className="h-10 rounded-md bg-bg text-sm text-muted data-[on=true]:bg-field data-[on=true]:text-accent-fg"
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="text-sm text-muted">
        Notes
        <textarea className="field mt-1" rows={3} maxLength={500} value={notes} onChange={(event) => onChange({ notes: event.target.value })} />
      </label>
      <p className="font-mono text-xs text-muted tabular-nums">
        {formatDd(lng, lat)}
        {away ? ` · ${away} from you` : ""}
      </p>
      <div className="flex gap-2">
        <button type="button" className="h-11 flex-1 rounded-md border border-line text-sm" onClick={onCopy}>
          Copy
        </button>
        {confirm ? (
          <button type="button" className="h-11 flex-1 rounded-md bg-danger text-sm text-fg" onClick={onDelete}>
            Confirm delete
          </button>
        ) : (
          <button type="button" className="h-11 flex-1 rounded-md border border-line text-sm text-danger" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
