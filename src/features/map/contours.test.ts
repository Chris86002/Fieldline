import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTOUR_MIN_MAP_ZOOM,
  CONTOUR_SOURCE_MAX_ZOOM,
  CONTOUR_TILE_ZOOM_OFFSET,
  contourIntervalAt,
  contourIntervalText,
  contourLabel,
  contourThresholds,
  contourTileOptions,
  DEM_MAX_ZOOM,
  DEM_ZOOM_OFFSET,
  FEET_PER_METER,
  smoothElevation,
  type ContourDetail,
} from "./contours.ts";

const DETAILS: ContourDetail[] = ["coarse", "standard", "fine"];

describe("contour intervals", () => {
  it("follow the elevation unit with standard round steps", () => {
    assert.deepEqual(contourIntervalAt(13, "ft", "standard"), [40, 200]);
    assert.deepEqual(contourIntervalAt(13, "m", "standard"), [20, 100]);
    assert.deepEqual(contourIntervalAt(10, "ft", "standard"), [500, 2500]);
    assert.deepEqual(contourIntervalAt(14.7, "ft", "standard"), [20, 100]);
    assert.equal(contourIntervalAt(9, "ft", "standard"), null, "no contours at regional scale");
  });

  it("get closer as you zoom in, with an index line every fifth line", () => {
    for (const unit of ["ft", "m"] as const) {
      for (const detail of DETAILS) {
        let previous = Infinity;
        for (let zoom = 8; zoom <= 18; zoom += 1) {
          const interval = contourIntervalAt(zoom, unit, detail);
          if (!interval) continue;
          assert.equal(interval[1], interval[0] * 5, `${unit} ${detail} z${zoom}`);
          assert.ok(interval[0] <= previous, `${unit} ${detail} z${zoom} not coarser than before`);
          previous = interval[0];
        }
      }
    }
  });

  it("shift one zoom with the detail setting, never finer than the finest step", () => {
    assert.deepEqual(contourIntervalAt(12, "ft", "fine"), contourIntervalAt(13, "ft", "standard"));
    assert.deepEqual(contourIntervalAt(13, "ft", "coarse"), contourIntervalAt(12, "ft", "standard"));
    assert.deepEqual(contourIntervalAt(16, "m", "fine"), [10, 50]);
    assert.equal(contourIntervalAt(10, "ft", "coarse"), null);
    assert.deepEqual(contourIntervalAt(9, "ft", "fine"), [500, 2500]);
  });

  it("key thresholds by contour tile zoom (512-pixel tiles at the map zoom)", () => {
    assert.equal(CONTOUR_TILE_ZOOM_OFFSET, 0);
    for (const unit of ["ft", "m"] as const) {
      for (const detail of DETAILS) {
        const thresholds = contourThresholds(unit, detail);
        for (const [tileZoom, interval] of Object.entries(thresholds)) {
          assert.deepEqual(interval, contourIntervalAt(Number(tileZoom), unit, detail));
          assert.ok(Number(tileZoom) >= CONTOUR_MIN_MAP_ZOOM && Number(tileZoom) <= CONTOUR_SOURCE_MAX_ZOOM, tileZoom);
        }
      }
    }
    assert.deepEqual(Object.keys(contourThresholds("ft", "standard")).map(Number), [10, 11, 12, 13, 14, 15]);
    // Traced from the DEM tile with the same z/x/y (packages hold map zoom − 1 … + 1), one split past the deepest.
    assert.equal(DEM_ZOOM_OFFSET, 0);
    assert.equal(CONTOUR_SOURCE_MAX_ZOOM, DEM_MAX_ZOOM + 1);
  });

  it("scale the DEM's meters to feet before tracing, so lines sit on whole feet", () => {
    assert.equal(contourTileOptions("ft", "standard").multiplier, FEET_PER_METER);
    assert.equal(contourTileOptions("m", "standard").multiplier, 1);
    const options = contourTileOptions("m", "fine");
    assert.equal(options.contourLayer, "contours");
    assert.equal(options.elevationKey, "ele");
    assert.equal(options.levelKey, "level");
  });

  it("smooths a copy of the DEM for tracing without shifting plains or slopes", () => {
    const width = 8;
    const height = 6;
    // A uniform slope stays exactly the same away from the edges, and a flat tile stays flat.
    const slope = { width, height, data: Float32Array.from({ length: width * height }, (_, i) => 100 + 10 * (i % width)) };
    const smoothed = smoothElevation(slope, 2);
    for (let y = 0; y < height; y += 1) for (let x = 2; x < width - 2; x += 1) assert.equal(smoothed.data[y * width + x], slope.data[y * width + x]);
    const flat = smoothElevation({ width, height, data: new Float32Array(width * height).fill(1234) });
    assert.ok(flat.data.every((value) => value === 1234));
    // A one-pixel spike is spread out, and the input is not modified.
    const spike = { width, height, data: new Float32Array(width * height) };
    spike.data[3 * width + 4] = 16;
    const spread = smoothElevation(spike, 1);
    assert.equal(spread.data[3 * width + 4], 4);
    assert.equal(spread.data[2 * width + 4], 2);
    assert.equal(spike.data[3 * width + 4], 16);
  });

  it("labels and describes intervals in the unit", () => {
    assert.deepEqual(contourLabel(), ["to-string", ["get", "ele"]]);
    // The tile URL changes with the unit, so labels and lines are traced in that unit.
    assert.notDeepEqual(contourTileOptions("ft", "standard"), contourTileOptions("m", "standard"));
    assert.deepEqual(contourTileOptions("m", "standard").thresholds[13], [20, 100]);
    assert.equal(contourIntervalText(13.2, "ft", "standard"), "40 ft lines, index every 200 ft at this zoom.");
    assert.equal(contourIntervalText(6, "m", "standard"), "Zoom in to see contours.");
  });
});
