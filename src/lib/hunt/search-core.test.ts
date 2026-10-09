import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearPlaceSearchCacheForTests,
  parseSearchInput,
  searchPlaceResults,
} from "./search-core.ts";

afterEach(() => clearPlaceSearchCacheForTests());

describe("place search input", () => {
  it("trims and bounds queries while applying the default map center", () => {
    assert.deepEqual(parseSearchInput({ q: ` ${"a".repeat(100)} ` }), {
      q: "a".repeat(80),
      lng: -111.38,
      lat: 33.95,
    });
  });

  it("rejects non-finite and out-of-range coordinates", () => {
    for (const input of [
      { q: "ridge", lng: Number.NaN, lat: 33 },
      { q: "ridge", lng: 181, lat: 33 },
      { q: "ridge", lng: -111, lat: -91 },
    ]) {
      assert.throws(() => parseSearchInput(input), /Invalid search/);
    }
  });

  it("does not request a place for a query shorter than two characters", async () => {
    let called = false;
    const result = await searchPlaceResults(
      { q: "x" },
      { fetcher: async () => {
        called = true;
        return Response.json([]);
      } },
    );
    assert.deepEqual(result, []);
    assert.equal(called, false);
  });
});

describe("place search providers", () => {
  it("uses cached, range-validated Nominatim results", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      assert.equal(url.hostname, "nominatim.openstreetmap.org");
      assert.equal(url.searchParams.get("q"), "four peaks");
      return Response.json([
        { place_id: 1, display_name: "Four Peaks, Arizona", lat: "33.7", lon: "-111.3" },
        { place_id: 2, display_name: "Bad point", lat: "91", lon: "0" },
      ]);
    };
    const input = { q: "four peaks", lng: -111.38, lat: 33.95 };
    const first = await searchPlaceResults(input, { fetcher, minNominatimIntervalMs: 0 });
    const second = await searchPlaceResults(input, { fetcher, minNominatimIntervalMs: 0 });
    assert.deepEqual(first, [
      { id: "n-1", name: "Four Peaks", detail: "Arizona", lng: -111.3, lat: 33.7 },
    ]);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });

  it("falls back to Photon when Nominatim has no match", async () => {
    const hosts: string[] = [];
    const results = await searchPlaceResults(
      { q: "ridge", lng: -111, lat: 34 },
      {
        minNominatimIntervalMs: 0,
        fetcher: async (input) => {
          hosts.push(new URL(String(input)).hostname);
          return hosts.length === 1
            ? Response.json([])
            : Response.json({
                features: [
                  {
                    geometry: { coordinates: [-111.2, 34.2] },
                    properties: { name: "Ridge", city: "Payson", state: "Arizona", countrycode: "us" },
                  },
                  {
                    geometry: { coordinates: [190, 34] },
                    properties: { name: "Invalid", countrycode: "us" },
                  },
                ],
              });
        },
      },
    );
    assert.deepEqual(hosts, ["nominatim.openstreetmap.org", "photon.komoot.io"]);
    assert.deepEqual(results, [
      { id: "p-0-Ridge", name: "Ridge", detail: "Payson, Arizona", lng: -111.2, lat: 34.2 },
    ]);
  });
});
