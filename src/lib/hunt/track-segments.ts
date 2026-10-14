import { pathLength } from "./format.ts";
import type { Track, TrackPoint } from "./types.ts";

/**
 * A track's points split at recording gaps. Tracks without (or with invalid)
 * `segmentStarts` are one continuous segment, as before. A gap is never drawn
 * or measured as a straight line.
 */
export function trackSegments(track: Pick<Track, "points" | "segmentStarts">): TrackPoint[][] {
  const starts = track.segmentStarts ?? [];
  const valid =
    starts.every((start, index) => Number.isInteger(start) && start > 0 && start < track.points.length && (index === 0 || start > starts[index - 1]));
  if (!valid || starts.length === 0) return track.points.length ? [track.points] : [];
  const segments: TrackPoint[][] = [];
  let from = 0;
  for (const start of [...starts, track.points.length]) {
    const segment = track.points.slice(from, start);
    if (segment.length) segments.push(segment);
    from = start;
  }
  return segments;
}

/** Distance along the recorded segments in meters, not across gaps. */
export function trackLength(track: Pick<Track, "points" | "segmentStarts">): number {
  return trackSegments(track).reduce((sum, segment) => sum + pathLength(segment), 0);
}
