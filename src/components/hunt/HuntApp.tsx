import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
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
  Settings,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { Toggle } from "@/components/hunt/controls";
import { MapCanvas, type GpsFix, type MapHandle } from "@/components/hunt/MapCanvas";
import { MARK_ORDER, MARKS } from "@/components/hunt/marks";
import { PRESETS, type AppSettings, type CoordinateFormat, type DistanceUnit, type SettingKey } from "@/features/settings/schema";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { hydrateSettings, useSettings } from "@/features/settings/store";
import {
  bearingDeg,
  cardinal,
  formatArea,
  formatClock,
  formatDd,
  formatDistance,
  formatDms,
  formatDuration,
  formatElev,
  formatInstant,
  formatPair,
  formatPercent,
  formatPressure,
  formatSpeed,
  formatTemp,
  formatWind,
  haversine,
  pathLength,
  personalWindow,
  ringArea,
  speedValue,
  WIND_CHOICES,
  windFits,
} from "@/lib/hunt/format";
import { toGpx } from "@/lib/hunt/gpx";
import { readTrailFile, trackKey, waypointKey } from "@/lib/hunt/transfer";
import { identifyLand, landTag, LEGEND } from "@/lib/hunt/land";
import { searchPlaces, type PlaceHit } from "@/lib/hunt/search.functions";
import { getHuntStorageWarning, useHunt } from "@/lib/hunt/store";
import { packTiles, purgeRestrictedTiles, TILES, tileCacheLabel } from "@/lib/hunt/tiles";
import { DEFAULT_VIEW, JUMPS, NATIONAL_VIEW, type Basemap, type LandHit, type LngLat, type MapView, type MarkKind, type Track, type TrackPoint, type Waypoint } from "@/lib/hunt/types";
import { loadFieldWeather } from "@/lib/hunt/weather.functions";
import type { DayOutlook, FieldWeather, WindHour } from "@/lib/hunt/weather";
import { weatherLabel } from "@/lib/hunt/weather";
import { UNIT_ADAPTERS, unitAdapterById } from "@/features/catalog/adapters";
import { coverageFor, jurisdictionsAt, jurisdictionsInBounds, layerStatus } from "@/features/catalog/coverage";
import { providersAt } from "@/features/catalog/discovery";
import { searchUnits } from "@/features/catalog/search";
import type { Bounds, HuntUnit, JurisdictionCoverage, UnitHit } from "@/features/catalog/types";
import { hitsTag, unitLabels as toUnitLabels, unitsAt, unitShapes } from "@/features/catalog/units-view";
import { deleteLegacyUnitCaches, useHuntUnits, type ProviderLoad } from "@/features/catalog/use-hunt-units";
import { normalizeBounds } from "@/lib/geo/bounds";
import { formatUtm, localDate, localMinutes, sunPosition } from "@/lib/hunt/sun";
import { noiseWord, rmsDb } from "@/lib/hunt/noise";

type Tool = "none" | "drop" | "measure";
type Sheet = null | "layers" | "saved" | "wind" | "edit" | "settings";
type Units = Pick<AppSettings, "distanceUnit" | "elevationUnit" | "areaUnit" | "speedUnit" | "temperatureUnit" | "pressureUnit">;

const NEXT_FORMAT: Record<CoordinateFormat, CoordinateFormat> = { dd: "dms", dms: "utm", utm: "dd" };

/** State agencies to check at a point (legal hours, regulations). Near borders there can be two. */
function agenciesAt(lng: number, lat: number): { name: string; url: string }[] {
  return jurisdictionsAt({ lng, lat })
    .filter((place): place is JurisdictionCoverage & { agencyName: string; agencyUrl: string } => Boolean(place.agencyName && place.agencyUrl))
    .slice(0, 2)
    .map((place) => ({ name: place.agencyName, url: place.agencyUrl }));
}

