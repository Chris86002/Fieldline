import {
  glyphUrls,
  mapZoomOffset,
  PACKAGE_LAYERS,
  PACKAGE_LIMITS,
  PROVIDER_LIMITS,
  SELECTABLE_LAYERS,
  UNPACKAGEABLE_LAYERS,
  type PackageLayerId,
  type ProviderId,
} from "./sources.ts";

/**
 * Offline package planning: which tiles a rectangle needs per layer, the
 * estimated size, excluded layers and provider-limit violations. Pure and
 * synchronous; counts are computed arithmetically before any tile list is
 * allocated.
 */

/**
 * Geographic rectangle in degrees. `west > east` means the rectangle crosses
 * the antimeridian (e.g. west 170, east -170 spans 20° of longitude).
 */
export type PackageBounds = { west: number; south: number; east: number; north: number };

export type TileRange = { z: number; x0: number; x1: number; y0: number; y1: number };
export type TileCoord = { z: number; x: number; y: number };

export type PlanRequest = {
  bounds: PackageBounds;
  minZoom: number;
  maxZoom: number;
  /** Layer ids; unknown or unpackageable ids are reported in `excluded`. */
  layers: readonly string[];
  /** Label fonts are added automatically (marks and sun labels need them); false omits them. */
  includeGlyphs?: boolean;
  /**
   * What `minZoom`/`maxZoom` mean. "tile" (default): tile zooms, the same for
   * every layer. "map": MapLibre map zooms; each layer gets the tile zooms
   * the map requests for them (`mapZoomOffset`: 256-pixel raster and terrain
   * tiles are one zoom deeper than the map, 512-pixel vector tiles are not).
   */
  zoomBasis?: "tile" | "map";
};

export type PlannedLayer = {
  layerId: PackageLayerId;
  label: string;
  provider: ProviderId;
  /** Zooms actually fetched for this layer (deeper zooms overzoom from maxZoom). */
  minZoom: number;
  maxZoom: number;
  ranges: TileRange[];
  /** Assets including extras (OFM TileJSON). */
  assetCount: number;
  estimatedBytes: number;
  /** Tile list; empty when the plan exceeds the hard package limit. */
  tiles: TileCoord[];
  attribution: string;
};

export type PlanViolation = {
  kind: "provider-limit" | "package-limit" | "invalid";
  provider?: ProviderId;
  message: string;
  value?: number;
  max?: number;
};

export type PackagePlan = {
  ok: boolean;
  bounds: PackageBounds;
  minZoom: number;
  maxZoom: number;
  layers: PlannedLayer[];
  excluded: { layerId: string; reason: string }[];
  violations: PlanViolation[];
  totals: { assets: number; estimatedBytes: number };
  attribution: string[];
};

const MAX_LAT = 85.05112878;

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function lngToTileX(lng: number, z: number): number {
  const n = 2 ** z;
  return Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
}

