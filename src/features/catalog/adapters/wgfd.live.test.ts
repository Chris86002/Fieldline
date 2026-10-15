/**
 * Opt-in live check against the Wyoming Game and Fish elk hunt area layer (8
 * requests: layer metadata, count, one feature page, five point queries).
 * Skipped unless FIELDLINE_LIVE=1, so the normal suite never touches the
 * network:
 *
 *   $env:FIELDLINE_LIVE = "1"; node --experimental-strip-types --test src/features/catalog/adapters/wgfd.live.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryUnitStorage } from "../unit-store.ts";
import { boundsContain, polygonsContain } from "../unit-geometry.ts";
import { createWgfdAdapter, WGFD_INFO } from "./wgfd.ts";

const live = process.env.FIELDLINE_LIVE === "1";

describe("WGFD live service (opt-in)", { skip: live ? false : "set FIELDLINE_LIVE=1 to run" }, () => {
  it("loads every elk hunt area as available with label points inside", async () => {
    const storage = memoryUnitStorage();
    const adapter = createWgfdAdapter({ storage, timeoutMs: 60_000 });
    const result = await adapter.load();
    assert.equal(result.status, "available", result.message ?? "");
    const manifest = (storage.snapshots.get(WGFD_INFO.id) as { manifest: Record<string, unknown> }).manifest;
    assert.equal(manifest.featureCount, manifest.expectedCount);
    const outside = result.units.filter((unit) => !polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
    assert.deepEqual(outside.map((unit) => unit.code), []);
    assert.ok(result.units.every((unit) => WGFD_INFO.coverage.some((box) => boundsContain(box, unit.labelPoint.lng, unit.labelPoint.lat))));
    assert.ok(result.units.every((unit) => /^\d+$/.test(unit.code) && unit.label === `Elk hunt area ${unit.code}`));
    const regions = new Set(result.units.map((unit) => unit.regionName));
    const noHerd = result.units.filter((unit) => !/Herd unit/.test(unit.seasonContext ?? "")).map((unit) => unit.code);
    console.log(
      `features ${String(manifest.featureCount)}, units ${result.units.length}, sourceVersion ${String(result.sourceVersion)}, ` +
        `regions ${[...regions].join("|")}, without herd unit ${noHerd.join(",") || "(none)"}, ` +
        `sq mi ${Math.round(result.units.reduce((n, unit) => n + (unit.sqMiles ?? 0), 0))}, ` +
        `parts ${result.units.reduce((n, unit) => n + unit.polygons.length, 0)}, ` +
        `vertices ${result.units.reduce((n, unit) => n + unit.polygons.flat(2).length, 0)}, ` +
        `json bytes ${JSON.stringify(result.units).length}`,
    );
    console.log(`codes: ${result.units.map((unit) => unit.code).join(",")}`);

    const spots = [
      // Jackson town square.
      { name: "Jackson", lng: -110.762, lat: 43.48 },
      // Cody.
      { name: "Cody", lng: -109.056, lat: 44.526 },
      // Teton Pass, just east of the Idaho line.
      { name: "Teton Pass (WY side)", lng: -110.98, lat: 43.5 },
      // Victor, Idaho: inside the coverage box, outside Wyoming.
      { name: "Victor ID", lng: -111.11, lat: 43.6 },
      // Medicine Bow Mountains near the Colorado line.
      { name: "Snowy Range", lng: -106.3, lat: 41.35 },
    ];
    for (const spot of spots) {
      const hit = await adapter.identify(spot);
      assert.equal(hit.status, "available", hit.message ?? "");
      assert.ok(hit.hits.every((h) => !h.approximate));
      const local = result.units.filter((unit) => polygonsContain(unit.polygons, spot.lng, spot.lat)).map((unit) => unit.code);
      console.log(
        `${spot.name}: provider ${hit.hits.map((h) => `${h.unit.label} (${h.unit.seasonContext ?? ""}; ${h.unit.regionName})`).join(",") || "(none)"}, local copy ${local.join(",") || "(none)"}`,
      );
    }
  });
});
