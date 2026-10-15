import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TILES } from "../hunt/tiles.ts";
import { boundsContain, boundsContainPoint, planPackage, tileRanges } from "./plan.ts";
import { canonicalAssetUrl, fetchUrlFor, packageRuleFor } from "./sources.ts";

describe("offline package planning", () => {
  it("excludes Esri imagery and hunt units with reasons, and plans the rest", () => {
    const plan = planPackage({
      bounds: { west: -111.52, south: 34.48, east: -111.47, north: 34.52 },
      minZoom: 12,
      maxZoom: 13,
      layers: ["esri-imagery", "hunt-units", "usgs-imagery", "mystery"],
    });
    assert.equal(plan.ok, true, JSON.stringify(plan.violations));
    const reasons = Object.fromEntries(plan.excluded.map((e) => [e.layerId, e.reason]));
    assert.match(reasons["esri-imagery"], /Esri.*can't be stored/);
    assert.match(reasons["hunt-units"], /download rights.*unverified/);
    assert.match(reasons.mystery, /isn't a layer/);
    // Only permitted layers are planned; label fonts come along automatically.
    assert.deepEqual(
      plan.layers.map((l) => l.layerId),
      ["usgs-imagery", "glyphs"],
    );
    assert.ok(plan.layers[0].tiles.length > 0);
    assert.equal(plan.layers[0].tiles.length, plan.layers[0].assetCount);
    assert.ok(plan.totals.estimatedBytes > 0);
    assert.ok(plan.attribution.some((a) => a.includes("USGS")));
  });

  it("flags OpenFreeMap's 3,000-tile / 50 MB per-download limit", () => {
    const plan = planPackage({
      bounds: { west: -112.5, south: 34, east: -111, north: 35 },
      minZoom: 10,
      maxZoom: 14,
      layers: ["ofm-vector"],
    });
    assert.equal(plan.ok, false);
    const ofm = plan.violations.filter((v) => v.provider === "openfreemap");
    assert.ok(
      ofm.some((v) => v.max === 3_000 && (v.value ?? 0) > 3_000),
      JSON.stringify(ofm),
    );
    assert.ok(ofm.some((v) => v.max === 50_000_000));
  });

  it("enforces the hard package cap without allocating huge tile lists", () => {
    const plan = planPackage({
      bounds: { west: -125, south: 25, east: -66, north: 49 },
      minZoom: 0,
      maxZoom: 16,
      layers: ["usgs-imagery"],
    });
    assert.equal(plan.ok, false);
    assert.ok(plan.violations.some((v) => v.kind === "package-limit"));
    assert.equal(plan.layers[0].tiles.length, 0);
    assert.ok(plan.totals.assets > 1_000_000);
  });

  it("plans a rectangle that crosses the antimeridian", () => {
    const crossing = planPackage({
      bounds: { west: 179, south: 51, east: -179, north: 52 },
      minZoom: 8,
      maxZoom: 8,
      layers: ["usgs-topo"],
      includeGlyphs: false,
    });
    assert.equal(crossing.ok, true, JSON.stringify(crossing.violations));
    const xs = new Set(crossing.layers[0].tiles.map((t) => t.x));
    assert.ok(xs.has(0) && xs.has(255), [...xs].join(","));
    assert.ok(![...xs].some((x) => x > 2 && x < 250), "no tiles from the far side of the world");
    // Same width away from the antimeridian has the same tile count.
    const plain = planPackage({
      bounds: { west: 10, south: 51, east: 12, north: 52 },
      minZoom: 8,
      maxZoom: 8,
      layers: ["usgs-topo"],
      includeGlyphs: false,
    });
    assert.equal(crossing.layers[0].assetCount, plain.layers[0].assetCount);
    assert.equal(tileRanges(crossing.bounds, 8).length, 2);
    assert.equal(boundsContainPoint(crossing.bounds, 179.5, 51.5), true);
    assert.equal(boundsContainPoint(crossing.bounds, -179.5, 51.5), true);
    assert.equal(boundsContainPoint(crossing.bounds, 0, 51.5), false);
    assert.equal(
      boundsContain(crossing.bounds, { west: 179.5, south: 51.2, east: -179.5, north: 51.8 }),
      true,
    );
  });

  it("clamps layers to their source max zoom and rejects invalid input", () => {
    const plan = planPackage({
      bounds: { west: -111.52, south: 34.48, east: -111.47, north: 34.52 },
      minZoom: 15,
      maxZoom: 16,
      layers: ["dem", "usgs-topo"],
      includeGlyphs: false,
    });
    const dem = plan.layers.find((l) => l.layerId === "dem")!;
    assert.deepEqual([dem.minZoom, dem.maxZoom], [14, 14]);
    const topo = plan.layers.find((l) => l.layerId === "usgs-topo")!;
    assert.deepEqual([topo.minZoom, topo.maxZoom], [15, 16]);

    for (const bad of [
      { west: Number.NaN, south: 0, east: 1, north: 1 },
      { west: 0, south: 2, east: 1, north: 1 },
      { west: -200, south: 0, east: 1, north: 1 },
    ]) {
      const result = planPackage({ bounds: bad, minZoom: 1, maxZoom: 2, layers: ["usgs-topo"] });
      assert.equal(result.ok, false);
      assert.ok(result.violations.some((v) => v.kind === "invalid"));
    }
    assert.equal(
      planPackage({ ...plan, bounds: plan.bounds, minZoom: 5, maxZoom: 17, layers: ["usgs-topo"] })
        .ok,
      false,
    );
  });
});

describe("offline package sources", () => {
  it("never allows Esri or unlisted hosts; allows the permitted ones", () => {
    assert.equal(
      packageRuleFor(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/8/1/1",
      ),
      null,
    );
    assert.equal(
      packageRuleFor("https://services.arcgis.com/x/arcgis/rest/services/units/FeatureServer/0"),
      null,
    );
    assert.equal(packageRuleFor("https://tile.openstreetmap.org/8/1/1.png"), null);
    assert.equal(packageRuleFor("https://tiles.openfreemap.org.evil.example/planet"), null);
    assert.equal(packageRuleFor("https://tiles.openfreemap.org/planet/../../x"), null);
    assert.equal(packageRuleFor(TILES.topo.replace("{z}/{y}/{x}", "8/1/1"))?.layerId, "usgs-topo");
    assert.equal(packageRuleFor(TILES.sma.replace("{z}/{y}/{x}", "8/1/1"))?.layerId, "blm-sma");
    assert.equal(packageRuleFor("https://tiles.openfreemap.org/planet")?.kind, "tilejson");
    assert.equal(
      packageRuleFor("https://tiles.openfreemap.org/planet/20260101_000000_pt/8/1/1.pbf")?.kind,
      "vector",
    );
    assert.equal(
      packageRuleFor("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf")?.kind,
      "glyphs",
    );
  });

  it("canonicalizes the app's terrain proxy and fltile:// wrappers", () => {
    const upstream = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/770/1631.png";
    assert.equal(
      canonicalAssetUrl(
        "fltile://http://localhost:8080/api/dem/12/770/1631",
        "http://localhost:8080",
      ),
      upstream,
    );
    assert.equal(canonicalAssetUrl("http://192.168.1.5:8080/api/dem/12/770/1631"), upstream);
    assert.equal(packageRuleFor(upstream)?.layerId, "dem");
    assert.equal(
      fetchUrlFor(upstream, "http://localhost:8080"),
      "http://localhost:8080/api/dem/12/770/1631",
    );
    assert.equal(
      canonicalAssetUrl("fltile://https://tiles.openfreemap.org/fonts/Noto Sans Bold/0-255.pbf"),
      "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf",
    );
    assert.equal(canonicalAssetUrl("javascript:alert(1)"), null);
  });
});