export function latToTileY(lat: number, z: number): number {
  const n = 2 ** z;
  const rad = (clampLat(lat) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return Math.max(0, Math.min(n - 1, y));
}

/** Longitude intervals of a rectangle, split at the antimeridian. */
export function lngIntervals(bounds: PackageBounds): [number, number][] {
  if (bounds.west <= bounds.east) return [[bounds.west, bounds.east]];
  return [
    [bounds.west, 180],
    [-180, bounds.east],
  ];
}

export function boundsProblems(bounds: PackageBounds): string[] {
  const problems: string[] = [];
  const { west, south, east, north } = bounds ?? ({} as PackageBounds);
  for (const [name, value] of Object.entries({ west, south, east, north })) {
    if (typeof value !== "number" || !Number.isFinite(value))
      problems.push(`${name} is not a number`);
  }
  if (problems.length) return problems;
  if (west < -180 || west > 180 || east < -180 || east > 180)
    problems.push("longitudes must be between -180 and 180");
  if (south < -90 || north > 90 || south >= north)
    problems.push("latitudes must satisfy -90 ≤ south < north ≤ 90");
  if (west === east) problems.push("the rectangle has no width");
  if (Math.min(north, MAX_LAT) <= Math.max(south, -MAX_LAT))
    problems.push("the rectangle is outside the map's latitude range");
  return problems;
}

/** Tile ranges covering the rectangle at zoom z (one or two, across the antimeridian). */
export function tileRanges(bounds: PackageBounds, z: number): TileRange[] {
  const y0 = latToTileY(bounds.north, z);
  const y1 = latToTileY(bounds.south, z);
  const ranges: TileRange[] = [];
  for (const [w, e] of lngIntervals(bounds)) {
    const x0 = lngToTileX(w, z);
    // A rectangle ending exactly on a tile edge doesn't need the next tile.
    let x1 = lngToTileX(e, z);
    const edge = ((e + 180) / 360) * 2 ** z;
    if (Number.isInteger(edge) && edge === x1 && x1 > x0) x1 -= 1;
    ranges.push({ z, x0, x1, y0, y1 });
  }
  // Two pieces that overlap at the same zoom (a nearly global rectangle) are merged.
  if (ranges.length === 2 && ranges[1].x1 >= ranges[0].x0) {
    return [{ z, x0: 0, x1: 2 ** z - 1, y0, y1 }];
  }
  return ranges;
}

export function rangeCount(range: TileRange): number {
  return (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
}

function* coordsOf(ranges: TileRange[]): Generator<TileCoord> {
  for (const range of ranges)
    for (let x = range.x0; x <= range.x1; x += 1)
      for (let y = range.y0; y <= range.y1; y += 1) yield { z: range.z, x, y };
}

export function expandTemplate(template: string, tile: TileCoord): string {
  return template
    .replaceAll("{z}", String(tile.z))
    .replaceAll("{x}", String(tile.x))
    .replaceAll("{y}", String(tile.y));
}

function normalizeLayers(requested: readonly string[], includeGlyphs: boolean) {
  const layers: PackageLayerId[] = [];
  const excluded: { layerId: string; reason: string }[] = [];
  for (const id of new Set(requested)) {
    if ((SELECTABLE_LAYERS as readonly string[]).includes(id)) layers.push(id as PackageLayerId);
    else if (id === "glyphs") includeGlyphs = true;
    else if (UNPACKAGEABLE_LAYERS[id])
      excluded.push({ layerId: id, reason: UNPACKAGEABLE_LAYERS[id] });
    else excluded.push({ layerId: id, reason: `"${id}" isn't a layer that can be downloaded.` });
  }
  layers.sort((a, b) => SELECTABLE_LAYERS.indexOf(a) - SELECTABLE_LAYERS.indexOf(b));
  if (includeGlyphs && layers.length) layers.push("glyphs");
  return { layers, excluded };
}

/**
 * Plans an offline package for a rectangle. The result lists, per layer, the
 * tile ranges and counts, estimated bytes, excluded layers with reasons, and
 * every violated limit (OpenFreeMap: 3,000 tiles or 50 MB per download; the
 * package hard cap). `ok` is false whenever anything is violated; such a plan
 * can't be turned into a package.
 */
export function planPackage(request: PlanRequest): PackagePlan {
  const bounds = { ...request.bounds };
  const violations: PlanViolation[] = [];
  for (const problem of boundsProblems(bounds))
    violations.push({ kind: "invalid", message: problem });
  const minZoom = Math.round(request.minZoom);
  const maxZoom = Math.round(request.maxZoom);
  if (
    !Number.isFinite(minZoom) ||
    !Number.isFinite(maxZoom) ||
    minZoom < 0 ||
    maxZoom > PACKAGE_LIMITS.maxZoom ||
    minZoom > maxZoom
  ) {
    violations.push({
      kind: "invalid",
      message: `zoom range must satisfy 0 ≤ min ≤ max ≤ ${PACKAGE_LIMITS.maxZoom}`,
    });
  }
  const { layers: layerIds, excluded } = normalizeLayers(
    request.layers ?? [],
    request.includeGlyphs ?? true,
  );
  if (!layerIds.length)
    violations.push({
      kind: "invalid",
      message: "choose at least one layer that can be downloaded",
    });

  const planned: PlannedLayer[] = [];
  if (!violations.some((v) => v.kind === "invalid")) {
    for (const layerId of layerIds) {
      const def = PACKAGE_LAYERS[layerId];
      if (def.kind === "glyphs") {
        const count = glyphUrls().length;
        planned.push({
          layerId,
          label: def.label,
          provider: def.provider,
          minZoom: 0,
          maxZoom: 0,
          ranges: [],
          assetCount: count,
          estimatedBytes: count * def.estimatedTileBytes,
          tiles: [],
          attribution: def.attribution,
        });
        continue;
      }
      const offset = request.zoomBasis === "map" ? mapZoomOffset(layerId) : 0;
      const lo = Math.min(minZoom + offset, def.maxZoom);
      const hi = Math.min(maxZoom + offset, def.maxZoom);
      const ranges: TileRange[] = [];
      for (let z = lo; z <= hi; z += 1) ranges.push(...tileRanges(bounds, z));
      const tileCount = ranges.reduce((sum, range) => sum + rangeCount(range), 0);
      const extras = def.kind === "vector" ? 1 : 0; // the TileJSON
      planned.push({
        layerId,
        label: def.label,
        provider: def.provider,
        minZoom: lo,
        maxZoom: hi,
        ranges,
        assetCount: tileCount + extras,
        estimatedBytes: tileCount * def.estimatedTileBytes + extras * 2_000,
        tiles: [],
        attribution: def.attribution,
      });
    }
  }

  const totals = {
    assets: planned.reduce((sum, layer) => sum + layer.assetCount, 0),
    estimatedBytes: planned.reduce((sum, layer) => sum + layer.estimatedBytes, 0),
  };
  for (const [provider, limits] of Object.entries(PROVIDER_LIMITS) as [
    ProviderId,
    (typeof PROVIDER_LIMITS)[ProviderId],
  ][]) {
    const mine = planned.filter((layer) => layer.provider === provider);
    if (!mine.length) continue;
    const assets = mine.reduce((sum, layer) => sum + layer.assetCount, 0);
    const bytes = mine.reduce((sum, layer) => sum + layer.estimatedBytes, 0);
    if (limits.maxAssetsPerPackage !== null && assets > limits.maxAssetsPerPackage) {
      violations.push({
        kind: "provider-limit",
        provider,
        message: `OpenFreeMap allows at most ${limits.maxAssetsPerPackage.toLocaleString("en-US")} tiles per download; this area needs ${assets.toLocaleString("en-US")}. Choose a smaller area or a lower top zoom.`,
        value: assets,
        max: limits.maxAssetsPerPackage,
      });
    }
    if (limits.maxBytesPerPackage !== null && bytes > limits.maxBytesPerPackage) {
      violations.push({
        kind: "provider-limit",
        provider,
        message: `OpenFreeMap allows at most ${Math.round(limits.maxBytesPerPackage / 1e6)} MB per download; this area is estimated at ${Math.round(bytes / 1e6)} MB.`,
        value: bytes,
        max: limits.maxBytesPerPackage,
      });
    }
  }
  if (totals.assets > PACKAGE_LIMITS.maxAssets) {
    violations.push({
      kind: "package-limit",
      message: `A package can hold at most ${PACKAGE_LIMITS.maxAssets.toLocaleString("en-US")} map files; this one needs ${totals.assets.toLocaleString("en-US")}.`,
      value: totals.assets,
      max: PACKAGE_LIMITS.maxAssets,
    });
  }
  if (totals.estimatedBytes > PACKAGE_LIMITS.maxBytes) {
    violations.push({
      kind: "package-limit",
      message: `A package can be at most ${Math.round(PACKAGE_LIMITS.maxBytes / 1e6)} MB; this one is estimated at ${Math.round(totals.estimatedBytes / 1e6)} MB.`,
      value: totals.estimatedBytes,
      max: PACKAGE_LIMITS.maxBytes,
    });
  }
  // Tile lists only when the package is within the hard cap (never allocate a world).
  if (totals.assets <= PACKAGE_LIMITS.maxAssets) {
    for (const layer of planned) layer.tiles = [...coordsOf(layer.ranges)];
  }
  return {
    ok: violations.length === 0,
    bounds,
    minZoom,
    maxZoom,
    layers: planned,
    excluded,
    violations,
    totals,
    attribution: planned.map((layer) => layer.attribution),
  };
}

/**
 * Canonical asset URLs for one planned layer, given its resolved template
 * (OFM's comes from its TileJSON at download time).
 */
export function layerAssetUrls(
  layer: PlannedLayer | { layerId: PackageLayerId; ranges: TileRange[] },
  template: string | null,
): string[] {
  const def = PACKAGE_LAYERS[layer.layerId];
  if (def.kind === "glyphs") return glyphUrls();
  if (!template) throw new Error(`No tile template for ${layer.layerId}`);
  const urls: string[] = [];
  for (const tile of coordsOf(layer.ranges)) urls.push(expandTemplate(template, tile));
  return urls;
}

/** True when the point is inside the rectangle (antimeridian aware). */
export function boundsContainPoint(bounds: PackageBounds, lng: number, lat: number): boolean {
  const x = normalizeLng(lng);
  if (lat < bounds.south || lat > bounds.north) return false;
  return lngIntervals(bounds).some(([w, e]) => x >= w && x <= e);
}

/** True when `outer` fully contains `inner` (both antimeridian aware). */
export function boundsContain(outer: PackageBounds, inner: PackageBounds): boolean {
  if (inner.south < outer.south || inner.north > outer.north) return false;
  const outs = lngIntervals(outer);
  return lngIntervals(inner).every(([w, e]) => outs.some(([ow, oe]) => w >= ow && e <= oe));
}

export function boundsIntersect(a: PackageBounds, b: PackageBounds): boolean {
  if (a.north < b.south || b.north < a.south) return false;
  return lngIntervals(a).some(([aw, ae]) =>
    lngIntervals(b).some(([bw, be]) => aw <= be && bw <= ae),
  );
}

export function normalizeLng(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
