import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWeatherInput } from "./weather-input.ts";

describe("weather request coordinates", () => {
  it("uses the default map center when the location is omitted", () => {
    assert.deepEqual(parseWeatherInput({}), { lng: -111.38, lat: 33.95 });
  });

  it("rejects non-finite and out-of-range locations", () => {
    for (const input of [
      { lng: Number.POSITIVE_INFINITY, lat: 33 },
      { lng: 181, lat: 33 },
      { lng: -111, lat: -91 },
    ]) {
      assert.throws(() => parseWeatherInput(input), /Invalid weather/);
    }
  });
});
