/**
 * TEST FIXTURES ONLY: a fake set of tile providers for offline package tests.
 * Responses are synthetic bytes derived from the URL; nothing here is real
 * provider data, and app code never imports this file.
 */
import { MemoryBackend } from "../storage/backend.ts";
import type { DownloadOptions } from "./download.ts";
import { OfflinePackageStore } from "./package-store.ts";
import { planPackage, type PlanRequest } from "./plan.ts";

export const FIXTURE_OFM_VERSION = "20260101_000000_pt";
export const FIXTURE_APP_ORIGIN = "http://localhost:8080";

export type FakeProvider = {
  fetch: typeof fetch;
  /** Every requested URL, in order. */
  calls: string[];
  /** Highest simultaneous requests per host. */
  maxInFlight: Map<string, number>;
  /** Highest simultaneous requests overall. */
  maxInFlightTotal: () => number;
  /** Content generation: bump to simulate a provider data update. */
  revision: number;
  /** OpenFreeMap data version the fake TileJSON names. */
  ofmVersion: string;
  /** The init object of every request, in order. */
  inits: (RequestInit | undefined)[];
  /** Return a response (or throw) instead of the default; `call` is the 1-based request number. */
  override: ((url: string, call: number) => Response | Error | null) | null;
};

export function fakeProvider(options: { delayMs?: number } = {}): FakeProvider {
  const inFlight = new Map<string, number>();
  let total = 0;
  let maxTotal = 0;
  const provider: FakeProvider = {
    calls: [],
    maxInFlight: new Map(),
    maxInFlightTotal: () => maxTotal,
    revision: 1,
    ofmVersion: FIXTURE_OFM_VERSION,
    inits: [],
    override: null,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      provider.calls.push(url);
      provider.inits.push(init);
      const call = provider.calls.length;
      const host = new URL(url).host;
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      provider.maxInFlight.set(
        host,
        Math.max(provider.maxInFlight.get(host) ?? 0, inFlight.get(host)!),
      );
      total += 1;
      maxTotal = Math.max(maxTotal, total);
      try {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1));
        const custom = provider.override?.(url, call);
        if (custom instanceof Error) throw custom;
        if (custom) return custom;
        return defaultResponse(url, provider.revision, provider.ofmVersion);
      } finally {
        inFlight.set(host, inFlight.get(host)! - 1);
        total -= 1;
      }
    }) as typeof fetch,
  };
  return provider;
}

function defaultResponse(url: string, revision: number, ofmVersion: string): Response {
  if (url === "https://tiles.openfreemap.org/planet") {
    return Response.json({
      tilejson: "3.0.0",
      tiles: [`https://tiles.openfreemap.org/planet/${ofmVersion}/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: 14,
    });
  }
  const type = url.endsWith(".pbf")
    ? "application/x-protobuf"
    : url.includes("/api/dem/") || url.includes("BLM")
      ? "image/png"
      : "image/jpeg";
  return new Response(new TextEncoder().encode(`fixture r${revision} ${url}`), {
    headers: { "content-type": type },
  });
}

/** Instant sleep that records requested delays. */
export function fakeSleep(): { sleep: NonNullable<DownloadOptions["sleep"]>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms, signal) => {
      delays.push(ms);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Paused", "AbortError");
    },
  };
}

export function newStore(backend = new MemoryBackend()) {
  return { backend, store: new OfflinePackageStore(backend) };
}

/** A small area in Arizona at zooms 12–13: a few tiles per layer. */
export const SMALL_AREA: PlanRequest = {
  bounds: { west: -111.52, south: 34.48, east: -111.47, north: 34.52 },
  minZoom: 12,
  maxZoom: 13,
  layers: ["usgs-topo", "blm-sma", "ofm-vector", "dem"],
};

export function smallPlan(overrides: Partial<PlanRequest> = {}) {
  const plan = planPackage({ ...SMALL_AREA, ...overrides });
  if (!plan.ok) throw new Error(`fixture plan not ok: ${JSON.stringify(plan.violations)}`);
  return plan;
}

export function downloadOptions(
  provider: FakeProvider,
  extra: Partial<DownloadOptions> = {},
): DownloadOptions {
  return {
    fetch: provider.fetch,
    sleep: fakeSleep().sleep,
    random: () => 0.5,
    persist: async () => "granted",
    estimate: async () => ({ usage: null, quota: null }),
    appOrigin: FIXTURE_APP_ORIGIN,
    locks: null,
    ...extra,
  };
}
