import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundsOfPoints,
  containsPoint,
  crossesAntimeridian,
  intersects,
  isValidBounds,
  isValidLngLat,
  normalizeBounds,
  normalizeLng,
  splitAntimeridian,
  WORLD_BOUNDS,
} from "./bounds.ts";

const box = (west: number, south: number, east: number, north: number) => ({
  west,
  south,
  east,
  north,
});

describe("normalizeLng", () => {
  it("wraps out-of-range longitudes and keeps in-range ones, including ±180", () => {
    assert.equal(normalizeLng(190), -170);
    assert.equal(normalizeLng(-190), 170);
    assert.equal(normalizeLng(370), 10);
    assert.equal(normalizeLng(-725), -5);
    assert.equal(normalizeLng(180), 180);
    assert.equal(normalizeLng(-180), -180);
    assert.equal(normalizeLng(-112.5), -112.5);
    assert.ok(Number.isNaN(normalizeLng(Number.NaN)));
    assert.ok(Number.isNaN(normalizeLng(Infinity)));
  });
});

describe("validity", () => {
  it("accepts plain and antimeridian-crossing boxes and rejects broken ones", () => {
    assert.equal(isValidBounds(box(-114, 31, -109, 37)), true);
    assert.equal(isValidBounds(box(170, 50, -170, 55)), true);
    assert.equal(isValidBounds(box(-10, 5, 10, 4)), false, "south > north");
    assert.equal(isValidBounds(box(-200, 0, 10, 1)), false, "longitude out of range");
    assert.equal(isValidBounds(box(0, -91, 1, 1)), false, "latitude out of range");
    assert.equal(isValidBounds(box(Number.NaN, 0, 1, 1)), false);
    assert.equal(isValidLngLat({ lng: 179.5, lat: 51.8 }), true);
    assert.equal(isValidLngLat({ lng: 181, lat: 0 }), false);
  });
});

describe("splitAntimeridian", () => {
  it("splits a crossing box into its two plain halves", () => {
    const parts = splitAntimeridian(box(170, 50, -170, 55));
    assert.deepEqual(parts, [box(170, 50, 180, 55), box(-180, 50, -170, 55)]);
    assert.equal(crossesAntimeridian(box(170, 50, -170, 55)), true);
  });

  it("returns a plain box unchanged", () => {
    const plain = box(-114, 31, -109, 37);
    assert.deepEqual(splitAntimeridian(plain), [plain]);
    assert.equal(crossesAntimeridian(plain), false);
  });
});

describe("intersects", () => {
  const view = box(170, 50, -170, 55); // crosses 180 near the Aleutians

  it("handles plain boxes", () => {
    assert.equal(intersects(box(0, 0, 10, 10), box(5, 5, 15, 15)), true);
    assert.equal(intersects(box(0, 0, 10, 10), box(10, 10, 20, 20)), true, "shared corner");
    assert.equal(intersects(box(0, 0, 10, 10), box(11, 0, 20, 10)), false);
    assert.equal(intersects(box(0, 0, 10, 10), box(0, 11, 10, 20)), false);
  });

  it("matches a crossing view against plain boxes on either side of 180", () => {
    assert.equal(intersects(view, box(172.34, 51.29, 179.86, 53.07)), true, "west of 180");
    assert.equal(intersects(view, box(-179.24, 51.17, -129.97, 71.44)), true, "east of 180");
    assert.equal(intersects(box(-179.24, 51.17, -129.97, 71.44), view), true, "argument order");
    assert.equal(intersects(view, box(-160, 50, -150, 55)), false, "east, outside the view");
    assert.equal(intersects(view, box(150, 50, 169, 55)), false, "west, outside the view");
    assert.equal(intersects(view, box(-179, 60, -175, 65)), false, "latitude miss");
  });

  it("matches a crossing provider box against plain views", () => {
    const provider = box(172, 51, -129, 72);
    assert.equal(intersects(provider, box(-150, 60, -140, 65)), true);
    assert.equal(intersects(provider, box(175, 51, 178, 53)), true);
    assert.equal(intersects(provider, box(0, 51, 10, 60)), false);
    assert.equal(intersects(provider, box(-120, 51, -110, 60)), false);
  });

  it("matches two crossing boxes", () => {
    assert.equal(intersects(view, box(179, 51, -179, 52)), true);
  });

  it("does not let a continental box reach across the antimeridian", () => {
    const conus = box(-124.85, 24.39, -66.88, 49.39);
    assert.equal(intersects(conus, view), false);
    assert.equal(intersects(conus, WORLD_BOUNDS), true);
  });
});

