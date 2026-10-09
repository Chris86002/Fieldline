import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidPersistedHuntState } from "./persistence.ts";

describe("saved hunt data validation", () => {
  it("accepts an empty store and the existing persisted shape", () => {
    assert.equal(isValidPersistedHuntState(null), true);
    assert.equal(
      isValidPersistedHuntState(JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 0 })),
      true,
    );
  });

  it("rejects malformed data without treating it as an empty store", () => {
    assert.equal(isValidPersistedHuntState("{"), false);
    assert.equal(isValidPersistedHuntState(JSON.stringify({ state: { waypoints: [] } })), false);
    assert.equal(
      isValidPersistedHuntState(JSON.stringify({ state: { waypoints: [], tracks: [] }, version: 1 })),
      false,
    );
  });
});
