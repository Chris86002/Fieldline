import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toGpx } from "./gpx.ts";
import { trackLength, trackSegments } from "./track-segments.ts";
import type { Track } from "./types.ts";

// Test fixture: five points along a parallel, with a gap after the third.
const points = [0, 1, 2, 10, 11].map((i) => ({ lng: -111 + i * 0.001, lat: 34, t: 1_000 * (i + 1) }));
const gapped: Track = { id: "t1", name: "Gap", points, createdAt: 1, visible: true, segmentStarts: [3] };

describe("track segments", () => {
  it("splits at recording gaps", () => {
    assert.deepEqual(
      trackSegments(gapped).map((segment) => segment.length),
      [3, 2],
    );
  });

  it("treats tracks without gaps, or with invalid gap data, as one line", () => {
    assert.equal(trackSegments({ points }).length, 1);
    assert.equal(trackSegments({ points, segmentStarts: [9] }).length, 1);
    assert.equal(trackSegments({ points, segmentStarts: [3, 2] }).length, 1);
  });

  it("doesn't count the straight jump across a gap as distance", () => {
    const continuous = trackLength({ points });
    const withGap = trackLength(gapped);
    assert.ok(withGap < continuous, "the gap is not walked distance");
    // Two short segments of 2 and 1 steps of ~92 m each.
    assert.ok(Math.abs(withGap - 3 * 92.2) < 5, `got ${withGap}`);
  });

  it("exports each segment as its own GPX trkseg", () => {
    const gpx = toGpx([], [gapped]);
    assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 2);
    assert.equal((toGpx([], [{ ...gapped, segmentStarts: undefined }]).match(/<trkseg>/g) ?? []).length, 1);
  });
});
