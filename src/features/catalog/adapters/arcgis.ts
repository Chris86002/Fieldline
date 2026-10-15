/**
 * Bounded ArcGIS REST helper for hunt-unit adapters, plus a factory that
 * turns a FeatureServer/MapServer polygon layer into a `UnitAdapter`.
 *
 * Every request: goes only to an allowlisted provider host over https, has
 * a timeout, honours the caller's AbortSignal, and has its JSON shape
 * checked. Paged queries follow `exceededTransferLimit` with
 * resultOffset/resultRecordCount, never ask for more than the layer's
 * maxRecordCount per page, and stop at a page and feature cap.
 *
 * Observed 2026-10-13 on both services: maxRecordCount 2000,
 * advancedQueryCapabilities.supportsPagination true, geoJSON output, and
 * `properties.exceededTransferLimit: true` on a page that was cut short
 * (IDFG also repeats it at the top level).
 */
import type { HuntUnit, JurisdictionId, LngLat, ProviderInfo, UnitAdapter, UnitHit, UnitIdentifyResult } from "../types.ts";
import { boundsContain, boundsOf, closeRing, interiorPoint, polygonsContain } from "../unit-geometry.ts";
import type { UnitStorage, UnitStore } from "../unit-store.ts";
import { abortError, createUnitStore, UnitValidationError } from "../unit-store.ts";

/** The only hosts adapters may query. Add a host here only with a data-sources.md entry. */
export const ARCGIS_ALLOWED_HOSTS: readonly string[] = [
  "services8.arcgis.com",
  "gisportal-idfg.idaho.gov",
  "fwp-gis.mt.gov",
  "services5.arcgis.com",
  "services.arcgis.com",
  "services6.arcgis.com",
];
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_PAGES = 25;
export const DEFAULT_MAX_FEATURES = 20_000;
const MAX_PAGE_SIZE = 2000;

export type ArcgisErrorCode = "blocked-host" | "network" | "timeout" | "http" | "service" | "shape" | "limit";

export class ArcgisError extends Error {
  readonly code: ArcgisErrorCode;
  constructor(code: ArcgisErrorCode, message: string) {
    super(message);
    this.name = "ArcgisError";
    this.code = code;
  }
}

export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return isRecord(error) && error.name === "AbortError";
}

/** Parses and checks a provider URL against the host allowlist. */
export function allowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArcgisError("blocked-host", "The service address is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ARCGIS_ALLOWED_HOSTS.includes(url.hostname)) {
    throw new ArcgisError("blocked-host", `Requests to ${url.host || "that address"} are not allowed.`);
  }
  return url;
}

