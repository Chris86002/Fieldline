import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundsContain, boundsOf, interiorPoint, polygonContains, polygonsContain } from "./unit-geometry.ts";

const square = (w: number, s: number, size: number) => [
  [w, s],
  [w + size, s],
  [w + size, s + size],
  [w, s + size],
  [w, s],
];

// Outer 0..10 with a hole 4..6, plus a second part 20..22.
const holed = [square(0, 0, 10), square(4, 4, 2)];
const second = [square(20, 20, 2)];
const multipart = [holed, second];

// U shape: the bounding-box centre and the vertex average both sit in the notch.
const uShape = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [7, 10],
    [7, 3],
    [3, 3],
    [3, 10],
    [0, 10],
    [0, 0],
  ],
];

describe("unit geometry", () => {
  it("treats a point in a hole as outside and a point in the second part as inside", () => {
    assert.equal(polygonsContain(multipart, 5, 5), false, "inside the hole");
    assert.equal(polygonsContain(multipart, 2, 2), true, "inside the first part");
    assert.equal(polygonsContain(multipart, 21, 21), true, "inside the second part");
    assert.equal(polygonsContain(multipart, 15, 15), false, "between the parts");
  });

  it("computes bounds across every part", () => {
    assert.deepEqual(boundsOf(multipart), { west: 0, south: 0, east: 22, north: 22 });
    assert.equal(boundsOf([]), null);
  });

  it("handles antimeridian-crossing bounds boxes", () => {
    const aleutians = { west: 170, south: 50, east: -170, north: 55 };
    assert.equal(boundsContain(aleutians, 179, 52), true);
    assert.equal(boundsContain(aleutians, -175, 52), true);
    assert.equal(boundsContain(aleutians, 0, 52), false);
  });

  it("places the label point inside a concave (U-shaped) polygon", () => {
    const vertices = uShape[0].slice(0, -1);
    const average = {
      lng: vertices.reduce((sum, p) => sum + p[0], 0) / vertices.length,
      lat: vertices.reduce((sum, p) => sum + p[1], 0) / vertices.length,
    };
    assert.equal(polygonContains(uShape, average.lng, average.lat), false, "fixture check: vertex average is outside");
    const label = interiorPoint([uShape]);
    assert.ok(label);
    assert.equal(polygonContains(uShape, label.lng, label.lat), true);
  });

  it("places the label point outside a hole and inside the largest part", () => {
    const donut = [square(0, 0, 10), square(2, 2, 6)];
    const label = interiorPoint([second, donut]);
    assert.ok(label);
    assert.equal(polygonContains(donut, label.lng, label.lat), true);
    assert.equal(polygonContains([square(2, 2, 6)], label.lng, label.lat), false, "not in the hole");
    const holedLabel = interiorPoint(multipart);
    assert.ok(holedLabel);
    assert.equal(polygonContains(holed, holedLabel.lng, holedLabel.lat), true);
  });

  it("returns null for empty geometry", () => {
    assert.equal(interiorPoint([]), null);
  });
});
