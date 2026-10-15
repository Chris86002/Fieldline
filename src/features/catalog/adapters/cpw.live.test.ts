/**
 * Opt-in live check against the Colorado Parks and Wildlife service (5
 * requests: layer metadata, count, one feature page, two point queries).
 * Skipped unless FIELDLINE_LIVE=1, so the normal suite never touches the
 * network:
 *
 *   $env:FIELDLINE_LIVE = "1"; node --experimental-strip-types --test src/features/catalog/adapters/cpw.live.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryUnitStorage } from "../unit-store.ts";
import { boundsContain, polygonsContain } from "../unit-geometry.ts";
import { CPW_INFO, createCpwAdapter } from "./cpw.ts";

const live = process.env.FIELDLINE_LIVE === "1";

describe("CPW live service (opt-in)", { skip: live ? false : "set FIELDLINE_LIVE=1 to run" }, () => {
  it("loads every big-game GMU as available with label points inside", async () => {
    const storage = memoryUnitStorage();
    const adapter = createCpwAdapter({ storage, timeoutMs: 60_000 });
    const result = await adapter.load();
    assert.equal(result.status, "available", result.message ?? "");
    const manifest = (storage.snapshots.get(CPW_INFO.id) as { manifest: Record<string, unknown> }).manifest;
    assert.equal(manifest.featureCount, manifest.expectedCount);
    const outside = result.units.filter((unit) => !polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
    assert.deepEqual(outside.map((unit) => unit.code), []);
    assert.ok(result.units.every((unit) => CPW_INFO.coverage.some((box) => boundsContain(box, unit.labelPoint.lng, unit.labelPoint.lat))));
    console.log(
      `features ${String(manifest.featureCount)}, units ${result.units.length}, sourceVersion ${result.sourceVersion}, ` +
        `sqMiles missing ${result.units.filter((unit) => unit.sqMiles === null).length}, ` +
        `no herd units ${result.units.filter((unit) => unit.seasonContext === null).length}, ` +
        `parts ${result.units.reduce((n, unit) => n + unit.polygons.length, 0)}, ` +
        `vertices ${result.units.reduce((n, unit) => n + unit.polygons.flat(2).length, 0)}, ` +
        `json bytes ${JSON.stringify(result.units).length}`,
    );

    // Leadville and Gunnison: the provider's own point query names the GMU.
    for (const [name, point] of [
      ["Leadville", { lng: -106.2925, lat: 39.2508 }],
      ["Gunnison", { lng: -106.9253, lat: 38.5458 }],
    ] as const) {
      const hit = await adapter.identify(point);
      assert.equal(hit.status, "available", hit.message ?? "");
      assert.ok(hit.hits.length >= 1, name);
      assert.ok(hit.hits.every((h) => !h.approximate));
      const local = result.units.filter((unit) => polygonsContain(unit.polygons, point.lng, point.lat)).map((unit) => unit.code);
      console.log(
        `${name}: provider ${hit.hits.map((h) => `${h.unit.label} [${h.unit.seasonContext ?? "-"}]`).join(",")}, local copy ${local.join(",")}`,
      );
    }
  });
});
