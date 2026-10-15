/**
 * Opt-in live check against the Utah DWR general-season deer layer (6
 * requests: layer metadata, count, one feature page, three point queries).
 * Skipped unless FIELDLINE_LIVE=1, so the normal suite never touches the
 * network:
 *
 *   $env:FIELDLINE_LIVE = "1"; node --experimental-strip-types --test src/features/catalog/adapters/udwr.live.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryUnitStorage } from "../unit-store.ts";
import { boundsContain, polygonsContain } from "../unit-geometry.ts";
import { createUdwrAdapter, UDWR_INFO } from "./udwr.ts";

const live = process.env.FIELDLINE_LIVE === "1";

describe("UDWR live service (opt-in)", { skip: live ? false : "set FIELDLINE_LIVE=1 to run" }, () => {
  it("loads every general-season deer unit as available with label points inside", async () => {
    const storage = memoryUnitStorage();
    const adapter = createUdwrAdapter({ storage, timeoutMs: 60_000 });
    const result = await adapter.load();
    assert.equal(result.status, "available", result.message ?? "");
    const manifest = (storage.snapshots.get(UDWR_INFO.id) as { manifest: Record<string, unknown> }).manifest;
    assert.equal(manifest.featureCount, manifest.expectedCount);
    const outside = result.units.filter((unit) => !polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
    assert.deepEqual(outside.map((unit) => unit.code), []);
    assert.ok(result.units.every((unit) => UDWR_INFO.coverage.some((box) => boundsContain(box, unit.labelPoint.lng, unit.labelPoint.lat))));
    const contexts = new Set(result.units.map((unit) => unit.seasonContext));
    const species = new Set(result.units.flatMap((unit) => unit.speciesTags));
    console.log(
      `features ${String(manifest.featureCount)}, units ${result.units.length}, sourceVersion ${String(result.sourceVersion)}, ` +
        `contexts ${[...contexts].join("|")}, species ${[...species].join("|")}, ` +
        `parts ${result.units.reduce((n, unit) => n + unit.polygons.length, 0)}, ` +
        `vertices ${result.units.reduce((n, unit) => n + unit.polygons.flat(2).length, 0)}, ` +
        `json bytes ${JSON.stringify(result.units).length}`,
    );
    console.log(`codes: ${result.units.map((unit) => unit.code).join("; ")}`);

    const spots = [
      // Logan, Cache Valley (near the Idaho line).
      { name: "Logan", lng: -111.834, lat: 41.737 },
      // St. George (near the Arizona line).
      { name: "St. George", lng: -113.584, lat: 37.104 },
      // Paunsaugunt, a limited-entry-only deer unit: no general-season unit expected.
      { name: "Paunsaugunt", lng: -112.2, lat: 37.5 },
    ];
    for (const spot of spots) {
      const hit = await adapter.identify(spot);
      assert.equal(hit.status, "available", hit.message ?? "");
      assert.ok(hit.hits.every((h) => !h.approximate));
      const local = result.units.filter((unit) => polygonsContain(unit.polygons, spot.lng, spot.lat)).map((unit) => unit.code);
      console.log(`${spot.name}: provider ${hit.hits.map((h) => h.unit.label).join(",") || "(none)"}, local copy ${local.join(",") || "(none)"}`);
    }
  });
});