function withParams(base: string, path: string, params: Record<string, string>): URL {
  const url = allowedUrl(base.replace(/\/+$/, "") + path);
  url.search = "";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function getJson(url: URL, options: RequestOptions): Promise<unknown> {
  const outer = options.signal;
  if (outer?.aborted) throw abortError(outer);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  const failure = (fallback: ArcgisError) => {
    if (outer?.aborted) return abortError(outer);
    if (timedOut) return new ArcgisError("timeout", "The service did not answer in time.");
    return fallback;
  };
  try {
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal });
    } catch {
      throw failure(new ArcgisError("network", "The service could not be reached."));
    }
    if (!res.ok) throw new ArcgisError("http", `The service answered HTTP ${res.status}.`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw failure(new ArcgisError("shape", "The service sent a response that is not JSON."));
    }
    if (isRecord(body) && isRecord(body.error)) {
      const detail = typeof body.error.message === "string" ? body.error.message.slice(0, 200) : "unknown error";
      throw new ArcgisError("service", `The service reported an error: ${detail}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

export type LayerMetadata = {
  maxRecordCount: number;
  fields: string[];
  supportsPagination: boolean;
  /** editingInfo.dataLastEditDate, else lastEditDate (ms), else null. */
  editDate: number | null;
};

/** Layer `?f=json` metadata, checked for the parts adapters rely on. */
export async function fetchLayerMetadata(layerUrl: string, options: RequestOptions = {}): Promise<LayerMetadata> {
  const body = await getJson(withParams(layerUrl, "", { f: "json" }), options);
  if (!isRecord(body)) throw new ArcgisError("shape", "The layer description is not an object.");
  const max = body.maxRecordCount;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new ArcgisError("shape", "The layer description has no valid maxRecordCount.");
  }
  if (!Array.isArray(body.fields)) throw new ArcgisError("shape", "The layer description lists no fields.");
  const fields = body.fields.flatMap((field) => (isRecord(field) && typeof field.name === "string" ? [field.name] : []));
  const editing = isRecord(body.editingInfo) ? body.editingInfo : {};
  const edit = [editing.dataLastEditDate, editing.lastEditDate].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  const advanced = isRecord(body.advancedQueryCapabilities) ? body.advancedQueryCapabilities : {};
  return {
    maxRecordCount: max,
    fields,
    supportsPagination: advanced.supportsPagination === true,
    editDate: edit ?? null,
  };
}

/** `returnCountOnly` answer for a where clause. */
export async function fetchCount(layerUrl: string, where: string, options: RequestOptions = {}): Promise<number> {
  const body = await getJson(withParams(layerUrl, "/query", { where, returnCountOnly: "true", f: "json" }), options);
  const count = isRecord(body) ? body.count : undefined;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new ArcgisError("shape", "The feature count response is not a count.");
  }
  return count;
}

export type RawFeature = { id: unknown; geometry: unknown; properties: unknown };

export type FeatureQuery = {
  where: string;
  outFields: string[];
  /** Stable ordering field (the object-ID field) so pages do not overlap. */
  orderByField: string;
  /** Extra query parameters, e.g. geometryPrecision / maxAllowableOffset. */
  params?: Record<string, string>;
  /** Features per page; capped at the layer's maxRecordCount. */
  pageSize: number;
  /** False when the layer cannot page: a cut-short single page is then an error. */
  paginate?: boolean;
  maxPages?: number;
  maxFeatures?: number;
};

/** All features for a query as GeoJSON (outSR 4326), following pagination. */
export async function queryAllFeatures(
  layerUrl: string,
  query: FeatureQuery,
  options: RequestOptions = {},
): Promise<{ features: RawFeature[]; pages: number }> {
  const pageSize = Math.max(1, Math.min(Math.floor(query.pageSize), MAX_PAGE_SIZE));
  const maxPages = query.maxPages ?? DEFAULT_MAX_PAGES;
  const maxFeatures = query.maxFeatures ?? DEFAULT_MAX_FEATURES;
  const paginate = query.paginate ?? true;
  const features: RawFeature[] = [];
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new ArcgisError("limit", `The download needed more than ${maxPages} pages.`);
    const params: Record<string, string> = {
      where: query.where,
      outFields: query.outFields.join(","),
      orderByFields: query.orderByField,
      returnGeometry: "true",
      outSR: "4326",
      ...query.params,
      f: "geojson",
    };
    if (paginate) {
      params.resultOffset = String(features.length);
      params.resultRecordCount = String(pageSize);
    }
    const body = await getJson(withParams(layerUrl, "/query", params), options);
    pages += 1;
    if (!isRecord(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      throw new ArcgisError("shape", "The feature response is not a GeoJSON FeatureCollection.");
    }
    for (const feature of body.features) {
      if (!isRecord(feature)) throw new ArcgisError("shape", "The feature response contains a non-object feature.");
      features.push({ id: feature.id, geometry: feature.geometry, properties: feature.properties });
    }
    if (features.length > maxFeatures) throw new ArcgisError("limit", `The download exceeded ${maxFeatures} features.`);
    const meta = isRecord(body.properties) ? body.properties : {};
    const exceeded = body.exceededTransferLimit === true || meta.exceededTransferLimit === true;
    if (!exceeded) break;
    if (!paginate) throw new ArcgisError("limit", "The service cut the download short and cannot page.");
    if (body.features.length === 0) break;
  }
  return { features, pages };
}

/** Attribute rows of every feature intersecting a WGS84 point (no geometry). */
export async function queryPoint(
  layerUrl: string,
  point: LngLat,
  query: { where: string; outFields: string[] },
  options: RequestOptions = {},
): Promise<Record<string, unknown>[]> {
  const body = await getJson(
    withParams(layerUrl, "/query", {
      where: query.where,
      geometry: JSON.stringify({ x: point.lng, y: point.lat }),
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: query.outFields.join(","),
      returnGeometry: "false",
      f: "json",
    }),
    options,
  );
  if (!isRecord(body) || !Array.isArray(body.features)) {
    throw new ArcgisError("shape", "The point query response has no feature list.");
  }
  return body.features.map((feature) => {
    if (!isRecord(feature) || !isRecord(feature.attributes)) {
      throw new ArcgisError("shape", "The point query response has a feature without attributes.");
    }
    return feature.attributes;
  });
}

// ---------------------------------------------------------------------------
// ArcGIS-backed unit adapter
// ---------------------------------------------------------------------------

/** Source fields mapped to the unit contract. Missing values stay null / "". */
export type UnitFields = Pick<HuntUnit, "code" | "regionName" | "speciesTags" | "seasonContext" | "landNote" | "forest" | "sqMiles">;

export type ArcgisUnitSource = {
  info: ProviderInfo;
  jurisdictionId: JurisdictionId;
  /** Layer URL without a trailing `/query`. */
  layerUrl: string;
  where: string;
  objectIdField: string;
  /** Field holding the unit code; features lacking it reject the download. */
  codeField: string;
  outFields: string[];
  /** Display simplification for the stored copy (identify stays authoritative). */
  geometryPrecision: number;
  maxAllowableOffset: number;
  /** Returns null for rows that are not real units (e.g. "N/A"). */
  mapAttributes(attributes: Record<string, unknown>): UnitFields | null;
  /** What the agency calls a unit, e.g. "Hunting District". Defaults to "Unit". */
  labelPrefix?: string;
};

function unitLabel(source: ArcgisUnitSource, code: string): string {
  return `${source.labelPrefix ?? "Unit"} ${code}`;
}

export type ArcgisAdapterOptions = {
  storage?: UnitStorage;
  now?: () => number;
  timeoutMs?: number;
  /** Override the page size (still capped at maxRecordCount). */
  pageSize?: number;
  maxPages?: number;
  refreshMs?: number;
  retryMs?: number;
  maxDropRatio?: number;
};

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A finite number, or null. Null, "", and non-numeric strings are not zero. */
export function cleanNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseRing(raw: unknown): number[][] | null {
  if (!Array.isArray(raw)) return null;
  const ring: number[][] = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2 || !finite(point[0]) || !finite(point[1])) return null;
    ring.push([point[0], point[1]]);
  }
  return closeRing(ring);
}

/**
 * GeoJSON Polygon/MultiPolygon → [polygon][ring][point]. Wrong types or
 * non-numeric coordinates throw; rings that simplification collapsed below
 * four positions are dropped (an outer ring drops its whole part).
 */
export function parsePolygons(geometry: unknown, label: string): number[][][][] {
  const malformed = () => new UnitValidationError(`${label} has malformed geometry`);
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) throw malformed();
  let parts: unknown[];
  if (geometry.type === "Polygon") parts = [geometry.coordinates];
  else if (geometry.type === "MultiPolygon") parts = geometry.coordinates;
  else throw malformed();
  const polygons: number[][][][] = [];
  for (const part of parts) {
    if (!Array.isArray(part) || part.length === 0) throw malformed();
    const rings: number[][][] = [];
    for (let r = 0; r < part.length; r++) {
      const ring = parseRing(part[r]);
      if (!ring) throw malformed();
      if (ring.length < 4) {
        if (r === 0) break;
        continue;
      }
      rings.push(ring);
    }
    if (rings.length > 0) polygons.push(rings);
  }
  if (polygons.length === 0) throw malformed();
  return polygons;
}

function unitFrom(source: ArcgisUnitSource, fields: UnitFields, polygons: number[][][][]): HuntUnit {
  const bounds = boundsOf(polygons);
  const labelPoint = interiorPoint(polygons);
  if (!bounds || !labelPoint) throw new UnitValidationError(`unit ${fields.code} has malformed geometry`);
  return {
    id: `${source.jurisdictionId}:${source.info.id}:${fields.code}`,
    jurisdictionId: source.jurisdictionId,
    providerId: source.info.id,
    sourceFeatureId: fields.code,
    label: unitLabel(source, fields.code),
    ...fields,
    bounds,
    labelPoint,
    polygons,
  };
}

/** Groups multipart features by unit code (first row's attributes win), sorted by code. */
export function unitsFromFeatures(source: ArcgisUnitSource, features: RawFeature[]): HuntUnit[] {
  const grouped = new Map<string, { fields: UnitFields; polygons: number[][][][] }>();
  const seen = new Set<string>();
  for (const feature of features) {
    const props = feature.properties;
    if (!isRecord(props)) throw new UnitValidationError("a feature has no attributes");
    if (!(source.codeField in props)) {
      throw new UnitValidationError(`features are missing the required field "${source.codeField}" (renamed or removed?)`);
    }
    const oid = props[source.objectIdField] ?? feature.id;
    if (oid !== undefined && oid !== null) {
      const key = String(oid);
      if (seen.has(key)) throw new UnitValidationError("the provider sent the same feature twice across pages");
      seen.add(key);
    }
    const fields = source.mapAttributes(props);
    if (!fields) continue;
    const polygons = parsePolygons(feature.geometry, `unit ${fields.code}`);
    const entry = grouped.get(fields.code);
    if (entry) entry.polygons.push(...polygons);
    else grouped.set(fields.code, { fields, polygons });
  }
  return [...grouped.values()]
    .map(({ fields, polygons }) => unitFrom(source, fields, polygons))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

function hitFrom(source: ArcgisUnitSource, fields: UnitFields, approximate: boolean): UnitHit {
  return {
    unit: {
      id: `${source.jurisdictionId}:${source.info.id}:${fields.code}`,
      jurisdictionId: source.jurisdictionId,
      providerId: source.info.id,
      code: fields.code,
      label: unitLabel(source, fields.code),
      regionName: fields.regionName,
      speciesTags: fields.speciesTags,
      seasonContext: fields.seasonContext,
      landNote: fields.landNote,
      forest: fields.forest,
      sqMiles: fields.sqMiles,
    },
    approximate,
  };
}

function hitFromUnit(unit: HuntUnit): UnitHit {
  const { id, jurisdictionId, providerId, code, label, regionName, speciesTags, seasonContext, landNote, forest, sqMiles } =
    unit;
  return {
    unit: { id, jurisdictionId, providerId, code, label, regionName, speciesTags, seasonContext, landNote, forest, sqMiles },
    approximate: true,
  };
}

function plainReason(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : "The service could not be reached.";
  return text.replace(/[.\s]+$/, "");
}

/** Builds a `UnitAdapter` (and its store) for one ArcGIS polygon layer. */
export function createArcgisUnitAdapter(
  source: ArcgisUnitSource,
  options: ArcgisAdapterOptions = {},
): UnitAdapter & { store: UnitStore } {
  const transform = JSON.stringify({
    layer: source.layerUrl,
    where: source.where,
    outFields: source.outFields,
    geometryPrecision: source.geometryPrecision,
    maxAllowableOffset: source.maxAllowableOffset,
  });
  const request = (signal: AbortSignal): RequestOptions => ({ signal, timeoutMs: options.timeoutMs });

  const store = createUnitStore({
    providerId: source.info.id,
    title: source.info.title,
    coverage: source.info.coverage,
    transform,
    storage: options.storage,
    now: options.now,
    refreshMs: options.refreshMs,
    retryMs: options.retryMs,
    maxDropRatio: options.maxDropRatio,
    async download({ previous, signal }) {
      const meta = await fetchLayerMetadata(source.layerUrl, request(signal));
      for (const field of [source.objectIdField, ...source.outFields]) {
        if (!meta.fields.includes(field)) {
          throw new UnitValidationError(`the service no longer lists the field "${field}" (renamed or removed?)`);
        }
      }
      const sourceVersion = meta.editDate === null ? null : new Date(meta.editDate).toISOString();
      const expectedCount = await fetchCount(source.layerUrl, source.where, request(signal));
      if (
        previous &&
        sourceVersion !== null &&
        previous.sourceVersion === sourceVersion &&
        previous.expectedCount === expectedCount &&
        previous.transform === transform
      ) {
        return { unchanged: true, sourceVersion, expectedCount };
      }
      const { features } = await queryAllFeatures(
        source.layerUrl,
        {
          where: source.where,
          outFields: [source.objectIdField, ...source.outFields],
          orderByField: source.objectIdField,
          params: {
            geometryPrecision: String(source.geometryPrecision),
            maxAllowableOffset: String(source.maxAllowableOffset),
          },
          pageSize: Math.min(options.pageSize ?? meta.maxRecordCount, meta.maxRecordCount),
          paginate: meta.supportsPagination,
          maxPages: options.maxPages,
        },
        request(signal),
      );
      return {
        units: unitsFromFeatures(source, features),
        featureCount: features.length,
        expectedCount,
        sourceVersion,
      };
    },
  });

  async function identify(point: LngLat, signal?: AbortSignal): Promise<UnitIdentifyResult> {
    if (signal?.aborted) throw abortError(signal);
    if (!finite(point?.lng) || !finite(point?.lat) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      return { status: "unknown", hits: [], message: "That location is not a valid coordinate." };
    }
    if (!source.info.coverage.some((box) => boundsContain(box, point.lng, point.lat))) {
      return { status: "available", hits: [], message: null };
    }
    let reason: string;
    try {
      const rows = await queryPoint(
        source.layerUrl,
        point,
        { where: source.where, outFields: source.outFields },
        { signal, timeoutMs: options.timeoutMs },
      );
      const hits = new Map<string, UnitHit>();
      for (const row of rows) {
        const fields = source.mapAttributes(row);
        if (fields && !hits.has(fields.code)) hits.set(fields.code, hitFrom(source, fields, false));
      }
      return { status: "available", hits: [...hits.values()], message: null };
    } catch (error) {
      if (isAbortError(error, signal)) throw signal?.aborted ? abortError(signal) : error;
      reason = plainReason(error);
    }
    const local = await store.peek();
    if (!local) {
      return {
        status: "unavailable",
        hits: [],
        message: `${source.info.title} could not be checked (${reason}) and no saved copy is available.`,
      };
    }
    const hits = local.snapshot.units
      .filter((unit) => boundsContain(unit.bounds, point.lng, point.lat) && polygonsContain(unit.polygons, point.lng, point.lat))
      .map(hitFromUnit);
    const saved = new Date(local.snapshot.manifest.retrievedAt).toISOString().slice(0, 10);
    return {
      status: local.current ? "available" : "stale",
      hits,
      message: `${source.info.title} could not be checked (${reason}). Answered from the saved copy from ${saved}; its boundaries are simplified, so results near a line are approximate.`,
    };
  }

  return { info: source.info, load: (signal) => store.load(signal), identify, store };
}
