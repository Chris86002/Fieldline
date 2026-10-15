import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Basemap } from "@/lib/hunt/types";
import { planPackage, type PackageBounds } from "@/lib/offline/plan";
import { SELECTABLE_LAYERS, type PackageLayerId } from "@/lib/offline/sources";
import type { PackageStatus } from "@/lib/offline/package-store";
import {
  checkPackage,
  deleteArea,
  discardUpdate,
  downloadArea,
  pauseDownload,
  refreshPackages,
  repairArea,
  resumePackage,
  updateArea,
  useOffline,
} from "./controller.ts";
import {
  areaSize,
  defaultLayers,
  defaultZooms,
  expiryText,
  formatBytes,
  formatCount,
  layerLabel,
  layerSummary,
  MAX_PACKAGE_ZOOM,
  MIN_PACKAGE_ZOOM,
  packageActions,
  stateLabel,
  unpackageableShown,
  type OfflineTaskName,
  type StateTone,
} from "./model.ts";

export type OfflineMapState = {
  basemap: Basemap;
  showPublic: boolean;
  showUnits: boolean;
  terrain: boolean;
  showShade: boolean;
};

const TONE: Record<StateTone, string> = {
  ok: "bg-accent text-accent-fg",
  busy: "bg-surface-2 text-fg",
  warn: "bg-surface-2 text-fg",
  error: "bg-surface-2 text-fg underline decoration-dotted",
  idle: "bg-bg text-muted",
};

const ZOOMS = Array.from({ length: MAX_PACKAGE_ZOOM - MIN_PACKAGE_ZOOM + 1 }, (_, i) => MIN_PACKAGE_ZOOM + i);

