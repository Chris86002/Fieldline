import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HuntUnit } from "./types.ts";
import {
  cacheUnitStorage,
  checkCandidate,
  createUnitStore,
  DAY_MS,
  memoryUnitStorage,
  parseSnapshot,
  UNIT_CACHE_NAME,
  UnitValidationError,
  type UnitCandidate,
  type UnitDownload,
} from "./unit-store.ts";

const COVERAGE = [{ west: -115, south: 31, east: -109, north: 37 }];

/** FIXTURE unit: a small square inside the coverage box. */
function unit(code: string, i = Number(code)): HuntUnit {
  const w = -114 + (i % 10) * 0.3;
  const s = 32 + Math.floor(i / 10) * 0.3;
  return {
    id: `us-az:test-gmu:${code}`,
    jurisdictionId: "us-az",
    providerId: "test-gmu",
    sourceFeatureId: code,
    code,
    label: `Unit ${code}`,
    regionName: "",
    speciesTags: [],
    seasonContext: null,
    landNote: "",
    forest: "",
    sqMiles: null,
    bounds: { west: w, south: s, east: w + 0.2, north: s + 0.2 },
    labelPoint: { lng: w + 0.1, lat: s + 0.1 },
    polygons: [
      [
        [
          [w, s],
          [w + 0.2, s],
          [w + 0.2, s + 0.2],
          [w, s + 0.2],
          [w, s],
        ],
      ],
    ],
  };
}

function candidate(n: number, extra: Partial<UnitCandidate> = {}): UnitCandidate {
  const units = Array.from({ length: n }, (_, i) => unit(String(i + 1)));
  return { units, featureCount: n, expectedCount: n, sourceVersion: "v1", ...extra };
}

function makeStore(download: UnitDownload, start = Date.UTC(2026, 9, 1)) {
  const state = { t: start };
  const storage = memoryUnitStorage();
  const store = createUnitStore({
    providerId: "test-gmu",
    title: "FIXTURE hunt units",
    coverage: COVERAGE,
    transform: "t1",
    download,
    storage,
    now: () => state.t,
  });
  return { store, storage, state };
}

describe("unit store", () => {
  it("degrades gracefully when Cache Storage is unavailable", async () => {
    assert.equal(typeof (globalThis as { caches?: unknown }).caches, "undefined", "Node has no Cache Storage");
    const storage = cacheUnitStorage();
    assert.equal(await storage.read("x"), null);
    assert.equal(await storage.write({ manifest: { providerId: "x" } as never, units: [] }), false);
    await storage.quarantine({ providerId: "x" } as never);
    assert.equal(UNIT_CACHE_NAME, "fieldline-units-v3");
  });

  it("promotes a valid download and serves it from storage in a new session", async () => {
    const { store, storage, state } = makeStore(async () => candidate(3));
    assert.equal((await store.load()).status, "available");
    const reopened = createUnitStore({
      providerId: "test-gmu",
      title: "FIXTURE hunt units",
      coverage: COVERAGE,
      transform: "t1",
      storage,
      now: () => state.t + DAY_MS,
      download: async () => {
        throw new Error("must not download a fresh copy");
      },
    });
    const result = await reopened.load();
    assert.equal(result.status, "available");
    assert.equal(result.units.length, 3);
  });

  it("refreshes a stored copy built with different transformation settings", async () => {
    const { store, storage, state } = makeStore(async () => candidate(3));
    await store.load();
    let downloads = 0;
    const changed = createUnitStore({
      providerId: "test-gmu",
      title: "FIXTURE hunt units",
      coverage: COVERAGE,
      transform: "t2",
      storage,
      now: () => state.t,
      download: async () => {
        downloads += 1;
        return candidate(3);
      },
    });
    assert.equal((await changed.load()).status, "available");
    assert.equal(downloads, 1);
  });

  it("ignores stored copies from another schema version or provider", () => {
    const good = { manifest: { schemaVersion: 3, providerId: "test-gmu", retrievedAt: 1, checkedAt: 1, sourceVersion: null, featureCount: 1, expectedCount: 1, unitCount: 1, transform: "t1" }, units: [unit("1")] };
    assert.ok(parseSnapshot(good, "test-gmu", COVERAGE));
    assert.equal(parseSnapshot({ ...good, manifest: { ...good.manifest, schemaVersion: 2 } }, "test-gmu", COVERAGE), null);
    assert.equal(parseSnapshot(good, "other", COVERAGE), null);
    assert.equal(parseSnapshot({ ...good, units: [{ ...unit("1"), polygons: [[[[0, 0]]]] }] }, "test-gmu", COVERAGE), null);
    // The old v2 cache format (raw GeoJSON) is not accepted.
    assert.equal(parseSnapshot({ type: "FeatureCollection", features: [] }, "test-gmu", COVERAGE), null);
  });

  it("checks counts, coverage, duplicates and drops before promotion", () => {
    const base = { providerId: "test-gmu", coverage: COVERAGE, previous: null, maxDropRatio: 0.2 };
    assert.equal(checkCandidate(candidate(3), base), null);
    assert.match(checkCandidate(candidate(3, { expectedCount: 4 }), base) ?? "", /3 of 4/);
    assert.match(checkCandidate(candidate(3, { expectedCount: 2 }), base) ?? "", /provider counts 2/);
    assert.match(checkCandidate(candidate(0), base) ?? "", /no features/);
    const dup = candidate(2);
    dup.units[1] = { ...dup.units[0] };
    assert.match(checkCandidate(dup, base) ?? "", /appears twice/);
    const previous = { manifest: {} as never, units: candidate(10).units };
    assert.match(checkCandidate(candidate(7), { ...base, previous }) ?? "", /fell from 10 to 7/);
    assert.equal(checkCandidate(candidate(8), { ...base, previous }), null);
  });

  it("waits before retrying after a failure, then retries", async () => {
    let calls = 0;
    const { store, state } = makeStore(async () => {
      calls += 1;
      if (calls === 1) throw new UnitValidationError("the service no longer lists the field \"GMU\"");
      return candidate(3);
    });
    const first = await store.load();
    assert.equal(first.status, "unavailable");
    assert.match(first.message ?? "", /GMU/);
    assert.equal(store.lastRejection()?.reason.includes("GMU"), true);
    const cooling = await store.load();
    assert.equal(cooling.status, "unavailable");
    assert.equal(calls, 1, "no request during the retry window");
    state.t += 6 * 60 * 1000;
    assert.equal((await store.load()).status, "available");
    assert.equal(calls, 2);
  });

  it("keeps a shared load running when only one of two callers aborts", async () => {
    let release: (value: UnitCandidate) => void = () => {};
    let seen: AbortSignal | null = null;
    const { store } = makeStore(({ signal }) => {
      seen = signal;
      return new Promise((resolve) => (release = resolve));
    });
    const controller = new AbortController();
    const aborted = store.load(controller.signal);
    const kept = store.load(new AbortController().signal);
    controller.abort();
    await assert.rejects(aborted, { name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((seen as AbortSignal | null)?.aborted, false);
    release(candidate(2));
    assert.equal((await kept).status, "available");
  });

  it("cancels the download when every caller aborts", async () => {
    let seen: AbortSignal | null = null;
    const { store } = makeStore(({ signal }) => {
      seen = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))));
    });
    const controller = new AbortController();
    const pending = store.load(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal((seen as AbortSignal | null)?.aborted, true);
    assert.equal(store.lastRejection(), null, "a cancellation is not a rejection");
  });
});
