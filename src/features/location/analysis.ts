/**
 * Pure helpers for judging a location stream: gaps between fixes, interval
 * and accuracy statistics, and how fixes line up with lifecycle periods
 * (page hidden, timers paused). Used by the phone field-test report; CC-06
 * can reuse them for recording-gap handling.
 *
 * A gap here means "no fix was delivered for longer than the threshold". On
 * some platforms a stationary phone also delivers fixes rarely, so field
 * tests should be walked, and the interval distribution is reported too.
 */

export type TimedPoint = { t: number; lng: number; lat: number; accuracy: number };

export type Gap = {
  /** Time of the last fix before the gap. */
  from: number;
  /** Time of the first fix after it. */
  to: number;
  durationMs: number;
  /** Straight-line distance between the fixes either side, meters. */
  distanceM: number;
};

export type Stats = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p90: number | null;
  p95: number | null;
};

export type Period = { from: number; to: number };

/** Default gap threshold: the main app's watch timeout. */
export const DEFAULT_GAP_MS = 15_000;

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest-rank percentile of an ascending list (p in 0–100). */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function stats(values: readonly number[]): Stats {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, max: null, mean: null, median: null, p90: null, p95: null };
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mid = sorted.length >> 1;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
}

/** Fixes in time order with exact duplicates (same time) removed. */
export function timeOrdered<T extends { t: number }>(fixes: readonly T[]): T[] {
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  return sorted.filter((fix, index) => index === 0 || fix.t !== sorted[index - 1].t);
}

/** Intervals between consecutive fixes, ms, within each segment (never across a segment break). */
export function fixIntervals(segments: readonly (readonly { t: number }[])[]): number[] {
  const out: number[] = [];
  for (const segment of segments) {
    const ordered = timeOrdered(segment);
    for (let i = 1; i < ordered.length; i += 1) out.push(ordered[i].t - ordered[i - 1].t);
  }
  return out;
}

/**
 * Gaps longer than `thresholdMs` between consecutive fixes, across segment
 * breaks too: a recording that was interrupted and resumed has a gap even
 * though the store started a new segment.
 */
export function detectGaps(fixes: readonly TimedPoint[], thresholdMs = DEFAULT_GAP_MS): Gap[] {
  const ordered = timeOrdered(fixes);
  const gaps: Gap[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const a = ordered[i - 1];
    const b = ordered[i];
    const durationMs = b.t - a.t;
    if (durationMs > thresholdMs) gaps.push({ from: a.t, to: b.t, durationMs, distanceM: haversineM(a, b) });
  }
  return gaps;
}

/** Path length, meters, summed within segments only. */
export function pathLengthM(segments: readonly (readonly { lng: number; lat: number; t: number }[])[]): number {
  let total = 0;
  for (const segment of segments) {
    const ordered = timeOrdered(segment);
    for (let i = 1; i < ordered.length; i += 1) total += haversineM(ordered[i - 1], ordered[i]);
  }
  return total;
}

export const ACCURACY_BUCKETS = [5, 10, 20, 50, 100] as const;

export type AccuracyDistribution = {
  stats: Stats;
  /** Counts with accuracy ≤ each limit (exclusive of the lower bucket), plus "over" the last limit. */
  buckets: { label: string; count: number }[];
};

export function accuracyDistribution(fixes: readonly { accuracy: number }[]): AccuracyDistribution {
  const values = fixes.map((fix) => fix.accuracy);
  const counts = new Array<number>(ACCURACY_BUCKETS.length + 1).fill(0);
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const index = ACCURACY_BUCKETS.findIndex((limit) => value <= limit);
    counts[index === -1 ? ACCURACY_BUCKETS.length : index] += 1;
  }
  const labels = ACCURACY_BUCKETS.map((limit, index) => (index === 0 ? `≤${limit} m` : `${ACCURACY_BUCKETS[index - 1]}–${limit} m`));
  labels.push(`>${ACCURACY_BUCKETS[ACCURACY_BUCKETS.length - 1]} m`);
  return { stats: stats(values), buckets: labels.map((label, index) => ({ label, count: counts[index] })) };
}

/**
 * Periods between a start signal and the next end signal, from a time-ordered
 * signal list. An open period is closed at `endAt`. Used for "page hidden"
 * (hidden → visible) and "frozen" (freeze → resume) periods.
 */
export function periodsBetween(
  signals: readonly { at: number; signal: string }[],
  start: string,
  end: string,
  endAt: number,
): Period[] {
  const periods: Period[] = [];
  let open: number | null = null;
  for (const item of [...signals].sort((a, b) => a.at - b.at)) {
    if (item.signal === start && open == null) open = item.at;
    else if (item.signal === end && open != null) {
      periods.push({ from: open, to: item.at });
      open = null;
    }
  }
  if (open != null && endAt > open) periods.push({ from: open, to: endAt });
  return periods;
}

/** Fixes whose time falls inside the period (inclusive). */
export function fixesWithin(fixes: readonly { t: number }[], period: Period): number {
  let count = 0;
  for (const fix of fixes) if (fix.t >= period.from && fix.t <= period.to) count += 1;
  return count;
}

/** Total overlap, ms, between a gap and a list of periods. */
export function overlapMs(gap: Period, periods: readonly Period[]): number {
  let total = 0;
  for (const period of periods) {
    const from = Math.max(gap.from, period.from);
    const to = Math.min(gap.to, period.to);
    if (to > from) total += to - from;
  }
  return total;
}
