import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { radioKeyTarget, radioTabStop } from "./radio-keys.ts";

describe("radio group keyboard pattern", () => {
  it("moves and wraps with the arrow keys", () => {
    assert.equal(radioKeyTarget("ArrowRight", 0, 3), 1);
    assert.equal(radioKeyTarget("ArrowDown", 2, 3), 0);
    assert.equal(radioKeyTarget("ArrowLeft", 0, 3), 2);
    assert.equal(radioKeyTarget("ArrowUp", 1, 3), 0);
  });

  it("jumps with Home and End and ignores other keys", () => {
    assert.equal(radioKeyTarget("Home", 2, 3), 0);
    assert.equal(radioKeyTarget("End", 0, 3), 2);
    assert.equal(radioKeyTarget("Enter", 1, 3), null);
    assert.equal(radioKeyTarget("ArrowRight", 0, 0), null);
    // Nothing selected yet: arrows start from the first option.
    assert.equal(radioKeyTarget("ArrowRight", -1, 2), 1);
  });

  it("keeps one tab stop: the selected option, else the first", () => {
    assert.deepEqual([0, 1, 2].map((i) => radioTabStop(1, i)), [-1, 0, -1]);
    assert.deepEqual([0, 1, 2].map((i) => radioTabStop(-1, i)), [0, -1, -1]);
  });
});