function defaultName(bounds: PackageBounds | null): string {
  if (!bounds) return "";
  const lat = (bounds.north + bounds.south) / 2;
  const lng = (bounds.west + bounds.east) / 2;
  return `Area at ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
}

/**
 * Offline maps: choose an area, layers and zooms with a size estimate and
 * what's left out, download with progress and pause, and manage downloaded
 * areas (check, repair, update, delete).
 */
export function OfflinePanel({
  getArea,
  viewZoom,
  map,
  metric,
  onPreview,
  onShow,
}: {
  /** The map's current view, or null before the map is ready. */
  getArea: () => PackageBounds | null;
  viewZoom: number;
  map: OfflineMapState;
  metric: boolean;
  /** The area being planned, drawn on the map; null clears it. */
  onPreview: (bounds: PackageBounds | null) => void;
  /** Fit the map to a downloaded area. */
  onShow: (bounds: PackageBounds) => void;
}) {
  const status = useOffline((s) => s.status);
  const reason = useOffline((s) => s.reason);
  const packages = useOffline((s) => s.packages);
  const bytes = useOffline((s) => s.bytes);
  const totalBytes = useOffline((s) => s.totalBytes);
  const busy = useOffline((s) => s.busy);
  const notice = useOffline((s) => s.notice);

  const [area, setArea] = useState<PackageBounds | null>(() => getArea());
  const [name, setName] = useState(() => defaultName(area));
  const [layers, setLayers] = useState<PackageLayerId[]>(() => defaultLayers(map));
  const [zooms, setZooms] = useState(() => defaultZooms(viewZoom));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const nameId = useId();

  useEffect(() => {
    onPreview(area);
    return () => onPreview(null);
  }, [area, onPreview]);

  // Re-read on open and on return to the app: expiry moves with time, and
  // another window may have finished or deleted an area.
  useEffect(() => {
    void refreshPackages();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshPackages();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const plan = useMemo(
    () =>
      area && layers.length
        ? planPackage({ bounds: area, minZoom: zooms.minZoom, maxZoom: zooms.maxZoom, zoomBasis: "map", layers: [...layers, ...unpackageableShown(map)] })
        : null,
    [area, layers, zooms, map],
  );

  if (status === "unavailable") {
    return <p className="text-sm text-muted">{reason}</p>;
  }
  if (status === "starting") {
    return <p className="text-sm text-muted">Opening downloaded maps…</p>;
  }

  const canDownload = Boolean(plan?.ok && name.trim() && !busy);
  const progress = busy?.progress;
  const busyName = busy ? (packages.find((p) => p.packageId === busy.packageId)?.name ?? name.trim()) : null;
  // Checking every file can't be paused (a check, the last step of a download, or repair's first check).
  const checking = busy
    ? busy.task === "verify" || (progress ? progress.total > 0 && progress.done + progress.failed >= progress.total : busy.task === "repair")
    : false;
  // Screen readers hear progress in 10% steps, not every update.
  const spoken =
    busy && progress && progress.total > 0
      ? `${checking ? "Checking files" : `${Math.floor((progress.done / progress.total) * 10) * 10}% downloaded`}`
      : busy
        ? checking
          ? "Checking files"
          : "Starting"
        : "";

  return (
    <div className="text-sm">
      <p className="text-muted">
        Download an area to use with no signal: base map, public land, roads and labels, and terrain. Weather, search, land lookups and hunt units still need a connection.
      </p>

      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
      {busy ? (
        <section className="mt-3 rounded-md border border-line bg-bg px-3 py-2">
          <p>
            {checking ? "Checking every file of" : busy.task === "repair" ? "Repairing" : busy.task === "update" ? "Updating" : "Downloading"} “{busyName}”
            {progress && !checking ? ` · ${formatCount(progress.done)} of ${formatCount(progress.total)} files · ${formatBytes(progress.bytes)}` : "…"}
          </p>
          {progress && progress.total > 0 ? (
            <progress className="mt-2 h-2 w-full accent-accent" max={progress.total} value={progress.done} aria-label="Download progress" />
          ) : null}
          {progress?.waitUntil ? (
            <p className="mt-1 text-muted">A provider asked Fieldline to slow down; some files wait until {new Date(progress.waitUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.</p>
          ) : null}
          {checking ? (
            <p className="mt-1 text-muted">Each file is re-read and compared with its checksum. This can take a minute for a large area and can't be paused.</p>
          ) : (
            <button type="button" className="mt-2 h-11 w-full rounded-md border border-line" onClick={pauseDownload}>
              Pause
            </button>
          )}
        </section>
      ) : null}

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={`mt-3 rounded-md px-3 py-2 ${notice.tone === "error" ? "border border-line bg-bg text-fg" : "bg-bg text-muted"}`}>
          {notice.text}
        </p>
      ) : null}

      <section className="mt-4" aria-labelledby={`${nameId}-new`}>
        <h3 id={`${nameId}-new`} className="font-display text-xl tracking-wide">
          Download an area
        </h3>
        <p className="text-muted">
          {area ? `The map view, ${areaSize(area, metric)}. The dashed box on the map shows it.` : "Waiting for the map…"}
        </p>
        <button
          type="button"
          className="mt-2 h-11 w-full rounded-md border border-line"
          onClick={() => {
            const next = getArea();
            setArea(next);
            if (!name.trim() || name === defaultName(area)) setName(defaultName(next));
          }}
        >
          Use the map view now
        </button>

        <label htmlFor={nameId} className="mt-3 block text-muted">
          Name
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 h-11 w-full rounded-md border border-line bg-bg px-3 text-fg"
        />

        <fieldset className="mt-3">
          <legend className="text-muted">Layers</legend>
          {SELECTABLE_LAYERS.map((id) => {
            const planned = plan?.layers.find((layer) => layer.layerId === id);
            return (
              <label key={id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={layers.includes(id)}
                  onChange={(event) =>
                    setLayers((current) => SELECTABLE_LAYERS.filter((layer) => (layer === id ? event.target.checked : current.includes(layer))))
                  }
                />
                <span className="flex-1">{layerLabel(id)}</span>
                {planned ? (
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {formatCount(planned.assetCount)} · {formatBytes(planned.estimatedBytes)}
                  </span>
                ) : null}
              </label>
            );
          })}
        </fieldset>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-muted">
            From zoom
            <select
              className="mt-1 h-11 w-full rounded-md border border-line bg-bg px-2 text-fg"
              value={zooms.minZoom}
              onChange={(event) => {
                const minZoom = Number(event.target.value);
                setZooms((z) => ({ minZoom, maxZoom: Math.max(minZoom, z.maxZoom) }));
              }}
            >
              {ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <label className="text-muted">
            To zoom
            <select
              className="mt-1 h-11 w-full rounded-md border border-line bg-bg px-2 text-fg"
              value={zooms.maxZoom}
              onChange={(event) => {
                const maxZoom = Number(event.target.value);
                setZooms((z) => ({ minZoom: Math.min(maxZoom, z.minZoom), maxZoom }));
              }}
            >
              {ZOOMS.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-1 text-xs text-subtle">The map is at zoom {Math.floor(viewZoom)}. Each level closer is about four times the files; levels further out cost little and cover zooming out and the distance in a tilted 3D view. Zoomed in past what you downloaded, the map shows softer, enlarged tiles.</p>

        {plan ? (
          <div className="mt-3 rounded-md bg-bg px-3 py-2">
            <p>
              About <span className="font-mono tabular-nums">{formatBytes(plan.totals.estimatedBytes)}</span>,{" "}
              <span className="font-mono tabular-nums">{formatCount(plan.totals.assets)}</span> files (an estimate; label fonts are included).
            </p>
            {plan.violations.map((violation) => (
              <p key={violation.message} role="alert" className="mt-1 text-fg">
                {violation.message}
              </p>
            ))}
            {plan.excluded.map((item) => (
              <p key={item.layerId} className="mt-1 text-muted">
                Not included: {item.reason}
              </p>
            ))}
            <p className="mt-1 text-xs text-subtle">{plan.attribution.join(" · ")}</p>
          </div>
        ) : (
          <p className="mt-3 text-muted">Pick at least one layer.</p>
        )}

        <button
          type="button"
          disabled={!canDownload}
          className="mt-3 h-11 w-full rounded-md bg-accent font-medium text-accent-fg disabled:opacity-50"
          onClick={() => {
            if (!plan) return;
            void downloadArea(plan, name.trim());
          }}
        >
          Download
        </button>
      </section>

      <section className="mt-5" aria-labelledby={`${nameId}-list`}>
        <h3 id={`${nameId}-list`} className="font-display text-xl tracking-wide">
          Downloaded areas
        </h3>
        {packages.length === 0 ? <p className="text-muted">None yet.</p> : null}
        <ul className="mt-1 space-y-2">
          {[...packages].reverse().map((status) => (
            <PackageRow
              key={status.packageId}
              status={status}
              bytes={bytes[status.packageId] ?? 0}
              busy={Boolean(busy)}
              running={busy?.packageId === status.packageId ? busy.task : null}
              confirming={confirmDelete === status.packageId}
              onConfirm={(on) => setConfirmDelete(on ? status.packageId : null)}
              onShow={() => onShow(status.manifest.bounds)}
            />
          ))}
        </ul>
        {packages.length ? (
          <p className="mt-2 text-xs text-subtle">
            {formatBytes(totalBytes)} on this device for downloaded maps (files shared between areas count once).
          </p>
        ) : null}
      </section>
    </div>
  );
}

function PackageRow({
  status,
  bytes,
  busy,
  running,
  confirming,
  onConfirm,
  onShow,
}: {
  status: PackageStatus;
  bytes: number;
  busy: boolean;
  /** The operation running on this package in this tab, if any. */
  running: OfflineTaskName | null;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onShow: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  const label = stateLabel(status, running);
  const can = packageActions(status, busy);
  const m = status.update ?? status.manifest;
  const expiry = status.servable ? expiryText(status) : null;
  const error = m.lastError?.message;
  const button = "h-11 rounded-md border border-line px-3 disabled:opacity-40";
  return (
    <li className="rounded-md border border-line px-3 py-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate font-medium">{status.name}</p>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE[label.tone]}`}>{label.text}</span>
      </div>
      <p className="text-xs text-muted">
        {layerSummary(status)} · {formatBytes(bytes)}
        {m.progress.total && m.progress.done < m.progress.total ? ` · ${formatCount(m.progress.done)} of ${formatCount(m.progress.total)} files` : ""}
      </p>
      {expiry ? <p className="text-xs text-muted">{expiry}</p> : null}
      {status.update && status.servable ? <p className="text-xs text-muted">The earlier copy stays offline until the update finishes.</p> : null}
      {status.waitUntil && status.waitUntil > Date.now() ? (
        <p className="text-xs text-muted">Resume after {new Date(status.waitUntil).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}; a provider asked Fieldline to wait.</p>
      ) : null}
      {status.interrupted && !running ? <p className="text-xs text-muted">The download stopped (the app closed, or another window is downloading). Resume to continue.</p> : null}
      {error && label.tone !== "ok" ? <p className="text-xs text-fg">{error}</p> : null}
      {m.integrityStatus.absentCount ? <p className="text-xs text-subtle">{formatCount(m.integrityStatus.absentCount)} tiles had no data at the source.</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={button} onClick={onShow}>
          Show on map
        </button>
        {can.resume ? (
          <button type="button" className={button} onClick={() => void resumePackage(status.packageId)}>
            {status.update ? "Resume update" : "Resume"}
          </button>
        ) : null}
        {can.update ? (
          <button type="button" className={button} onClick={() => void updateArea(status.packageId)}>
            Update
          </button>
        ) : null}
        {can.verify ? (
          <button type="button" className={button} onClick={() => void checkPackage(status.packageId)}>
            Check
          </button>
        ) : null}
        {can.repair ? (
          <button type="button" className={button} onClick={() => void repairArea(status.packageId)}>
            Repair
          </button>
        ) : null}
        {can.discardUpdate ? (
          <button type="button" className={button} onClick={() => void discardUpdate(status.packageId)}>
            Drop update
          </button>
        ) : null}
        <button type="button" disabled={!can.remove} className={button} onClick={() => onConfirm(true)}>
          Delete
        </button>
      </div>
      {confirming ? (
        <div role="alertdialog" aria-label={`Delete ${status.name}`} className="mt-2 rounded-md bg-bg px-3 py-2">
          <p>Delete “{status.name}” from this device? You'd need a connection to download it again.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="h-11 flex-1 rounded-md bg-accent font-medium text-accent-fg"
              onClick={() => {
                onConfirm(false);
                void deleteArea(status.packageId);
              }}
            >
              Delete
            </button>
            <button ref={cancelRef} type="button" className="h-11 flex-1 rounded-md border border-line" onClick={() => onConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
