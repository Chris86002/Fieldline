/**
 * Pure helpers for the offline maps screens: default choices, labels, the
 * outlines drawn on the map, and the "offline here" line (FIELD-01).
 */
import type { PackageBounds } from "../../lib/offline/plan.ts";
import type { CoverageResult, PackageStatus } from "../../lib/offline/package-store.ts";
import { PACKAGE_LAYERS, SELECTABLE_LAYERS, type PackageLayerId } from "../../lib/offline/sources.ts";
import type { Basemap } from "../../lib/hunt/types.ts";

/** Highest map zoom offered (imagery's deepest tiles); the planner clamps each layer to its own maximum. */
export const MAX_PACKAGE_ZOOM = 15;
export const MIN_PACKAGE_ZOOM = 4;

/** Layers to preselect from what the map shows now. */
export function defaultLayers(o: { basemap: Basemap; showPublic: boolean; terrain: boolean; showShade: boolean }): PackageLayerId[] {
  const layers: PackageLayerId[] = [];
  if (o.basemap === "topo") layers.push("usgs-topo");
  // Esri imagery (satellite, hybrid) can't be stored: USGS imagery stands in.
  else if (o.basemap !== "street") layers.push("usgs-imagery");
  if (o.showPublic) layers.push("blm-sma");
  layers.push("ofm-vector");
  // Sun shade and 3D terrain both draw from the terrain tiles.
  if (o.terrain || o.showShade) layers.push("dem");
  return SELECTABLE_LAYERS.filter((id) => layers.includes(id));
}

/** Layers the map shows that can't be packaged, so the plan lists them with the reason. */
export function unpackageableShown(o: { basemap: Basemap; showUnits: boolean }): string[] {
  const shown: string[] = [];
  if (o.basemap === "satellite" || o.basemap === "hybrid") shown.push("esri-imagery");
  if (o.showUnits) shown.push("hunt-units");
  return shown;
}

/**
 * Map zooms: two levels out to two levels of detail closer than the view.
 * Each level closer is about four times the files, so the levels further out
 * cost only a few percent; they cover zooming out and the far distance of a
 * tilted 3D view, which the map draws at lower zooms.
 */
export function defaultZooms(viewZoom: number): { minZoom: number; maxZoom: number } {
  const z = Number.isFinite(viewZoom) ? Math.floor(viewZoom) : 10;
  const top = Math.max(MIN_PACKAGE_ZOOM, Math.min(MAX_PACKAGE_ZOOM, z + 2));
  return { minZoom: Math.max(MIN_PACKAGE_ZOOM, Math.min(top, z - 2)), maxZoom: top };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 100_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** About how wide and tall an area is, in miles or kilometers. */
export function areaSize(bounds: PackageBounds, metric: boolean): string {
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  const midLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180);
  const kmX = (east - bounds.west) * 111.32 * Math.cos(midLat);
  const kmY = (bounds.north - bounds.south) * 110.57;
  const unit = metric ? 1 : 0.621371;
  const fmt = (km: number) => {
    const v = km * unit;
    return v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US");
  };
  return `about ${fmt(kmX)} × ${fmt(kmY)} ${metric ? "km" : "mi"}`;
}

export type StateTone = "ok" | "busy" | "warn" | "error" | "idle";

const RUNNING_LABEL: Record<OfflineTaskName, string> = {
  download: "Downloading",
  update: "Updating",
  verify: "Checking",
  repair: "Repairing",
};

export type OfflineTaskName = "download" | "update" | "verify" | "repair";

/**
 * A short state label and tone for a package row. `running` is the operation
 * this tab is running on it, if any: the stored state only changes at the
 * end, and a stored "downloading"/"updating"/"verifying" with nothing running
 * here means it stopped (closed app, another window, an update that never
 * started).
 */
export function stateLabel(status: PackageStatus, running: OfflineTaskName | null = null): { text: string; tone: StateTone } {
  if (running) return { text: RUNNING_LABEL[running], tone: "busy" };
  if (status.manifest.integrityStatus.status === "damaged" && status.update === null) {
    return { text: status.activeVersion === null ? "Didn't finish" : "Needs repair", tone: "error" };
  }
  switch (status.state) {
    case "ready":
      return { text: "Ready offline", tone: "ok" };
    case "stale":
      return { text: "Out of date", tone: "warn" };
    case "updating":
      return { text: "Update not finished", tone: "warn" };
    case "downloading":
    case "verifying":
      return { text: "Stopped", tone: "warn" };
    case "paused":
      return { text: status.interrupted ? "Stopped" : "Paused", tone: "warn" };
    case "failed":
      return status.update !== null && status.activeVersion !== null ? { text: "Update failed", tone: "warn" } : { text: "Didn't finish", tone: "error" };
    case "planned":
      return { text: "Not started", tone: "idle" };
  }
}

/** What the user can do with a package, given its state and whether anything is running. */
export function packageActions(status: PackageStatus, busy: boolean) {
  const damaged = status.manifest.integrityStatus.status === "damaged";
  const pendingWork = status.update !== null || status.activeVersion === null;
  return {
    /** Continue a first download or an update (repairing what its check found, if anything). */
    resume: !busy && pendingWork,
    verify: !busy && status.servable && !pendingWork,
    repair: !busy && damaged && !pendingWork,
    update: !busy && status.servable && !pendingWork && !damaged && (status.state === "ready" || status.state === "stale"),
    discardUpdate: !busy && status.update !== null && status.activeVersion !== null,
    remove: !busy,
  };
}

