/**
 * Opt-in live check against the Montana FWP service (4 requests: layer
 * metadata, count, one feature page, one point query). Skipped unless
 * FIELDLINE_LIVE=1, so the normal suite never touches the network:
 *
 *   $env:FIELDLINE_LIVE = "1"; node --experimental-strip-types --test src/features/catalog/adapters/mtfwp.live.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryUnitStorage } from "../unit-store.ts";
import { boundsContain, polygonsContain } from "../unit-geometry.ts";
import { createMtfwpAdapter, MTFWP_INFO } from "./mtfwp.ts";

const live = process.env.FIELDLINE_LIVE === "1";

describe("MTFWP live service (opt-in)", { skip: live ? false : "set FIELDLINE_LIVE=1 to run" }, () => {
  it("loads every deer/elk/lion district as available with label points inside", async () => {
    const storage = memoryUnitStorage();
    const adapter = createMtfwpAdapter({ storage, timeoutMs: 60_000 });
    const result = await adapter.load();
    assert.equal(result.status, "available", result.message ?? "");
    const manifest = (storage.snapshots.get(MTFWP_INFO.id) as { manifest: Record<string, unknown> }).manifest;
    assert.equal(manifest.featureCount, manifest.expectedCount);
    const outside = result.units.filter((unit) => !polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
    assert.deepEqual(outside.map((unit) => unit.code), []);
    const regions = new Set(result.units.map((unit) => unit.regionName));
    const years = new Set(result.units.map((unit) => unit.seasonContext));
    console.log(
      `features ${String(manifest.featureCount)}, units ${result.units.length}, ` +
        `sqMiles missing ${result.units.filter((unit) => unit.sqMiles === null).length}, ` +
        `regions ${[...regions].sort().join("|")}, years ${[...years].join("|")}, ` +
        `parts ${result.units.reduce((n, unit) => n + unit.polygons.length, 0)}, ` +
        `vertices ${result.units.reduce((n, unit) => n + unit.polygons.flat(2).length, 0)}, ` +
        `json bytes ${JSON.stringify(result.units).length}`,
    );
    assert.ok(result.units.every((unit) => MTFWP_INFO.coverage.some((box) => boundsContain(box, unit.labelPoint.lng, unit.labelPoint.lat))));

    // Missoula: the provider's own point query names the district.
    const hit = await adapter.identify({ lng: -113.994, lat: 46.872 });
    assert.equal(hit.status, "available", hit.message ?? "");
    assert.ok(hit.hits.length >= 1);
    assert.ok(hit.hits.every((h) => !h.approximate));
    const local = result.units.filter((unit) => polygonsContain(unit.polygons, -113.994, 46.872)).map((unit) => unit.code);
    console.log(`Missoula: provider ${hit.hits.map((h) => h.unit.code).join(",")}, local copy ${local.join(",")}`);
  });
});