describe("containsPoint", () => {
  it("handles a crossing box on both sides and at 180", () => {
    const aleutians = box(170, 50, -170, 55);
    assert.equal(containsPoint(aleutians, { lng: 179.5, lat: 51.8 }), true);
    assert.equal(containsPoint(aleutians, { lng: -179.5, lat: 51.8 }), true);
    assert.equal(containsPoint(aleutians, { lng: 180, lat: 51.8 }), true);
    assert.equal(containsPoint(aleutians, { lng: -180, lat: 51.8 }), true);
    assert.equal(containsPoint(aleutians, { lng: 0, lat: 51.8 }), false);
    assert.equal(containsPoint(aleutians, { lng: 179.5, lat: 49 }), false);
  });

  it("wraps the point and treats ±180 as one meridian", () => {
    assert.equal(containsPoint(box(-175, 0, -165, 10), { lng: 190, lat: 5 }), true);
    assert.equal(containsPoint(box(170, 0, 180, 10), { lng: -180, lat: 5 }), true);
    assert.equal(containsPoint(box(-180, 0, -170, 10), { lng: 180, lat: 5 }), true);
    assert.equal(containsPoint(box(-10, 0, 10, 10), { lng: Number.NaN, lat: 5 }), false);
  });
});

describe("normalizeBounds", () => {
  it("converts a wrapped viewport into contract form", () => {
    assert.deepEqual(normalizeBounds(box(170, 50, 190, 55)), box(170, 50, -170, 55));
    assert.deepEqual(normalizeBounds(box(-190, 50, -170, 55)), box(170, 50, -170, 55));
    assert.deepEqual(normalizeBounds(box(-200, -95, 200, 95)), WORLD_BOUNDS);
  });

  it("passes contract-form boxes through and rejects broken ones", () => {
    assert.deepEqual(normalizeBounds(box(170, 50, -170, 55)), box(170, 50, -170, 55));
    assert.deepEqual(normalizeBounds(box(-114, 31, -109, 37)), box(-114, 31, -109, 37));
    assert.equal(normalizeBounds(box(0, 10, 1, 5)), null);
    assert.equal(normalizeBounds(box(0, Number.NaN, 1, 5)), null);
  });
});

describe("boundsOfPoints", () => {
  it("returns the plain extent of nearby points", () => {
    const b = boundsOfPoints([
      { lng: -112, lat: 33 },
      { lng: -110, lat: 35 },
      { lng: -111, lat: 31.5 },
    ]);
    assert.deepEqual(b, box(-112, 31.5, -110, 35));
  });

  it("takes the short way across the antimeridian", () => {
    const b = boundsOfPoints([
      { lng: 179, lat: 51 },
      { lng: -179, lat: 52 },
      { lng: 178, lat: 51.5 },
    ]);
    assert.deepEqual(b, box(178, 51, -179, 52));
    assert.equal(b && crossesAntimeridian(b), true);
  });

  it("returns null for no points or an invalid point", () => {
    assert.equal(boundsOfPoints([]), null);
    assert.equal(boundsOfPoints([{ lng: 0, lat: 91 }]), null);
    assert.equal(boundsOfPoints([{ lng: Number.NaN, lat: 0 }]), null);
  });

  it("gives a zero-size box for one point", () => {
    assert.deepEqual(boundsOfPoints([{ lng: 10, lat: 20 }]), box(10, 20, 10, 20));
  });
});