/** States with a hunt-unit source in Fieldline, e.g. "Arizona, Idaho, and Montana". */
function unitStatesText(): string {
  const names = UNIT_ADAPTERS.flatMap((adapter) => adapter.info.jurisdictionIds)
    .map((id) => coverageFor(id)?.name ?? id.slice(3).toUpperCase())
    .filter((name, index, all) => all.indexOf(name) === index);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} and ${names[names.length - 1]}`;
}

function allUnits(system: DistanceUnit): Units {
  const imperial = system === "imperial";
  return {
    distanceUnit: system,
    elevationUnit: imperial ? "ft" : "m",
    areaUnit: imperial ? "acres" : "hectares",
    speedUnit: imperial ? "mph" : "mps",
    temperatureUnit: imperial ? "F" : "C",
    pressureUnit: imperial ? "inHg" : "hPa",
  };
}
type LandState =
  | { status: "loading"; lng: number; lat: number }
  | { status: "ready"; lng: number; lat: number; hit: LandHit }
  | { status: "error"; lng: number; lat: number };

type Spot = { lng: number; lat: number; x: number; y: number };
/** `units` holds every overlapping hunt unit; `unitsPending` while providers are still answering. */
type Detail = Spot & { units: UnitHit[]; unitsPending: boolean; land: LandHit | null; pending: boolean };

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "hybrid", label: "Hybrid" },
  { id: "satellite", label: "Satellite" },
  { id: "usgs", label: "USGS" },
  { id: "topo", label: "Topo" },
  { id: "street", label: "Street" },
];

/** Esri imagery base maps: viewable live, never stored on the device. */
const LIVE_ONLY_BASEMAPS: Basemap[] = ["hybrid", "satellite"];

export function HuntApp() {
  const store = useHunt();
  const settings = useSettings((state) => state.effective);
  const setSetting = useSettings((state) => state.set);
  const activePreset = useSettings((state) => state.preset);
  const bind = <K extends SettingKey>(key: K) => (value: AppSettings[K]) => setSetting(key, value);
  const mapRef = useRef<MapHandle>(null);
  const initialViewRef = useRef<MapView>(DEFAULT_VIEW);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);
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
  const detailAbort = useRef<AbortController | null>(null);
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const huntUnitsRef = useRef<HuntUnit[]>([]);
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
  const [spotUnits, setSpotUnits] = useState<UnitHit[]>([]);
  const [pinned, setPinned] = useState<Spot | null>(null);
  const [hover, setHover] = useState<Spot | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [installDismissed, setInstallDismissed] = useState<boolean | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [listening, setListening] = useState(false);
  const [finePointer, setFinePointer] = useState(false);
  const [viewBounds, setViewBounds] = useState<Bounds | null>(null);
  const [weather, setWeather] = useState<FieldWeather | null>(null);
  const [weatherAt, setWeatherAt] = useState<{ lng: number; lat: number } | null>(null);
  const [weatherRefresh, setWeatherRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropHot, setDropHot] = useState(false);
  const [packNote, setPackNote] = useState<string | null>(null);
  const [packing, setPacking] = useState(false);
  const [screenAwake, setScreenAwake] = useState(false);
  const [systemReduce, setSystemReduce] = useState(false);
  const coordMode = settings.coordinateFormat;
  const unitPrefs: Units = settings;
  const reduceMotion = settings.motion === "reduce" || (settings.motion === "system" && systemReduce);

  const selected = store.waypoints.find((waypoint) => waypoint.id === selectedId) ?? null;
  const { units: huntUnits, inView: unitProviders } = useHuntUnits(viewBounds, hydrated && settings.showUnits, searchOpen);
  huntUnitsRef.current = huntUnits;
  pinnedRef.current = pinned;
  // The forecast reports the point's IANA zone; until it arrives, use the device's zone.
  const clockZone = weather?.source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

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
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setSystemReduce(media.matches);
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
        try {
          hydrateSettings();
        } catch {
          /* settings keep their defaults; the store reports why */
        }
        const prefs = useSettings.getState().effective;
        const saved =
          prefs.startupView === "national"
            ? NATIONAL_VIEW
            : prefs.startupView === "home" && prefs.homeView
              ? prefs.homeView
              : useHunt.getState().lastView;
        if (saved) {
          initialViewRef.current = saved;
          setView(saved);
        }
        setHydrated(true);
        const warning = getHuntStorageWarning() ?? useSettings.getState().warning;
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
    const lock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void>; addEventListener: (name: "release", fn: () => void) => void }> } }).wakeLock;
    if (!recording || !settings.keepAwake || !lock) return;
    let live = true;
    let requesting = false;
    const acquire = () => {
      if (!live || requesting || document.visibilityState !== "visible" || wakeRef.current) return;
      requesting = true;
      void lock
        .request("screen")
        .then((sentinel) => {
          if (!live) {
            void sentinel.release();
            return;
          }
          wakeRef.current = sentinel;
          setScreenAwake(true);
          sentinel.addEventListener("release", () => {
            // A late release from an older lock must not clear a newer one.
            if (wakeRef.current !== sentinel) return;
            wakeRef.current = null;
            setScreenAwake(false);
          });
        })
        .catch(() => setScreenAwake(false))
        .finally(() => {
          requesting = false;
        });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", acquire);
      void wakeRef.current?.release();
      wakeRef.current = null;
      setScreenAwake(false);
    };
  }, [recording, settings.keepAwake]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => useHunt.getState().setLastView(view), 700);
    return () => window.clearTimeout(timer);
  }, [view, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    // Older builds stored Esri imagery tiles; remove them before reporting what's saved.
    void purgeRestrictedTiles()
      .then(() => tileCacheLabel())
      .then((label) => {
        if (label) setPackNote(label);
      });
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    // Unit caches from the Arizona/Idaho-only builds are replaced by the catalog's own store.
    void deleteLegacyUnitCaches();
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    // Which providers apply depends on what's on screen, across state lines, never on a state mode.
    const timer = window.setTimeout(() => {
      const bounds = mapRef.current?.getBounds();
      const next = bounds ? normalizeBounds(bounds) : null;
      if (next) setViewBounds(next);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [view, hydrated]);

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
    const point = hover ?? pinned;
    if (!point || huntUnits.length === 0) return;
    syncUnit(point.lng, point.lat);
  }, [huntUnits, hover, pinned]);

  const unitsGeo = useMemo(() => unitShapes(huntUnits), [huntUnits]);
  const unitLabels = useMemo(() => toUnitLabels(huntUnits), [huntUnits]);
  const unitMatches = useMemo(
    () => (query.trim() ? searchUnits(huntUnits, query, { near: { lng: view.lng, lat: view.lat } }).slice(0, 5) : []),
    // Distance ranking uses the view at the time of typing; it needn't re-rank on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [huntUnits, query],
  );

  const probe = hover ?? pinned;
  const readLng = probe?.lng ?? view.lng;
  const readLat = probe?.lat ?? view.lat;
  const weatherPoint =
    settings.weatherLocation === "selected" && selected
      ? { lng: selected.lng, lat: selected.lat, where: selected.name || "selected mark" }
      : settings.weatherLocation === "pointer" && probe
        ? { lng: probe.lng, lat: probe.lat, where: hover ? "the pointer" : "the pinned spot" }
        : { lng: view.lng, lat: view.lat, where: "the map center" };
  const weatherKey = `${weatherPoint.lat.toFixed(2)},${weatherPoint.lng.toFixed(2)}`;
  const landNear = land && probe && Math.abs(land.lng - probe.lng) < 0.003 && Math.abs(land.lat - probe.lat) < 0.003 ? land : null;
  const landHit = landNear?.status === "ready" ? landNear.hit : null;
  const landDown = landNear?.status === "error";

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
        setSpotUnits([]);
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
          const field = useSettings.getState().effective;
          // A poor fix still moves the location dot, but never becomes part of the recorded path.
          const usable = next.accuracy <= field.gpsMaxAccuracyM;
          // While waiting to start, poor fixes are skipped; the waiting pill shows their accuracy.
          if (recordPendingRef.current && usable) {
            recordPendingRef.current = false;
            setRecordPending(false);
            recRef.current = true;
            lastRecRef.current = next;
            const start = Date.now();
            const points = [{ lng: next.lng, lat: next.lat, t: start }];
            recPtsRef.current = points;
            setRecPts(points);
            setRecStart(start);
            setRecording(true);
            setSheet(null);
            setNotice("Track recording started.");
          } else if (recRef.current && usable) {
            const prev = lastRecRef.current;
            if (!prev || haversine(prev, next) >= field.gpsMinMoveM) {
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
    setSpotUnits([]);
  }

  /** Hover/pin readout from units already loaded; no network request per pointer move. */
  function syncUnit(lng: number, lat: number) {
    const next = unitsAt(huntUnitsRef.current, { lng, lat });
    const key = next.map((hit) => hit.unit.id).join("|");
    setSpotUnits((prev) => (prev.map((hit) => hit.unit.id).join("|") === key ? prev : next));
  }

  /**
   * Authoritative unit answer for an inspected point: asks every provider whose
   * coverage includes it (across state lines) and lists every overlapping unit.
   */
  function inspectUnits(lng: number, lat: number, signal: AbortSignal) {
    const providers = providersAt({ lng, lat }, UNIT_ADAPTERS.map((adapter) => adapter.info), "hunt-units");
    if (providers.length === 0) {
      setDetail((current) => (current && current.lng === lng && current.lat === lat ? { ...current, unitsPending: false } : current));
      return;
    }
    const answers = new Map<string, UnitHit[]>();
    let remaining = providers.length;
    for (const info of providers) {
      void unitAdapterById(info.id)
        ?.identify({ lng, lat }, signal)
        .then((result) => {
          answers.set(info.id, result.hits);
        })
        .catch(() => undefined)
        .finally(() => {
          remaining -= 1;
          if (signal.aborted) return;
          setDetail((current) => {
            if (!current || current.lng !== lng || current.lat !== lat) return current;
            // Providers that answered replace their local guesses; others keep the local copy.
            const kept = current.units.filter((hit) => !answers.has(hit.unit.providerId));
            return { ...current, units: [...kept, ...[...answers.values()].flat()], unitsPending: remaining > 0 };
          });
        });
    }
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
      setSpotUnits([]);
      setLand(null);
      landKey.current = "";
      return;
    }
    syncUnit(pin.lng, pin.lat);
    queueLand(pin.lng, pin.lat, true);
  }

  function openDetail(lng: number, lat: number, x: number, y: number) {
    if (sheet) return;
    setDetail({ lng, lat, x, y, units: unitsAt(huntUnitsRef.current, { lng, lat }), unitsPending: true, land: null, pending: true });
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
    inspectUnits(lng, lat, controller.signal);
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
      { lng: unit.bounds.west, lat: unit.bounds.south },
      { lng: unit.bounds.east, lat: unit.bounds.north },
    ]);
    setSearchOpen(false);
    setQuery("");
    setHits([]);
  }

  async function saveArea() {
    const bounds = mapRef.current?.getBounds();
    if (!bounds || packing) return;
    const templates: string[] = [];
    // Esri imagery can't be stored, so imagery views save USGS imagery instead.
    const swapped = LIVE_ONLY_BASEMAPS.includes(settings.basemap);
    if (settings.basemap === "topo") templates.push(TILES.topo);
    else if (settings.basemap !== "street") templates.push(TILES.imagery);
    if (settings.showPublic) templates.push(TILES.sma);
    if (templates.length === 0) {
      setPackNote("Street roads and labels are streamed live. Switch to USGS imagery or Topo to save a base map.");
      return;
    }
    const swapNote = swapped ? " Esri imagery can't be stored, so USGS imagery was saved instead; switch the base map to USGS when you're offline." : "";
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
        setPackNote(`${parts.join(", ")}. One zoom level only; roads, labels, weather, and search still need a connection.${swapNote}`);
        void tileCacheLabel().then((label) => {
          if (label) setPackNote(`${parts.join(", ")}. ${label}. Roads, labels, weather, and search still need a connection.${swapNote}`);
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

  const windSpeed = weather ? formatSpeed(weather.windMps, unitPrefs.speedUnit) : null;
  const tempLabel = weather ? formatTemp(weather.tempC, unitPrefs.temperatureUnit) : null;
  const feelsLabel = weather ? formatTemp(weather.apparentC, unitPrefs.temperatureUnit) : null;
  const highLabel = weather ? formatTemp(weather.highC, unitPrefs.temperatureUnit) : null;
  const lowLabel = weather ? formatTemp(weather.lowC, unitPrefs.temperatureUnit) : null;
  const skyLabel = weather ? weatherLabel(weather.code, true) : null;
  const lightWindow =
    weather && settings.daylightWindow ? personalWindow(weather.sunrise, weather.sunset, settings.daylightBeforeMin, settings.daylightAfterMin) : null;
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
    if (!settings.showShade || shadeMin != null) return;
    const id = window.setInterval(() => setShadeNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [settings.showShade, shadeMin]);
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
      : `${formatPressure(weather.pressureHpa, unitPrefs.pressureUnit)}${weather.pressureTrend ? ` · ${weather.pressureTrend}` : ""}`;
  const near = (at: { lng: number; lat: number } | null, lng: number, lat: number) =>
    at != null && Math.abs(at.lat - lat) < 0.02 && Math.abs(at.lng - lng) < 0.02;
  const spotWeather = detail && weather && near(weatherAt, detail.lng, detail.lat) ? weather : null;
  // Only describe the coordinate readout with weather fetched for that same point.
  const readoutWeather = weather && near(weatherAt, readLng, readLat) ? weather : null;
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
                <WindArrow deg={weather?.windFrom ?? null} />
                <span className="font-mono tabular-nums">{weather ? formatWind(weather.windFrom, weather.windMps, unitPrefs.speedUnit) : "Wind"}</span>
              </span>
              <span className="text-muted">{[tempLabel, skyLabel].filter(Boolean).join(" · ")}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSheet("settings");
                setSearchOpen(false);
              }}
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-surface text-sm"
            >
              <Settings className="size-4" /> Settings
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
              units={unitPrefs}
              onOpen={(id, lng, lat) => {
                setSelectedId(id);
                setSheet("edit");
                mapRef.current?.easeTo(lng, lat, 15);
              }}
            />
            <h2 className="mt-4 font-display text-xl tracking-wide">Tracks</h2>
            <TrackRows tracks={store.tracks} units={unitPrefs} onFit={(points) => mapRef.current?.fit(points)} onToggle={store.toggleTrack} onDelete={store.removeTrack} />
          </div>
        </aside>
      ) : null}
      <div ref={mapWrapRef} className="absolute inset-0 lg:left-96">
      <MapCanvas
        ref={mapRef}
        hydrated={hydrated}
        basemap={settings.basemap}
        showPublic={settings.showPublic}
        publicOpacity={settings.publicOpacity}
        showLabels={settings.showLabels}
        showRoads={settings.showRoads}
        showTracks={settings.showTracks}
        showCreeks={settings.showCreeks}
        showPeaks={settings.showPeaks}
        showUnitLabels={settings.showUnitLabels}
        showBorder={settings.showBorder}
        boundaryStrength={settings.boundaryStrength}
        labelDensity={settings.labelDensity}
        terrain={settings.terrain}
        terrainExaggeration={settings.terrainExaggeration}
        distanceUnit={unitPrefs.distanceUnit}
        elevationUnit={unitPrefs.elevationUnit}
        reduceMotion={reduceMotion}
        initialView={initialViewRef.current}
        showMarks={settings.showMarks}
        waypoints={store.waypoints}
        selectedId={selectedId}
        tracks={store.tracks}
        livePoints={recPts}
        measurePoints={measurePts}
        measureClosed={measureClosed}
        gps={gps}
        tool={tool}
        showShade={settings.showShade}
        showSun={settings.showSun}
        showRings={settings.showRings}
        showUnits={settings.showUnits}
        unitsGeo={unitsGeo}
        unitLabels={unitLabels}
        windFrom={weather?.windFrom ?? null}
        sunLng={selected?.lng ?? null}
        sunLat={selected?.lat ?? null}
        riseAz={sunAz.rise}
        setAz={sunAz.set}
        liveAz={settings.showSun ? liveAz : null}
        shadeAz={settings.showShade && settings.basemap !== "topo" ? shadeSun.azimuth : null}
        shadeEl={settings.showShade && settings.basemap !== "topo" ? shadeSun.elevation : null}
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
          style={placeDetail(detail, mapWrapRef.current, settings.showShade && settings.basemap !== "topo" ? 1.7 : 0)}
        >
          <SpotInfo
            detail={detail}
            weather={spotWeather}
            units={unitPrefs}
            daylight={settings}
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
              if (unitMatches[0]) {
                goToUnit(unitMatches[0].unit);
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
              placeholder="Search a unit (az 22), town, or ridge"
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
                {unitMatches.map((match) => (
                  <button
                    key={match.unit.id}
                    type="button"
                    className="flex min-h-11 w-full flex-col items-start justify-center px-3 text-left hover:bg-surface-2"
                    onClick={() => goToUnit(match.unit)}
                  >
                    <span>{match.label}</span>
                    <span className="text-sm text-muted">
                      {[match.unit.regionName, match.unit.seasonContext, match.unit.forest].filter(Boolean).join(" · ") || "Hunt unit"}
                    </span>
                  </button>
                ))}
                {query.trim().length < 2 ? (
                  <div className="p-2">
                    <p className="px-2 py-1 text-xs tracking-wide text-subtle uppercase">Jump</p>
                    {JUMPS.map((place) => (
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
          <button
            type="button"
            onClick={() => {
              setSheet(sheet === "wind" ? null : "wind");
              setSearchOpen(false);
            }}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-fg lg:hidden"
            aria-label="Weather"
          >
            {weather?.code != null ? <WeatherMark code={weather.code} /> : <WindArrow deg={weather?.windFrom ?? null} />}
            {tempLabel ? <span className="font-mono tabular-nums">{tempLabel}</span> : null}
            <span className="font-mono text-muted tabular-nums">{windSpeed ?? "Wind"}</span>
          </button>
          </div>
        </div>

        <div className="pointer-events-auto flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => setSetting("coordinateFormat", NEXT_FORMAT[coordMode])}
            aria-label="Coordinates. Tap to change format."
            className="min-w-0 rounded-md bg-surface/95 px-2.5 py-1.5 text-left font-mono text-xs leading-relaxed text-fg tabular-nums"
          >
            <span className="block truncate">
              {coordMode === "dd" ? formatDd(readLng, readLat) : coordMode === "dms" ? formatDms(readLng, readLat) : formatUtm(readLng, readLat)}
            </span>
            <span className="mt-0.5 block max-w-[18rem] truncate text-muted">
              {probe && spotUnits.length > 0 ? `${hitsTag(spotUnits)} · ` : ""}
              {landHit ? `${landTag(landHit)} · ` : landDown ? "Land unavailable · " : ""}
              {readoutWeather && lightWindow ? `Your window ${lightWindow} · ` : ""}
              {readoutWeather?.elevationM != null ? `${formatElev(readoutWeather.elevationM, unitPrefs.elevationUnit)} elev` : "Elev —"}
              {readoutWeather?.slopePct != null
                ? ` · ${Math.round(readoutWeather.slopePct)}%${readoutWeather.fallsDeg != null ? ` falls ${cardinal(readoutWeather.fallsDeg)}` : ""}`
                : ""}
              {readoutWeather && tempLabel ? ` · ${tempLabel}` : ""}
              {readoutWeather && skyLabel ? ` ${skyLabel}` : ""}
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
              aria-label="Settings"
              onClick={() => {
                setSheet("settings");
                setSearchOpen(false);
              }}
              className="grid size-11 place-items-center rounded-full border border-line bg-surface text-fg"
            >
              <Settings className="size-5" />
            </button>
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
          settings.showShade && settings.basemap !== "topo" && sheet === null
            ? "bottom-[max(7.25rem,calc(6.4rem+env(safe-area-inset-bottom)))]"
            : "bottom-[max(5.5rem,calc(4.5rem+env(safe-area-inset-bottom)))]"
        }`}
      >
        {notice ? <p role="status" aria-live="polite" className="pointer-events-auto max-w-sm rounded-lg bg-surface px-3 py-1.5 text-center text-sm text-fg">{notice}</p> : null}
        {gpsError ? <p role="alert" aria-live="assertive" className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-muted">{gpsError}</p> : null}
        {recordPending ? (
          <p role="status" aria-live="polite" className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-center text-sm text-muted">
            {gps && gps.accuracy > settings.gpsMaxAccuracyM
              ? `Waiting for a fix better than ${settings.gpsMaxAccuracyM} m (now ±${Math.round(gps.accuracy)} m). Change the limit in Settings.`
              : "Waiting for GPS before recording."}
          </p>
        ) : null}
        {listening ? <NoiseMeter /> : null}
        {recording ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <span className="size-2 rounded-full bg-danger" />
            <span className="font-mono tabular-nums">
              {formatDistance(pathLength(recPts), unitPrefs.distanceUnit)} · {formatDuration(now - (recStart ?? now))}
            </span>
            {screenAwake ? <span className="text-xs text-muted">Screen on</span> : null}
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
              {measurePts.length < 2 ? "Tap points" : formatDistance(measureLength, unitPrefs.distanceUnit)}
              {measureBearing != null ? ` · ${Math.round(measureBearing)}° ${cardinal(measureBearing)}` : ""}
              {measureClosed ? ` · ${formatArea(measureArea, unitPrefs.areaUnit)}` : ""}
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

      {settings.showShade && settings.basemap !== "topo" && sheet === null ? (
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
          {activePreset ? (
            <p className="mb-2 rounded-md bg-bg px-3 py-2 text-sm text-muted">
              {PRESETS[activePreset].label} preset is on. Changing a layer it controls edits the preset; turn presets off in Settings.
            </p>
          ) : null}
          <div className="grid grid-cols-5 gap-1 rounded-lg bg-bg p-2">
            {BASEMAPS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-on={settings.basemap === item.id}
                onClick={() => setSetting("basemap", item.id)}
                className="h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
              >
                {item.label}
              </button>
            ))}
          </div>
          <Toggle checked={settings.showPublic} onChange={bind("showPublic")} label="Public land" hint="BLM surface-management agencies. Blank ground has no agency record; that doesn't make it private or public." />
          <Toggle
            checked={settings.showUnits}
            onChange={bind("showUnits")}
            label="Hunt units"
            hint={`State agency unit lines where Fieldline has them (${unitStatesText()}). Reference lines, not legal boundaries.`}
          />
          <Toggle checked={settings.showBorder} onChange={bind("showBorder")} label="State lines" hint="State and national lines from OpenStreetMap. Reference lines, not legal boundaries." />
          <CoverageHere bounds={viewBounds} providers={unitProviders} />
          <Toggle checked={settings.showUnitLabels} onChange={bind("showUnitLabels")} label="Unit numbers" hint="They hide when you zoom out." />
          <Toggle checked={settings.showRoads} onChange={bind("showRoads")} label="Roads" hint="Freeways are orange, highways gold, local roads gray. Off on the topo scan." />
          <Toggle checked={settings.showTracks} onChange={bind("showTracks")} label="Forest tracks" hint="Tracks and trails, from closer zoom." />
          <Toggle checked={settings.showCreeks} onChange={bind("showCreeks")} label="Creeks" hint="Rivers and named creeks." />
          <Toggle checked={settings.showPeaks} onChange={bind("showPeaks")} label="Peaks" hint="Summit names and elevation." />
          <Toggle checked={settings.showLabels} onChange={bind("showLabels")} label="Towns" hint="Cities, towns, and small places. Off on the topo scan." />
          <Toggle checked={listening} onChange={setListening} label="Noise meter" hint="How much louder you are than the moment you turned it on. A phone mic is not a lab meter." />
          <button type="button" className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line text-sm" onClick={() => void addToPhone()}>
            <Download className="size-4" /> Add to home screen
          </button>
          {settings.showPublic ? (
            <label className="block pb-2 text-sm text-muted">
              Overlay strength
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.05}
                value={settings.publicOpacity}
                aria-label="Public land opacity"
                onChange={(event) => setSetting("publicOpacity", Number(event.target.value))}
              />
            </label>
          ) : null}
          <Toggle checked={settings.showShade} onChange={bind("showShade")} label="Sun shade" hint="Shaded faces follow the sun. Scrub the time bar to move through the day. Off on the topo scan." />
          <Toggle checked={settings.showSun} onChange={bind("showSun")} label="Sun lines" hint="From the selected mark. Pale is sunrise, amber is sunset, white is the sun at the time on the shade bar." />
          <Toggle checked={settings.showRings} onChange={bind("showRings")} label="Range rings" hint={unitPrefs.distanceUnit === "imperial" ? "100, 200, and 400 yards around the selected mark." : "100, 200, and 400 meters around the selected mark."} />
          <Toggle checked={settings.terrain} onChange={bind("terrain")} label="3D terrain" hint="Tilt the map. Heavier on a phone." />
          <Toggle checked={settings.showMarks} onChange={bind("showMarks")} label="My marks" />
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-2" role="radiogroup" aria-label="Units">
            {(["imperial", "metric"] as const).map((system) => (
              <button
                key={system}
                type="button"
                role="radio"
                aria-checked={unitPrefs.distanceUnit === system}
                data-on={unitPrefs.distanceUnit === system}
                onClick={() => {
                  const next = allUnits(system);
                  for (const key of Object.keys(next) as (keyof Units)[]) setSetting(key, next[key]);
                }}
                className="h-10 rounded-md text-sm text-muted data-[on=true]:bg-surface-2 data-[on=true]:text-fg"
              >
                {system === "imperial" ? "Yards / miles" : "Meters"}
              </button>
            ))}
          </div>
          <p className="pb-1 text-sm text-subtle">Sets every unit at once. Pick each unit separately in Settings.</p>
          <ul className="mt-4 grid grid-cols-2 gap-y-2">
            {LEGEND.map((item) => (
              <li key={item.label} className="flex items-center gap-2 text-sm text-muted">
                <span className="size-3 rounded-sm border border-line" style={{ background: item.swatch }} />
                {item.label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-subtle">Right-click a spot, or press and hold, for the unit, who manages the ground, and the weather there. Unit lines are state agency reference geometry, not legal descriptions. Owner names aren't included; parcel data availability varies by county. Fieldline shows the managing agency and wind for each stand. Satellite and Hybrid use Esri imagery, which is live only. Save this view offline stores one zoom level of USGS imagery or Topo plus public land; streets, labels, units, weather, and search remain online.</p>
          <button type="button" disabled={packing} onClick={() => void saveArea()} className="mt-3 h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-50">
            {packing ? "Saving tiles…" : "Save this view offline"}
          </button>
          {packNote ? <p className="mt-2 text-sm text-muted">{packNote}</p> : null}
        </Panel>
      ) : null}

      {sheet === "wind" && weather ? (
        <Panel title="Weather" onClose={() => setSheet(null)}>
          <p className="mb-3 text-sm text-muted">
            Forecast for {weatherPoint.where} · <span className="font-mono tabular-nums">{weatherAt ? formatPair(weatherAt.lng, weatherAt.lat) : formatPair(weatherPoint.lng, weatherPoint.lat)}</span>
          </p>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm text-muted">{weatherLabel(weather.code)}</p>
              <p className="font-display text-5xl leading-none tracking-wide">{tempLabel}</p>
              <p className="mt-2 text-muted">
                {highLabel} high · {lowLabel} low
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              {weather.code != null ? <WeatherMark code={weather.code} large /> : null}
              <span className="flex items-center gap-1.5 text-sm">
                <WindArrow deg={weather.windFrom} />
                <span className="font-mono tabular-nums">{formatWind(weather.windFrom, weather.windMps, unitPrefs.speedUnit)}</span>
              </span>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <Stat label="Wind" value={windSpeed ?? "—"} />
            <Stat label="Gusts" value={formatSpeed(weather.gustMps, unitPrefs.speedUnit)} />
            <Stat label="Feels" value={feelsLabel ?? "—"} />
            <Stat label="Humidity" value={formatPercent(weather.humidity)} />
            <Stat label={weather.source.cloudInferred ? "Clouds (est.)" : "Clouds"} value={formatPercent(weather.cloud)} />
            <Stat label="Rain this hour" value={formatPercent(weather.popHour)} />
            <Stat label="Rain today, peak" value={formatPercent(weather.popDayMax)} />
            <Stat label="Barometer" value={pressureLabel ?? "—"} />
            <Stat label="Moon" value={`${Math.round(weather.moonIllum * 100)}%`} />
            <Stat label="Phase" value={weather.moonName} />
            <Stat label="Sun rises" value={sunAz.rise == null ? "—" : `${Math.round(sunAz.rise)}° ${cardinal(sunAz.rise)}`} />
            <Stat label="Sun sets" value={sunAz.set == null ? "—" : `${Math.round(sunAz.set)}° ${cardinal(sunAz.set)}`} />
            <Stat label="Sunrise" value={formatClock(weather.sunrise)} />
            <Stat label="Sunset" value={formatClock(weather.sunset)} />
            {lightWindow ? <Stat label="Your light window" value={lightWindow} /> : null}
          </dl>
          <p className="mt-4 text-sm text-subtle">
            Sunrise and sunset are astronomy for this point, in its local time.{" "}
            {lightWindow
              ? `Your light window is ${settings.daylightBeforeMin} min before sunrise to ${settings.daylightAfterMin} min after sunset, a personal setting, not a legal rule. `
              : ""}
            Legal shooting hours depend on the state, species, season, and method; Fieldline doesn&apos;t hold verified rules.{" "}
            <AgencyLinks agencies={agenciesAt(weatherPoint.lng, weatherPoint.lat)} />
            Sun direction is for the selected mark. The barometer trend compares now with three hours ago.
          </p>
          <p className="mt-2 text-xs text-subtle">
            {weather.source.label}.{" "}
            {weather.source.currentKind === "model-now" ? "Now is a model estimate, not a station reading." : "Now is the first forecast hour, not a station reading."}
            {weather.source.cloudInferred ? " Clouds are inferred from forecast text." : ""}
            {weather.source.issuedAt != null ? ` Issued ${formatInstant(weather.source.issuedAt, weather.source.timeZone, true)}.` : ""} Fetched{" "}
            {formatInstant(weather.source.fetchedAt, null, true)} (this device&apos;s clock). Forecast hours and sun times are local to the forecast point
            {weather.source.timeZone ? ` (${weather.source.timeZone})` : ""}.
          </p>
          <DayStrip days={weather.days} today={weather.today} units={unitPrefs} />
          <HourStrip hours={weather.hours} units={unitPrefs} goodWinds={selected?.goodWinds} standName={selected?.name ?? null} />
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

      {sheet === "settings" ? (
        <Panel title="Settings" onClose={() => setSheet(null)}>
          <SettingsPanel currentView={view} onNotice={setNotice} />
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
            units={unitPrefs}
            onOpen={(id, lng, lat) => {
              setSelectedId(id);
              setSheet("edit");
              mapRef.current?.easeTo(lng, lat, 15);
            }}
          />
          <h3 className="mt-4 font-display text-xl tracking-wide">Tracks</h3>
          <TrackRows
            tracks={store.tracks}
            units={unitPrefs}
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
            away={gps ? `${formatDistance(haversine(gps, selected), unitPrefs.distanceUnit)} ${cardinal(bearingDeg(gps, selected))}` : null}
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
  units,
  onOpen,
}: {
  waypoints: Waypoint[];
  gps: GpsFix | null;
  units: Units;
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
        const away = gps ? formatDistance(haversine(gps, waypoint), units.distanceUnit) : null;
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
  units,
  onFit,
  onToggle,
  onDelete,
}: {
  tracks: Track[];
  units: Units;
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
            <span className="text-sm text-muted">{formatDistance(pathLength(track.points), units.distanceUnit)}</span>
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
  windFrom: number | null;
  onOpen: (id: string, lng: number, lat: number) => void;
}) {
  const marked = waypoints.filter((waypoint) => (waypoint.goodWinds?.length ?? 0) > 0);
  if (marked.length === 0) {
    return <p className="mt-4 text-sm text-muted">Open a stand and tick the winds you can hunt. Matching stands get a green ring.</p>;
  }
  if (windFrom == null) {
    return <p className="mt-4 text-sm text-muted">The wind direction is unknown right now, so stands can't be checked.</p>;
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

function WindArrow({ deg, large = false }: { deg: number | null; large?: boolean }) {
  if (deg == null) {
    return (
      <svg viewBox="0 0 24 24" className={large ? "size-16 text-muted" : "size-4 text-muted"} aria-hidden>
        <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2.5" />
      </svg>
    );
  }
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

function DayStrip({ days, today, units }: { days: DayOutlook[]; today: string | null; units: Units }) {
  if (days.length === 0) return null;
  return (
    <div className="mt-4 grid grid-cols-4 gap-2">
      {days.map((day) => (
        <div key={day.date} className="rounded-md bg-bg px-1 py-2 text-center">
          <p className="text-xs tracking-wide text-subtle uppercase">{day.date === today ? "Today" : weekday(day.date)}</p>
          <p className="mt-1 text-sm leading-tight">{weatherLabel(day.code, true)}</p>
          <p className="font-mono text-sm tabular-nums">
            {formatTemp(day.highC, units.temperatureUnit)}
            <span className="text-muted"> {formatTemp(day.lowC, units.temperatureUnit)}</span>
          </p>
          <p className="text-xs text-muted">{formatPercent(day.popMax)} peak rain</p>
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
  units,
  goodWinds,
  standName,
}: {
  hours: WindHour[];
  units: Units;
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
          return (
            <div
              key={hour.at}
              className={`min-w-16 shrink-0 rounded-md px-2 py-2 text-center ${ok === true ? "bg-field text-accent-fg" : ok === false ? "bg-danger/25 text-fg" : "bg-bg"}`}
            >
              <p className="font-mono text-xs tabular-nums">{formatClock(hour.time)}</p>
              <p className="text-sm">{hour.windFrom == null ? "—" : cardinal(hour.windFrom)}</p>
              <p className="font-mono text-xs tabular-nums">{speedValue(hour.windMps, units.speedUnit)}</p>
              {hour.pop != null && hour.pop >= 20 ? <p className="font-mono text-xs tabular-nums">{formatPercent(hour.pop)}</p> : null}
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
  units,
  daylight,
  onClose,
  onCopy,
  onMark,
}: {
  detail: Detail;
  weather: FieldWeather | null;
  units: Units;
  daylight: Pick<AppSettings, "daylightWindow" | "daylightBeforeMin" | "daylightAfterMin">;
  onClose: () => void;
  onCopy: (text: string) => void;
  onMark: () => void;
}) {
  const land = detail.land;
  const landDown = !land && !detail.pending;
  const title = land?.label ?? (detail.pending ? "This spot" : "Land record unavailable");
  const places = jurisdictionsAt({ lng: detail.lng, lat: detail.lat });
  const multiState = new Set(detail.units.map((hit) => hit.unit.jurisdictionId)).size > 1;
  const unitCoverage = places.map((place) => ({ place, status: layerStatus(place.id, "hunt-units") }));
  const light =
    weather && daylight.daylightWindow ? personalWindow(weather.sunrise, weather.sunset, daylight.daylightBeforeMin, daylight.daylightAfterMin) : null;
  const gusty = weather?.gustMps != null && weather.windMps != null && weather.gustMps > weather.windMps + 1.5;
  const wind = weather
    ? `${formatWind(weather.windFrom, weather.windMps, units.speedUnit)}${gusty ? `, gusts ${speedValue(weather.gustMps, units.speedUnit)}` : ""}`
    : null;
  const temp = weather ? `${formatTemp(weather.tempC, units.temperatureUnit)} ${weatherLabel(weather.code)}` : null;
  const pressure = weather?.pressureHpa == null ? null : `${formatPressure(weather.pressureHpa, units.pressureUnit)}${weather.pressureTrend ? ` · ${weather.pressureTrend}` : ""}`;
  const slope =
    weather?.slopePct == null ? null : `${Math.round(weather.slopePct)}%${weather.fallsDeg != null ? ` falls ${cardinal(weather.fallsDeg)}` : ""}`;
  const copyBlock = [formatPair(detail.lng, detail.lat), formatDms(detail.lng, detail.lat), formatUtm(detail.lng, detail.lat)].join("\n");
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden text-left">
      <div className="flex shrink-0 items-start gap-2 px-3 pt-2.5">
        <span className="mt-1 size-3 shrink-0 rounded-sm border border-line" style={{ background: land?.swatch ?? "transparent" }} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-tight">{title}</h2>
          {detail.units.map((hit) => (
            <p key={hit.unit.id} className="mt-0.5 text-sm text-muted">
              {hit.unit.label}
              {multiState ? ` · ${coverageFor(hit.unit.jurisdictionId)?.name ?? hit.unit.jurisdictionId}` : ""}
              {hit.unit.regionName ? ` · ${hit.unit.regionName}` : ""}
              {hit.unit.sqMiles != null ? ` · ${Math.round(hit.unit.sqMiles).toLocaleString("en-US")} sq mi` : ""}
            </p>
          ))}
        </div>
        <button type="button" aria-label="Close spot info" className="grid size-8 shrink-0 place-items-center text-muted" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 pt-2 pb-1 text-sm text-muted">
        {detail.pending && !land ? <p>Checking the surface…</p> : null}
        {landDown ? <p>The land service didn't answer, so ownership is unknown here. Try again with a connection.</p> : null}
        {land?.note ? <p>{land.note}</p> : null}
        {land?.unit ? <p className="mt-1">{land.unit}</p> : null}
        {land && land.others.length > 0 ? (
          <p className="mt-1">
            Also recorded here: {land.others.map((record) => [record.label, record.unit].filter(Boolean).join(" · ")).join("; ")}
          </p>
        ) : null}
        {land ? (
          <p className="mt-1 text-xs text-subtle">
            {land.source}, checked {new Date(land.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
        ) : null}
        {detail.units.map((hit) => (
          <div key={hit.unit.id} className="mt-1">
            {hit.unit.seasonContext ? <p>{hit.unit.seasonContext}</p> : null}
            {hit.unit.forest ? <p>{hit.unit.forest}</p> : null}
            {hit.unit.landNote && hit.unit.landNote !== hit.unit.forest && hit.unit.landNote !== land?.label ? <p>{hit.unit.landNote}</p> : null}
            {hit.unit.speciesTags.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {hit.unit.speciesTags.map((name) => (
                  <span key={name} className="rounded-md bg-bg px-1.5 py-0.5 text-xs text-fg">
                    {name}
                  </span>
                ))}
              </div>
            ) : null}
            <p className="mt-0.5 text-xs text-subtle">
              {unitAdapterById(hit.unit.providerId)?.info.caveat ?? ""}
              {hit.approximate ? " From the saved copy; edges may be simplified." : ""}
            </p>
          </div>
        ))}
        {detail.unitsPending && detail.units.length === 0 && unitCoverage.some(({ status }) => status.status === "available") ? (
          <p className="mt-1">Checking hunt units…</p>
        ) : null}
        {!detail.unitsPending && detail.units.length === 0
          ? unitCoverage.map(({ place, status }) => (
              <p key={place.id} className="mt-1 text-xs text-subtle">
                {status.status === "available" ? `No ${place.name} hunt unit found at this point.` : `${place.name}: ${status.note}`}
              </p>
            ))
          : null}
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
          <SpotFact label="Elevation" value={weather?.elevationM != null ? formatElev(weather.elevationM, units.elevationUnit) : null} />
          <SpotFact label="Slope" value={slope} />
          <SpotFact label="Air" value={temp} />
          <SpotFact label="Pressure" value={pressure} />
          <SpotFact label="Wind" value={wind} wide />
          <SpotFact label="Your light window (not legal hours)" value={light} wide />
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

function AgencyLinks({ agencies }: { agencies: { name: string; url: string }[] }) {
  if (agencies.length === 0) return <>Check the state wildlife agency. </>;
  return (
    <>
      Check{" "}
      {agencies.map((agency, index) => (
        <span key={agency.url}>
          {index > 0 ? " or " : ""}
          <a className="underline" href={agency.url} target="_blank" rel="noopener noreferrer">
            {agency.name}
          </a>
        </span>
      ))}
      .{" "}
    </>
  );
}

/** What Fieldline has for the states in view: honest per-layer status, including runtime load results. */
function CoverageHere({ bounds, providers }: { bounds: Bounds | null; providers: ProviderLoad[] }) {
  if (!bounds) return null;
  const places = jurisdictionsInBounds(bounds);
  if (places.length === 0) {
    return <p className="py-2 text-sm text-muted">No state coverage information for this view.</p>;
  }
  const shown = places.slice(0, 6);
  return (
    <section className="my-2 rounded-lg bg-bg px-3 py-2" aria-label="Coverage in view">
      <p className="text-xs tracking-wide text-subtle uppercase">Coverage in view</p>
      <ul className="mt-1 space-y-1.5">
        {shown.map((place) => {
          const load = providers.find((entry) => entry.info.jurisdictionIds.includes(place.id));
          const register = layerStatus(place.id, "hunt-units");
          const units = !load
            ? register.status === "available"
              ? "Hunt units: zoom in to load."
              : "Hunt units: not in Fieldline yet."
            : !load.result
              ? "Hunt units: loading…"
              : load.result.status === "available"
                ? `Hunt units: ${load.result.units.length} from ${load.info.title}.`
                : `Hunt units: ${load.result.message ?? load.result.status}`;
          return (
            <li key={place.id} className="text-sm">
              <span className="text-fg">{place.name}</span>
              <span className="block text-muted">{units}</span>
            </li>
          );
        })}
      </ul>
      {places.length > shown.length ? <p className="mt-1 text-xs text-subtle">and {places.length - shown.length} more states in view.</p> : null}
      <p className="mt-1 text-xs text-subtle">Public land colors cover every state. Parcel owners, access routes, and legal hours aren&apos;t in Fieldline yet.</p>
    </section>
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
