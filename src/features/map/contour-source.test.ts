import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAILED_TILE_MEMORY_MS, FieldlineDemManager, fltileGetTile, noNetwork, type GetTile } from "./contour-source.ts";

const TEMPLATE = "https://dem.test/{z}/{x}/{y}";
const SIZE = 8;
const LEVELS = { levels: [50, 250] };

/** A DEM that rises 10 m per pixel eastward, continuous across tiles. */
async function decodeImage(blob: Blob) {
  const [, , x] = (await blob.text()).match(/(\d+)\/(\d+)\/(\d+)$/)!.slice(1).map(Number);
  const data = new Float32Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py += 1) for (let px = 0; px < SIZE; px += 1) data[py * SIZE + px] = (x * SIZE + px) * 10;
  return { width: SIZE, height: SIZE, data };
}

/** getTile that serves every URL except those `fail` names, counting calls per URL. */
function stubTiles(fail: (url: string) => unknown = () => null) {
  const calls = new Map<string, number>();
  const getTile: GetTile = async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const error = fail(url);
    if (error) throw error;
    return { data: new Blob([url]) };
  };
  return { getTile, calls };
}

const url = (z: number, x: number, y: number) => `https://dem.test/${z}/${x}/${y}`;

function manager(getTile: GetTile, extra: Partial<ConstructorParameters<typeof FieldlineDemManager>[0]> = {}) {
  return new FieldlineDemManager({ demTemplate: TEMPLATE, getTile, decodeImage: decodeImage as never, ...extra });
}

describe("contour tile manager", () => {
  it("returns an empty tile without fetching any DEM when the zoom has no contour levels", async () => {
    const { getTile, calls } = stubTiles();
    const tile = await manager(getTile).fetchContourTile(9, 100, 200, { levels: [] }, new AbortController());
    assert.equal(tile.arrayBuffer.byteLength, 0);
    assert.equal(calls.size, 0);
  });

  it("traces a tile from the DEM tile with the same z/x/y and its eight neighbors", async () => {
    const { getTile, calls } = stubTiles();
    const tile = await manager(getTile).fetchContourTile(10, 5, 5, LEVELS, new AbortController());
    assert.ok(tile.arrayBuffer.byteLength > 0, "lines were traced");
    assert.deepEqual([...calls.keys()].sort(), [4, 5, 6].flatMap((y) => [4, 5, 6].map((x) => url(10, x, y))).sort());
  });

  it("leaves a gap for a neighbor that can't load without network, and doesn't keep that tile cached", async () => {
    const { getTile } = stubTiles((u) => (u === url(10, 6, 5) ? new TypeError("Failed to fetch") : null));
    const m = manager(getTile);
    const tile = await m.fetchContourTile(10, 5, 5, LEVELS, new AbortController());
    assert.ok(tile.arrayBuffer.byteLength > 0);
    assert.equal([...m.contourCache.items.keys()].filter((key) => key.startsWith("10/5/5/")).length, 0, "gapped tile not cached");
    // A complete tile is cached.
    await m.fetchContourTile(10, 3, 5, LEVELS, new AbortController());
    assert.equal([...m.contourCache.items.keys()].filter((key) => key.startsWith("10/3/5/")).length, 1);
  });

  it("tolerates any neighbor failure while the browser reports being offline", async () => {
    const { getTile } = stubTiles((u) => (u === url(10, 6, 5) ? new Error("timed out") : null));
    const offline = manager(getTile, { tolerate: () => true });
    assert.ok((await offline.fetchContourTile(10, 5, 5, LEVELS, new AbortController())).arrayBuffer.byteLength > 0);
  });

  it("fails the tile when a neighbor fails online (HTTP error or timeout), so MapLibre retries", async () => {
    for (const error of [new Error("503"), new Error("timed out")]) {
      const { getTile } = stubTiles((u) => (u === url(10, 6, 5) ? error : null));
      await assert.rejects(manager(getTile).fetchContourTile(10, 5, 5, LEVELS, new AbortController()), error);
    }
  });

  it("fails the tile when its own DEM tile can't load, even offline", async () => {
    const { getTile } = stubTiles((u) => (u === url(10, 5, 5) ? new TypeError("Failed to fetch") : null));
    await assert.rejects(manager(getTile, { tolerate: () => true }).fetchContourTile(10, 5, 5, LEVELS, new AbortController()), TypeError);
  });

  it("re-throws aborts instead of treating them as missing neighbors", async () => {
    const getTile: GetTile = (u, abort) =>
      u === url(10, 5, 5)
        ? Promise.resolve({ data: new Blob([u]) })
        : new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const m = manager(getTile, { tolerate: () => true });
    const abort = new AbortController();
    const pending = m.fetchContourTile(10, 5, 5, LEVELS, abort);
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(pending);
  });

  it("asks for a failed DEM tile once while it is remembered, then again after", async () => {
    let now = 1_000;
    const failing = url(10, 6, 4);
    const { getTile, calls } = stubTiles((u) => (u === failing ? new TypeError("Failed to fetch") : null));
    const m = manager(getTile, { now: () => now });
    // Three contour tiles that all border the failing DEM tile.
    for (const x of [5, 6, 7]) await m.fetchContourTile(10, x, 5, LEVELS, new AbortController());
    assert.equal(calls.get(failing), 1);
    now += FAILED_TILE_MEMORY_MS + 1;
    await m.fetchContourTile(10, 7, 3, LEVELS, new AbortController());
    assert.equal(calls.get(failing), 2);
    // reset() (back online) forgets it at once.
    m.reset();
    await m.fetchContourTile(10, 5, 3, LEVELS, new AbortController());
    assert.equal(calls.get(failing), 3);
  });
});

describe("contour DEM fetching", () => {
  it("reads DEM tiles through fltile:// (offline packages first) as PNG bytes", async () => {
    const seen: { url: string; type?: string }[] = [];
    const getTile = fltileGetTile(async (params) => {
      seen.push(params);
      return { data: new Uint8Array([1, 2, 3]).buffer };
    });
    const { data } = await getTile("http://127.0.0.1:3000/api/dem/12/777/1616", new AbortController());
    assert.deepEqual(seen, [{ url: "fltile://http://127.0.0.1:3000/api/dem/12/777/1616", type: "arrayBuffer" }]);
    assert.equal(data.type, "image/png");
    assert.equal(data.size, 3);
  });

  it("counts only network failures as no network", () => {
    assert.equal(noNetwork(new TypeError("Failed to fetch")), true);
    assert.equal(noNetwork(new Error("503")), false);
    assert.equal(noNetwork(new Error("timed out")), false);
  });
});