/** One line on when a package goes out of date. */
export function expiryText(status: PackageStatus, now = Date.now()): string | null {
  if (!status.expiresAt) return null;
  const date = new Date(status.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return status.expiresAt <= now ? `Out of date since ${date}. Update it before the trip.` : `Good until ${date}.`;
}

/** Layer names and zooms of a package, short. */
export function layerSummary(status: PackageStatus): string {
  const m = status.manifest;
  const names = m.layers
    .filter((layer) => layer.layerId !== "glyphs")
    .map((layer) => shortLayer(layer.layerId));
  return `${names.join(", ")} · zooms ${m.zoomRange.min}–${m.zoomRange.max}`;
}

export function shortLayer(id: PackageLayerId): string {
  switch (id) {
    case "usgs-imagery":
      return "USGS imagery";
    case "usgs-topo":
      return "topo";
    case "blm-sma":
      return "public land";
    case "ofm-vector":
      return "roads and labels";
    case "dem":
      return "terrain";
    case "glyphs":
      return "label fonts";
  }
}

export function layerLabel(id: PackageLayerId): string {
  return PACKAGE_LAYERS[id].label;
}

type Feature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Polygon"; coordinates: number[][][] };
};

function rectangle(bounds: PackageBounds): number[][][] {
  // Across the antimeridian, draw east past 180 so the ring stays one piece.
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  const { west, south, north } = bounds;
  return [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
}

/**
 * Outlines for the map: each package's area ("ready" when usable offline,
 * otherwise "partial"), plus the area being planned ("preview").
 */
export function areaFeatures(packages: readonly PackageStatus[], preview: PackageBounds | null): { type: "FeatureCollection"; features: Feature[] } {
  const features: Feature[] = packages.map((status) => ({
    type: "Feature",
    properties: {
      id: status.packageId,
      name: status.name,
      kind: status.servable && status.manifest.integrityStatus.status === "ok" ? "ready" : "partial",
    },
    geometry: { type: "Polygon", coordinates: rectangle(status.manifest.bounds) },
  }));
  if (preview) features.push({ type: "Feature", properties: { id: "preview", name: "", kind: "preview" }, geometry: { type: "Polygon", coordinates: rectangle(preview) } });
  return { type: "FeatureCollection", features };
}

type ZoomSpan = { min: number; max: number; open: boolean };

/**
 * Merges map-zoom spans that overlap or touch, keeping real gaps ("6 and
 * 12–14"). An open span ("12+": the layer reached its deepest tiles, so the
 * map enlarges past it) swallows everything above it.
 */
export function zoomSpansText(spans: ZoomSpan[]): string {
  const sorted = [...spans].sort((a, b) => a.min - b.min);
  const merged: ZoomSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && (last.open || span.min <= last.max + 1)) {
      if (!last.open) {
        last.max = Math.max(last.max, span.max);
        last.open = span.open;
      }
    } else {
      merged.push({ ...span });
    }
  }
  const parts = merged.map((s) => (s.open ? `${s.min}+` : s.min === s.max ? `${s.min}` : `${s.min}–${s.max}`));
  const single = merged.length === 1 && !merged[0].open && merged[0].min === merged[0].max;
  return `${single ? "zoom" : "zooms"} ${parts.join(" and ")}`;
}

/**
 * The "offline here" line for a point (FIELD-01), from verified manifests:
 * per layer, the map zooms of the covering areas where that layer is
 * complete. Null when there are no packages at all, so the line stays out of
 * the way.
 */
export function coverageText(coverage: CoverageResult | null, anyPackages: boolean, now = Date.now()): string | null {
  if (!coverage || !anyPackages) return null;
  if (coverage.covered) {
    const covering = coverage.packages.filter((p) => p.contains);
    const spans = new Map<PackageLayerId, ZoomSpan[]>();
    for (const pkg of covering) {
      for (const layer of pkg.layers) {
        if (!layer.complete || layer.layerId === "glyphs") continue;
        const open = layer.maxZoom >= PACKAGE_LAYERS[layer.layerId].maxZoom;
        const list = spans.get(layer.layerId) ?? [];
        list.push({ min: pkg.zoomRange.min, max: pkg.zoomRange.max, open });
        spans.set(layer.layerId, list);
      }
    }
    const parts = SELECTABLE_LAYERS.filter((id) => spans.has(id)).map((id) => `${shortLayer(id)} ${zoomSpansText(spans.get(id)!)}`);
    const names = covering.map((p) => `“${p.name}”`);
    const stale = covering.filter((p) => p.expiresAt !== null && p.expiresAt <= now).map((p) => `“${p.name}”`);
    const staleNote = stale.length ? ` Out of date: ${stale.join(", ")}; update before the trip.` : "";
    return `Offline here: ${parts.join(", ")} (${names.join(", ")}).${staleNote}`;
  }
  if (coverage.incomplete.length > 0) {
    return `Not ready offline here: “${coverage.incomplete[0].name}” hasn't finished downloading or needs a repair.`;
  }
  return "Not downloaded for offline use.";
}
