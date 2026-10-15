/**
 * Opt-in live check against the New Mexico GMU layer (7 requests: layer
 * metadata, count, one feature page, four point queries). Skipped unless
 * FIELDLINE_LIVE=1, so the normal suite never touches the network:
 *
 *   $env:FIELDLINE_LIVE = "1"; node --experimental-strip-types --test src/features/catalog/adapters/nmdgf.live.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryUnitStorage } from "../unit-store.ts";
import { boundsContain, polygonsContain } from "../unit-geometry.ts";
import { createNmdgfAdapter, NMDGF_INFO } from "./nmdgf.ts";

const live = process.env.FIELDLINE_LIVE === "1";

describe("NMDGF live service (opt-in)", { skip: live ? false : "set FIELDLINE_LIVE=1 to run" }, () => {
  it("loads every GMU as available with label points inside, sub-units included", async () => {
    const storage = memoryUnitStorage();
    const adapter = createNmdgfAdapter({ storage, timeoutMs: 60_000 });
    const result = await adapter.load();
    assert.equal(result.status, "available", result.message ?? "");
    const manifest = (storage.snapshots.get(NMDGF_INFO.id) as { manifest: Record<string, unknown> }).manifest;
    assert.equal(manifest.featureCount, manifest.expectedCount);
    assert.equal(result.units.length, manifest.featureCount, "every feature is one GMU");
    const outside = result.units.filter((unit) => !polygonsContain(unit.polygons, unit.labelPoint.lng, unit.labelPoint.lat));
    assert.deepEqual(outside.map((unit) => unit.code), []);
    assert.ok(result.units.every((unit) => NMDGF_INFO.coverage.some((box) => boundsContain(box, unit.labelPoint.lng, unit.labelPoint.lat))));
    const codes = result.units.map((unit) => unit.code);
    for (const code of ["2A", "6C", "16D", "34", "55B"]) assert.ok(codes.includes(code), code);
    assert.ok(codes.every((code) => /^\d{1,3}[A-Z]?$/.test(code)), codes.join());
    const withZones = result.units.filter((unit) => unit.seasonContext).length;
    const withForest = result.units.filter((unit) => unit.forest).length;
    const withArea = result.units.filter((unit) => unit.sqMiles !== null).length;
    console.log(
      `features ${String(manifest.featureCount)}, units ${result.units.length}, sourceVersion ${String(result.sourceVersion)}, ` +
        `with zones ${withZones}, with forest ${withForest}, with area ${withArea}, ` +
        `parts ${result.units.reduce((n, unit) => n + unit.polygons.length, 0)}, ` +
        `vertices ${result.units.reduce((n, unit) => n + unit.polygons.flat(2).length, 0)}, ` +
        `json bytes ${JSON.stringify(result.units).length}`,
    );
    console.log(`codes: ${codes.join(" ")}`);

    const spots = [
      // Gila Cliff Dwellings, in the Gila Wilderness.
      { name: "Gila Cliff Dwellings", lng: -108.272, lat: 33.227 },
      // Cowles, upper Pecos River (Pecos Wilderness edge).
      { name: "Cowles (Pecos)", lng: -105.665, lat: 35.81 },
      // Chama, about 15 km south of the Colorado line.
      { name: "Chama", lng: -106.585, lat: 36.903 },
      // Luna, about 6 km east of the Arizona line.
      { name: "Luna", lng: -108.945, lat: 33.82 },
    ];
    for (const spot of spots) {
      const hit = await adapter.identify(spot);
      assert.equal(hit.status, "available", hit.message ?? "");
      assert.ok(hit.hits.every((h) => !h.approximate));
      const local = result.units.filter((unit) => polygonsContain(unit.polygons, spot.lng, spot.lat)).map((unit) => unit.code);
      const describe = hit.hits.map((h) => [h.unit.label, h.unit.seasonContext, h.unit.forest].filter(Boolean).join(" / "));
      console.log(`${spot.name}: provider ${describe.join(",") || "(none)"}, local copy ${local.join(",") || "(none)"}`);
    }
  });
});
