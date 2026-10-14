import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { canStoreTile, packTiles, purgeRestrictedTiles, TILES, tileCacheLabel } from "./tiles.ts";

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const originalFetch = globalThis.fetch;
const entries = new Map<string, Response>();

function setCacheAvailable(available: boolean) {
  if (!available) {
    Reflect.deleteProperty(globalThis, "caches");
    return;
  }
  const cache = {
    async match(key: RequestInfo | URL) {
      return entries.get(String(key));
    },
    async put(key: RequestInfo | URL, response: Response) {
      entries.set(String(key), response);
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
    async delete(key: RequestInfo | URL) {
      return entries.delete(key instanceof Request ? key.url : String(key));
    },
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { open: async () => cache },
  });
}

afterEach(() => {
  entries.clear();
  globalThis.fetch = originalFetch;
  if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
  else Reflect.deleteProperty(globalThis, "caches");
});

describe("offline map tile packs", () => {
  it("counts cached, new, and failed tiles accurately while reporting progress", async () => {
    setCacheAvailable(true);
    const bounds = { west: 0.01, east: 0.02, south: 0.01, north: 0.02, zoom: 8 };
    entries.set(
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/8/127/128",
      new Response("cached"),
    );
    globalThis.fetch = async (input) => {
      const url = String(input);
      return url.includes("USGSTopo") ? new Response("unavailable", { status: 503 }) : new Response("tile");
    };
    const progress: number[] = [];
    const result = await packTiles({
      ...bounds,
      templates: [TILES.imagery, TILES.topo, TILES.sma],
      onProgress: (done) => progress.push(done),
    });
    assert.deepEqual(result, { saved: 1, reused: 1, failed: 1, total: 3, skipped: false });
    assert.deepEqual(progress, [1, 2, 3]);
  });

  it("rejects oversized views before making requests or allocating a tile list", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("tile");
    };
    const result = await packTiles({
      west: -180,
      east: 180,
      south: -85,
      north: 85,
      zoom: 15,
      templates: [TILES.imagery],
    });
    assert.equal(result.skipped, true);
    assert.ok(result.total > 220);
    assert.equal(fetched, false);
  });

  it("reports cache unavailability without retrying each tile over the network", async () => {
    setCacheAvailable(false);
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("tile");
    };
    const result = await packTiles({
      west: 0.01,
      east: 0.02,
      south: 0.01,
      north: 0.02,
      zoom: 8,
      templates: [TILES.imagery],
    });
    assert.deepEqual(result, { saved: 0, reused: 0, failed: 1, total: 1, skipped: false });
    assert.equal(fetched, false);
  });

  it("never stores or pre-fetches Esri imagery, whose terms forbid it", async () => {
    setCacheAvailable(true);
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("tile");
    };
    assert.equal(canStoreTile("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/8/1/1"), false);
    assert.equal(canStoreTile("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/8/1/1"), true);
    assert.equal(canStoreTile("https://basemap.nationalmap.gov.evil.example/arcgis/rest/services/USGSTopo/MapServer/tile/8/1/1"), false);
    const result = await packTiles({ west: 0.01, east: 0.02, south: 0.01, north: 0.02, zoom: 8, templates: [TILES.satellite] });
    assert.equal(result.skipped, true);
    assert.equal(fetched, false);
    assert.equal(entries.size, 0);
  });

  it("removes Esri tiles stored by older builds and keeps permitted ones", async () => {
    setCacheAvailable(true);
    const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/8/127/128";
    const topo = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/8/127/128";
    entries.set(esri, new Response("esri"));
    entries.set(topo, new Response("topo"));
    assert.equal(await purgeRestrictedTiles(), 1);
    assert.deepEqual([...entries.keys()], [topo]);
  });

  it("labels only Fieldline tile entries rather than total origin storage", async () => {
    setCacheAvailable(true);
    entries.set("https://example.com/tile", new Response("tile"));
    assert.equal(await tileCacheLabel(), "1 map tile saved on this device");
  });
});
