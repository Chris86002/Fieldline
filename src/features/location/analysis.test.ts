import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accuracyDistribution,
  detectGaps,
  fixIntervals,
  fixesWithin,
  haversineM,
  overlapMs,
  pathLengthM,
  periodsBetween,
  stats,
  timeOrdered,
} from "./analysis.ts";

/** Fixture: a point every `step` ms walking north (~1.1 m per 1e-5° of latitude). */
function walk(from: number, count: number, step = 1000, startLat = 45) {
  return Array.from({ length: count }, (_, i) => ({ t: from + i * step, lng: -110, lat: startLat + i * 1e-5, accuracy: 5 + i }));
}

describe("location analysis", () => {
  it("measures distance with the haversine formula", () => {
    // One degree of latitude is about 111.2 km.
    assert.ok(Math.abs(haversineM({ lng: 0, lat: 0 }, { lng: 0, lat: 1 }) - 111_195) < 50);
    assert.equal(haversineM({ lng: -110, lat: 45 }, { lng: -110, lat: 45 }), 0);
  });

  it("summarizes values with nearest-rank percentiles and ignores non-finite ones", () => {
    const result = stats([5, 1, 3, 2, 4, Number.NaN]);
    assert.deepEqual(result, { count: 5, min: 1, max: 5, mean: 3, median: 3, p90: 5, p95: 5 });
    assert.equal(stats([1, 2, 3, 4]).median, 2.5);
    assert.deepEqual(stats([]), { count: 0, min: null, max: null, mean: null, median: null, p90: null, p95: null });
  });

  it("orders fixes by time and drops exact duplicates", () => {
    const ordered = timeOrdered([{ t: 3 }, { t: 1 }, { t: 3 }, { t: 2 }]);
    assert.deepEqual(
      ordered.map((fix) => fix.t),
      [1, 2, 3],
    );
  });

  it("finds gaps longer than the threshold, with their distance", () => {
    const before = walk(0, 5);
    const after = walk(64_000, 5, 1000, 45.001);
    const gaps = detectGaps([...after, ...before], 15_000);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].from, 4000);
    assert.equal(gaps[0].to, 64_000);
    assert.equal(gaps[0].durationMs, 60_000);
    // 45.00004 → 45.001: about 107 m.
    assert.ok(gaps[0].distanceM > 100 && gaps[0].distanceM < 115, String(gaps[0].distanceM));
    assert.deepEqual(detectGaps(before, 15_000), []);
    // A gap exactly at the threshold is not a gap.
    assert.deepEqual(detectGaps([walk(0, 1)[0], walk(15_000, 1)[0]], 15_000), []);
  });

  it("measures intervals and path length within segments only", () => {
    const a = walk(0, 3, 2000);
    const b = walk(100_000, 2, 1000);
    assert.deepEqual(fixIntervals([a, b]), [2000, 2000, 1000]);
    const within = pathLengthM([a]) + pathLengthM([b]);
    assert.ok(Math.abs(pathLengthM([a, b]) - within) < 1e-9);
    assert.ok(Math.abs(pathLengthM([a]) - 2 * haversineM(a[0], a[1])) < 1e-6);
  });

  it("buckets accuracy", () => {
    const result = accuracyDistribution([{ accuracy: 3 }, { accuracy: 5 }, { accuracy: 8 }, { accuracy: 30 }, { accuracy: 250 }]);
    assert.deepEqual(
      result.buckets.map((bucket) => bucket.count),
      [2, 1, 0, 1, 0, 1],
    );
    assert.equal(result.buckets[0].label, "≤5 m");
    assert.equal(result.buckets.at(-1)?.label, ">100 m");
    assert.equal(result.stats.median, 8);
  });

  it("pairs lifecycle signals into periods and closes an open one at the end", () => {
    const signals = [
      { at: 10, signal: "hidden" },
      { at: 15, signal: "hidden" },
      { at: 20, signal: "visible" },
      { at: 30, signal: "visible" },
      { at: 40, signal: "hidden" },
    ];
    assert.deepEqual(periodsBetween(signals, "hidden", "visible", 50), [
      { from: 10, to: 20 },
      { from: 40, to: 50 },
    ]);
    assert.equal(fixesWithin([{ t: 9 }, { t: 10 }, { t: 15 }, { t: 21 }], { from: 10, to: 20 }), 2);
    assert.equal(overlapMs({ from: 0, to: 45 }, [{ from: 10, to: 20 }, { from: 40, to: 50 }]), 15);
  });
});
