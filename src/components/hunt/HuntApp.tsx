import { useEffect, useRef, useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import {
  Bookmark,
  Compass,
  Crosshair,
  Download,
  Layers,
  LocateFixed,
  MapPinned,
  Ruler,
  Search,
  Upload,
  X,
} from "lucide-react";
import { MapCanvas, type GpsFix, type MapHandle } from "@/components/hunt/MapCanvas";
import { MARK_ORDER, MARKS } from "@/components/hunt/marks";
import {
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
  haversine,
  mpsToMph,
  pathLength,
  ringArea,
} from "@/lib/hunt/format";
import { parseGpx, toGpx } from "@/lib/hunt/gpx";
import { identifyLand } from "@/lib/hunt/land";
import { LEGEND } from "@/lib/hunt/land";
import { searchPlaces, type PlaceHit } from "@/lib/hunt/search.functions";
import { useHunt } from "@/lib/hunt/store";
import { DEFAULT_VIEW, JUMPS, type Basemap, type LandHit, type LngLat, type MapView, type MarkKind, type TrackPoint } from "@/lib/hunt/types";
import { fetchFieldWeather, type FieldWeather } from "@/lib/hunt/weather";

type Tool = "none" | "drop" | "measure";
type Sheet = null | "layers" | "saved" | "wind" | "edit";
type LandState =
  | { status: "loading"; lng: number; lat: number }
  | { status: "ready"; lng: number; lat: number; hit: LandHit }
  | { status: "error"; lng: number; lat: number };

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
  const lastRecRef = useRef<LngLat | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchReq = useRef(0);
  const landAbort = useRef<AbortController | null>(null);

  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [tool, setTool] = useState<Tool>("none");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measurePts, setMeasurePts] = useState<LngLat[]>([]);
  const [measureClosed, setMeasureClosed] = useState(false);
  const [gps, setGps] = useState<GpsFix | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recPts, setRecPts] = useState<TrackPoint[]>([]);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [land, setLand] = useState<LandState | null>(null);
  const [weather, setWeather] = useState<FieldWeather | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [coordMode, setCoordMode] = useState<"dd" | "dms">("dd");

  const selected = store.waypoints.find((waypoint) => waypoint.id === selectedId) ?? null;

  useEffect(() => {
    let live = true;
    void Promise.resolve(useHunt.persist.rehydrate()).then(() => {
      if (!live) return;
      const saved = useHunt.getState().lastView;
      if (saved) setView(saved);
      setHydrated(true);
    });
    return () => {
      live = false;
    };
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

  const weatherKey = `${view.lat.toFixed(2)},${view.lng.toFixed(2)}`;

  useEffect(() => {
    if (!hydrated) return;
    const [lat, lng] = weatherKey.split(",").map(Number);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchFieldWeather(lng, lat, controller.signal)
        .then(setWeather)
        .catch(() => {
          if (!controller.signal.aborted) setWeather(null);
        });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hydrated, weatherKey]);

  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
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
      void searchPlaces({ data: { q, lng: here.lng, lat: here.lat } })
        .then((rows) => {
          if (searchReq.current === id) setHits(rows);
        })
        .catch(() => {
          if (searchReq.current === id) setHits([]);
        })
        .finally(() => {
          if (searchReq.current === id) setSearching(false);
        });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (sheet) setSheet(null);
      else if (tool !== "none") setTool("none");
      else setLand(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, tool]);

  useEffect(() => {
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
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next: GpsFix = {
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
          heading: typeof pos.coords.heading === "number" && pos.coords.heading >= 0 ? pos.coords.heading : null,
        };
        setGps(next);
        setGpsError(null);
        if (followRef.current) mapRef.current?.easeTo(next.lng, next.lat);
        if (recRef.current) {
          const prev = lastRecRef.current;
          if (!prev || haversine(prev, next) >= 8) {
            lastRecRef.current = next;
            setRecPts((points) => [...points, { lng: next.lng, lat: next.lat, t: Date.now() }]);
          }
        }
      },
      (err) => setGpsError(err.code === 1 ? "Location permission denied." : "Couldn't get a GPS fix."),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );
  }

  function onLocate() {
    ensureWatch();
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
      createdAt: Date.now(),
    });
    setSelectedId(id);
    setSheet("edit");
    setTool("none");
    setLand(null);
  }

  function runIdentify(lng: number, lat: number) {
    landAbort.current?.abort();
    const controller = new AbortController();
    landAbort.current = controller;
    setLand({ status: "loading", lng, lat });
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

  function onMapClick(lng: number, lat: number) {
    if (tool === "drop") {
      dropAt(lng, lat);
      return;
    }
    if (tool === "measure") {
      if (measureClosed) return;
      setMeasurePts((points) => [...points, { lng, lat }]);
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
      const stamp = new Date();
      store.addTrack({
        id: crypto.randomUUID(),
        name: `Track ${stamp.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        points: recPts,
        createdAt: stamp.getTime(),
        visible: true,
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
    setRecPts(gps ? [{ lng: gps.lng, lat: gps.lat, t: Date.now() }] : []);
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

  function goTo(lng: number, lat: number, zoom = 12) {
    mapRef.current?.easeTo(lng, lat, zoom);
    setSearchOpen(false);
    setQuery("");
    setHits([]);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied coordinates.");
    } catch {
      setNotice("Couldn't copy from this browser.");
    }
  }

  function onImport(file: File) {
    void file
      .text()
      .then((text) => {
        const parsed = parseGpx(text);
        const nowStamp = Date.now();
        store.importAll(
          parsed.waypoints.map((waypoint) => ({ ...waypoint, id: crypto.randomUUID(), createdAt: nowStamp })),
          parsed.tracks.map((track) => ({ ...track, id: crypto.randomUUID(), createdAt: nowStamp, visible: true })),
        );
        setNotice(`Imported ${parsed.waypoints.length} marks and ${parsed.tracks.length} tracks.`);
      })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Import failed."));
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
  const measureLength = pathLength(measureClosed && measurePts.length > 2 ? [...measurePts, measurePts[0]] : measurePts);
  const measureArea = measureClosed ? ringArea(measurePts) : 0;
  const hunts = [...new Set(store.waypoints.map((waypoint) => waypoint.hunt).filter(Boolean))];
  const tilted = Math.abs(view.bearing) > 2 || view.pitch > 8;

  return (
    <main className="map-shell relative h-dvh w-full overflow-hidden bg-bg" data-sheet={sheet ? "1" : "0"}>
      <MapCanvas
        ref={mapRef}
        hydrated={hydrated}
        basemap={store.basemap}
        showPublic={store.showPublic}
        publicOpacity={store.publicOpacity}
        showLabels={store.showLabels}
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
        onMapClick={onMapClick}
        onMarkerClick={(id) => {
          setSelectedId(id);
          setSheet("edit");
          setTool("none");
        }}
        onView={setView}
        onDragStart={() => {
          followRef.current = false;
          setFollow(false);
        }}
      />

      {tool !== "none" ? <Reticle /> : null}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex flex-col gap-2">
          <p className="font-display text-lg leading-none tracking-widest text-fg sm:hidden">FIELDLINE</p>
          <div className="flex items-center gap-2">
            <p className="hidden font-display text-xl tracking-widest text-fg sm:block">FIELDLINE</p>
          <form
            className="relative min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const first = hits[0];
              if (first) goTo(first.lng, first.lat, 12);
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search town or country"
              aria-label="Search places"
              autoCapitalize="off"
              autoCorrect="off"
              className="field h-11 pr-10 pl-9"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-muted"
                onClick={() => {
                  setQuery("");
                  setHits([]);
                }}
              >
                <X className="size-4" />
              </button>
            ) : null}
            {searchOpen ? (
              <div className="absolute inset-x-0 top-12 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
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
                  <p className="px-3 py-3 text-sm text-muted">Searching…</p>
                ) : hits.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted">No matches.</p>
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
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-fg"
            aria-label="Wind and light"
          >
            <WindArrow deg={weather?.windFrom ?? 0} />
            <span className="font-mono tabular-nums">{windSpeed ?? "Wind"}</span>
          </button>
          </div>
        </div>

        <div className="pointer-events-auto flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => setCoordMode((mode) => (mode === "dd" ? "dms" : "dd"))}
            className="rounded-md bg-surface/95 px-2.5 py-1.5 text-left font-mono text-xs leading-relaxed text-fg tabular-nums"
          >
            {coordMode === "dd" ? formatDd(view.lng, view.lat) : formatDms(view.lng, view.lat)}
            <span className="mt-0.5 block text-muted">
              {weather?.elevationM != null ? `${formatElev(weather.elevationM, store.imperial)} elev` : "Elev —"}
              {tempLabel ? ` · ${tempLabel}` : ""}
            </span>
          </button>
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
        </div>

        {hydrated && !store.introDismissed ? (
          <div className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-muted">
            <p>
              Color is federal, state, or tribal surface from the BLM. Blank ground is usually private. Owner names are not in this free map.
            </p>
            <button type="button" aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center text-fg" onClick={store.dismissIntro}>
              <X className="size-4" />
            </button>
          </div>
        ) : null}
      </header>

      {searchOpen ? (
        <button type="button" aria-label="Close search" className="absolute inset-0 z-10 cursor-default" onClick={() => setSearchOpen(false)} />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-[max(5.5rem,calc(4.5rem+env(safe-area-inset-bottom)))] z-20 flex flex-col items-center gap-2 px-3">
        {notice ? <p className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-fg">{notice}</p> : null}
        {gpsError && follow ? <p className="pointer-events-auto rounded-full bg-surface px-3 py-1.5 text-sm text-muted">{gpsError}</p> : null}
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
        {land && tool === "none" && !sheet ? (
          <LandCard land={land} onClose={() => setLand(null)} onCopy={copyText} onMark={() => dropAt(land.lng, land.lat)} />
        ) : null}
      </div>

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
            <DockButton label={recording ? "Stop" : "Track"} on={recording} danger={recording} icon={MapPinned} onClick={toggleRecord} />
            <DockButton
              label="Layers"
              on={false}
              icon={Layers}
              onClick={() => {
                setSheet("layers");
                setSearchOpen(false);
              }}
            />
            <DockButton
              label="Saved"
              on={false}
              icon={Bookmark}
              onClick={() => {
                setSheet("saved");
                setSearchOpen(false);
              }}
            />
          </div>
        </nav>
      ) : null}

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
          <Toggle checked={store.showPublic} onChange={store.setShowPublic} label="Public land" hint="BLM surface management. Not a survey." />
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
          <Toggle checked={store.showLabels} onChange={store.setShowLabels} label="Place names" hint="Roads and labels on the hybrid map." />
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
          <p className="mt-3 text-sm text-subtle">Private land stays uncolored. This is not onX, and it is not legal advice. Confirm boundaries and seasons before you hunt.</p>
        </Panel>
      ) : null}

      {sheet === "wind" && weather ? (
        <Panel title="Wind" onClose={() => setSheet(null)}>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="font-display text-5xl leading-none tracking-wide">{cardinal(weather.windFrom)}</p>
              <p className="mt-2 text-muted">From {cardinal(weather.windFrom)}</p>
            </div>
            <WindArrow deg={weather.windFrom} large />
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <Stat label="Wind" value={windSpeed ?? "—"} />
            <Stat
              label="Gusts"
              value={store.imperial ? `${Math.round(mpsToMph(weather.gustMps))} mph` : `${weather.gustMps.toFixed(1)} m/s`}
            />
            <Stat label="Temp" value={tempLabel ?? "—"} />
            <Stat label="Scent drifts" value={cardinal(weather.windFrom + 180)} />
            <Stat label="Sunrise" value={formatClock(weather.sunrise)} />
            <Stat label="Sunset" value={formatClock(weather.sunset)} />
          </dl>
          <p className="mt-4 text-sm text-subtle">Legal shooting light is not the same as sunrise. Check your state wildlife agency. Wind is the Open-Meteo model at the map center, not a ridge-top reading.</p>
        </Panel>
      ) : null}
      {sheet === "wind" && !weather ? (
        <Panel title="Wind" onClose={() => setSheet(null)}>
          <p className="text-muted">Weather hasn't answered yet. Pan somewhere with a connection and try again.</p>
        </Panel>
      ) : null}

      {sheet === "saved" ? (
        <Panel title="Saved" onClose={() => setSheet(null)}>
          <div className="mb-3 flex gap-2">
            <button type="button" onClick={onExport} disabled={store.waypoints.length + store.tracks.length === 0} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm disabled:opacity-40">
              <Download className="size-4" /> Export GPX
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line text-sm">
              <Upload className="size-4" /> Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".gpx,application/gpx+xml,.xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onImport(file);
              }}
            />
          </div>
          <h3 className="font-display text-xl tracking-wide">Marks</h3>
          {store.waypoints.length === 0 ? (
            <p className="py-3 text-sm text-muted">No marks yet. Tap Mark, then tap the stand, gate, or camp.</p>
          ) : (
            <ul className="mt-1">
              {store.waypoints.map((waypoint) => {
                const meta = MARKS[waypoint.kind];
                const Icon = meta.icon;
                const away = gps ? formatDistance(haversine(gps, waypoint), store.imperial) : null;
                const heading = gps ? cardinal(bearingDeg(gps, waypoint)) : null;
                return (
                  <li key={waypoint.id}>
                    <button
                      type="button"
                      className="flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left hover:bg-surface-2"
                      onClick={() => {
                        setSelectedId(waypoint.id);
                        setSheet("edit");
                        mapRef.current?.easeTo(waypoint.lng, waypoint.lat, 15);
                      }}
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
          )}
          <h3 className="mt-4 font-display text-xl tracking-wide">Tracks</h3>
          {store.tracks.length === 0 ? (
            <p className="py-3 text-sm text-muted">No tracks yet. Tap Track and walk. Stop saves it here.</p>
          ) : (
            <ul className="mt-1">
              {store.tracks.map((track) => (
                <li key={track.id} className="flex min-h-12 items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => mapRef.current?.fit(track.points)}
                  >
                    <span className="block truncate">{track.name}</span>
                    <span className="text-sm text-muted">{formatDistance(pathLength(track.points), store.imperial)}</span>
                  </button>
                  <button type="button" className="h-9 px-2 text-sm text-muted" onClick={() => store.toggleTrack(track.id)}>
                    {track.visible ? "Hide" : "Show"}
                  </button>
                  <button type="button" className="h-9 px-2 text-sm text-danger" onClick={() => store.removeTrack(track.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-sm text-subtle">Marks and tracks stay on this phone or browser. Export GPX if you want a copy.</p>
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
    </main>
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
}: {
  label: string;
  on: boolean;
  danger?: boolean;
  icon: typeof LocateFixed;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-on={on}
      onClick={onClick}
      className={`flex min-w-12 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-xs ${
        on ? (danger ? "bg-danger text-fg" : "bg-accent text-accent-fg") : "text-muted"
      }`}
    >
      <Icon className="size-5" />
      {label}
    </button>
  );
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section role="dialog" aria-label={title} className="fixed inset-x-0 bottom-0 z-30 flex max-h-[min(78dvh,40rem)] flex-col rounded-t-xl border border-line bg-surface shadow-lg md:inset-y-4 md:left-4 md:w-96 md:rounded-xl">
      <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
        <h2 className="font-display text-2xl leading-none tracking-wide">{title}</h2>
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
      <dd className="font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function LandCard({
  land,
  onClose,
  onCopy,
  onMark,
}: {
  land: LandState;
  onClose: () => void;
  onCopy: (text: string) => void;
  onMark: () => void;
}) {
  const title = land.status === "ready" ? land.hit.label : land.status === "loading" ? "Checking this spot…" : "Land layer didn't answer";
  const place =
    land.status === "ready" ? [land.hit.unit, land.hit.state].filter(Boolean).join(" · ") : "";
  return (
    <article className="pointer-events-auto w-full max-w-md rounded-lg border border-line bg-surface p-3 text-left shadow-lg">
      <div className="flex items-start gap-3">
        <span
          className="mt-1 size-3 shrink-0 rounded-sm border border-line"
          style={{ background: land.status === "ready" ? (land.hit.swatch ?? "transparent") : "transparent" }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-tight">{title}</h2>
          {place ? <p className="mt-0.5 text-sm text-muted">{place}</p> : null}
          <p className="mt-1 font-mono text-xs text-subtle tabular-nums">{formatPair(land.lng, land.lat)}</p>
          {land.status === "ready" ? <p className="mt-2 text-sm text-muted">{land.hit.note}</p> : null}
        </div>
        <button type="button" aria-label="Close land card" className="grid size-8 place-items-center text-muted" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="h-10 flex-1 rounded-md bg-accent text-sm font-medium text-accent-fg" onClick={onMark}>
          Mark here
        </button>
        <button type="button" className="h-10 flex-1 rounded-md border border-line text-sm" onClick={() => onCopy(formatPair(land.lng, land.lat))}>
          Copy
        </button>
      </div>
    </article>
  );
}

function EditMark({
  name,
  kind,
  hunt,
  notes,
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
  hunts: string[];
  lng: number;
  lat: number;
  away: string | null;
  onChange: (patch: Partial<{ name: string; kind: MarkKind; hunt: string; notes: string }>) => void;
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
