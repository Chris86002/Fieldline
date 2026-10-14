/**
 * TEST FIXTURES ONLY. Synthetic, deliberately small data shaped like the
 * ArcGIS REST responses observed from the AZGFD and IDFG services on
 * 2026-10-13 (layer `?f=json`, `returnCountOnly`, paged `f=geojson` with
 * `properties.exceededTransferLimit`, point query `f=json`). Unit names,
 * boundaries and attributes are invented; never treat them as provider data.
 */
import { polygonsContain } from "../../unit-geometry.ts";

export type FixtureFeature = {
  type: "Feature";
  id: number;
  geometry: unknown;
  properties: Record<string, unknown>;
};

/** A closed square ring (counter-clockwise) at the given corner. */
export function squareRing(west: number, south: number, size: number): number[][] {
  return [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
}

/** Corner of grid cell (col, row) inside Arizona. */
export function azCell(col: number, row: number): [number, number] {
  return [-114 + col * 0.3, 32 + row * 0.3];
}

/** Corner of grid cell (col, row) inside Idaho. */
export function idCell(col: number, row: number): [number, number] {
  return [-116.5 + col * 0.3, 43 + row * 0.3];
}

export function azFeature(
  oid: number,
  code: string,
  corner: [number, number],
  overrides: Record<string, unknown> = {},
  geometry?: unknown,
): FixtureFeature {
  return {
    type: "Feature",
    id: oid,
    geometry: geometry ?? { type: "Polygon", coordinates: [squareRing(corner[0], corner[1], 0.25)] },
    properties: {
      OBJECTID: oid,
      GMU: code,
      REG_NAME: "FIXTURE Region",
      SQ_MILES: 100 + oid,
      LANDOWN: "FIXTURE National Forest, Private",
      HUNT: "Elk, Mule Deer, Javelina",
      USFSName: "FIXTURE National Forest",
      ...overrides,
    },
  };
}

export function idFeature(
  oid: number,
  code: string,
  corner: [number, number],
  elkZone: string | null = "FIXTURE Zone",
): FixtureFeature {
  return {
    type: "Feature",
    id: oid,
    geometry: { type: "Polygon", coordinates: [squareRing(corner[0], corner[1], 0.25)] },
    properties: { OBJECTID_1: oid, NAME: code, Elk_Zone: elkZone },
  };
}

/** n AZ features with codes "1".."n" on a grid. */
export function azFeatures(n: number, start = 1): FixtureFeature[] {
  return Array.from({ length: n }, (_, i) => azFeature(start + i, String(start + i), azCell(i % 10, Math.floor(i / 10))));
}

export const AZ_FIELD_NAMES = ["OBJECTID", "GMU", "GF_REGION", "REG_NAME", "SQ_MILES", "LANDOWN", "HUNT", "USFSName"];
export const ID_FIELD_NAMES = ["OBJECTID_1", "OBJECTID", "NAME", "ID", "Elk_Zone"];

export function layerMetadata(options: {
  fields: string[];
  maxRecordCount?: number;
  editDate?: number | null;
  supportsPagination?: boolean;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    currentVersion: 11.5,
    type: "Feature Layer",
    geometryType: "esriGeometryPolygon",
    maxRecordCount: options.maxRecordCount ?? 2000,
    advancedQueryCapabilities: { supportsPagination: options.supportsPagination ?? true, supportsOrderBy: true },
    supportedQueryFormats: "JSON, geoJSON, PBF",
    fields: options.fields.map((name) => ({ name, type: "esriFieldTypeString", alias: name })),
  };
  if (options.editDate != null) {
    meta.editingInfo = {
      lastEditDate: options.editDate,
      schemaLastEditDate: options.editDate,
      dataLastEditDate: options.editDate,
    };
  }
  return meta;
}

type Answer = unknown | (() => Response | Promise<Response>);

export type FakeLayer = {
  meta: Answer;
  /** Server count; defaults to features.length. */
  count?: Answer;
  features: FixtureFeature[];
  /** Replace a page body (e.g. to drop exceededTransferLimit). */
  page?: (offset: number, size: number, features: FixtureFeature[]) => unknown;
  /** Replace the point-query answer. Default: attributes of features containing the point. */
  identify?: Answer;
};

export type FakeArcgis = {
  fetch: typeof fetch;
  calls: URL[];
  /** Calls whose path/params match a kind. */
  count(kind: "meta" | "count" | "page" | "identify"): number;
};

function respond(answer: Answer): Response | Promise<Response> {
  if (typeof answer === "function") return (answer as () => Response | Promise<Response>)();
  return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
}

function kindOf(url: URL): "meta" | "count" | "page" | "identify" {
  if (!url.pathname.endsWith("/query")) return "meta";
  if (url.searchParams.get("returnCountOnly") === "true") return "count";
  if (url.searchParams.has("geometry")) return "identify";
  return "page";
}

/** A fetch stub that serves fixture layers keyed by layer URL. Unknown URLs answer 404. */
export function fakeArcgis(layers: Record<string, FakeLayer>): FakeArcgis {
  const calls: URL[] = [];
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const base = url.origin + url.pathname.replace(/\/query$/, "");
    const layer = layers[base];
    if (!layer) return new Response("not found", { status: 404 });
    const kind = kindOf(url);
    if (kind === "meta") return respond(layer.meta);
    if (kind === "count") return respond(layer.count ?? { count: layer.features.length });
    if (kind === "identify") {
      if (layer.identify !== undefined) return respond(layer.identify);
      const point = JSON.parse(url.searchParams.get("geometry") ?? "{}") as { x: number; y: number };
      const hits = layer.features.filter((feature) => {
        const geometry = feature.geometry as { type: string; coordinates: number[][][] | number[][][][] };
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : (geometry.coordinates as number[][][][]);
        return polygonsContain(polygons, point.x, point.y);
      });
      return respond({ features: hits.map((feature) => ({ attributes: feature.properties })) });
    }
    const offset = Number(url.searchParams.get("resultOffset") ?? 0);
    const size = Number(url.searchParams.get("resultRecordCount") ?? layer.features.length);
    if (layer.page) return respond(layer.page(offset, size, layer.features));
    const slice = layer.features.slice(offset, offset + size);
    const body: Record<string, unknown> = { type: "FeatureCollection", features: slice };
    if (offset + size < layer.features.length) body.properties = { exceededTransferLimit: true };
    return respond(body);
  }) as typeof fetch;
  return {
    fetch: fetchStub,
    calls,
    count: (kind) => calls.filter((url) => kindOf(url) === kind).length,
  };
}
