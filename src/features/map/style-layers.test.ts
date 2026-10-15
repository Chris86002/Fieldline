import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LayerSpecification } from "maplibre-gl";
import { groupOf } from "./layer-groups.ts";
import { LABEL_LAYER_IDS, labelRules, type LabelDensity } from "./labels.ts";
import {
  buildLayers,
  contourPaint,
  contoursShown,
  LABEL_SIZES,
  LAND_COVER_LAYERS,
  mapLayerGroups,
  scaledSize,
  styleLayout,
  styleVisibility,
  type StyleOptions,
} from "./style-layers.ts";
import { isVectorBase, mapStyleOf, reliefPaint, STYLE_TOKENS, styleFamily, tokensFor } from "./tokens.ts";

const BASEMAPS = ["terrain", "topo", "satellite", "usgs", "field"] as const;

const options = (patch: Partial<StyleOptions> = {}): StyleOptions => ({
  basemap: "satellite",
  showPublic: true,
  showLabels: true,
  showRoads: true,
  showTracks: true,
  showCreeks: true,
  showPeaks: true,
  showShade: true,
  showBorder: true,
  publicOpacity: 0.25,
  boundaryStrength: "standard",
  labelDensity: "standard",
  showContours: true,
  contourStrength: 1,
  showLandCover: true,
  ...patch,
});

/** Every layer id the map had before MAP-01; MapCanvas and HuntApp toggle these by name. */
const PRE_MAP01_IDS = [
  "land", "satellite", "usgs", "topo", "vx-water", "vx-wood", "vx-park", "sma", "hillshade",
  "vx-creek-line", "vx-track", "vx-local-casing", "vx-local", "vx-highway-casing", "vx-highway",
  "vx-freeway-casing", "vx-freeway", "units-casing", "units-line", "unit-labels", "border-casing",
  "border-line", "rings", "sun-casing", "sun-line", "sun-label", "accuracy", "accuracy-line",
  "tracks-casing", "tracks", "live-casing", "live", "measure-fill", "measure-casing", "measure",
  "measure-pts", "vx-road-major", "vx-road-minor", "vx-shield", "vx-creek", "vx-place-city",
  "vx-place-town", "vx-place-small", "vx-peak",
];

const ids = (layers: LayerSpecification[]) => layers.map((layer) => layer.id);
const find = (layers: LayerSpecification[], id: string) => {
  const layer = layers.find((candidate) => candidate.id === id);
  assert.ok(layer, `missing layer ${id}`);
  return layer as LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number };
};

describe("map style layers", () => {
  it("keeps every existing layer id, adds only the listed layers, and has no duplicates", () => {
    const list = ids(buildLayers(options()));
    assert.equal(new Set(list).size, list.length);
    for (const id of PRE_MAP01_IDS) assert.ok(list.includes(id), `${id} kept`);
    assert.deepEqual(list.filter((id) => !PRE_MAP01_IDS.includes(id)), [
      // MAP-03: elevation tint, land cover, built-up land, contours and their labels.
      "terrain-tint",
      "vx-landcover",
      "vx-landuse",
      "contours",
      // MAP-02: trail casing.
      "vx-track-casing",
      "contour-labels",
      // CC-05: offline-area outlines.
      "offline-areas-casing",
      "offline-areas",
      "offline-area-preview",
    ]);
  });

  it("draws offline-area outlines as navigation aids, the planned area dashed", () => {
    const groups = mapLayerGroups(options());
    for (const id of ["offline-areas-casing", "offline-areas", "offline-area-preview"]) assert.equal(groupOf(groups, id), "navigation");
    const list = ids(buildLayers(options()));
    assert.ok(list.indexOf("live") < list.indexOf("offline-areas"), "above personal content");
    assert.ok(list.indexOf("offline-area-preview") < list.indexOf("rings"), "below range rings");
    assert.ok(find(buildLayers(options()), "offline-area-preview").paint?.["line-dasharray"]);
  });

  it("uses the same ids in the same order for every base map and option", () => {
    const reference = ids(buildLayers(options()));
    for (const basemap of BASEMAPS) {
      for (const boundaryStrength of ["subtle", "standard", "strong"] as const) {
        for (const labelDensity of ["fewer", "standard", "more"] as const) {
          assert.deepEqual(ids(buildLayers(options({ basemap, boundaryStrength, labelDensity, showRoads: false, showPublic: false }))), reference);
        }
      }
    }
  });

  it("stacks the semantic groups in spec order", () => {
    const list = ids(buildLayers(options()));
    const below = (a: string, b: string) => assert.ok(list.indexOf(a) < list.indexOf(b), `${a} draws below ${b}`);
    below("satellite", "hillshade");
    below("vx-park", "hillshade");
    below("terrain-tint", "vx-landcover"); // tint is the land; land cover sits on it
    below("vx-landcover", "vx-wood");
    below("vx-wood", "vx-water"); // water over wetlands and woods
    below("hillshade", "contours");
    below("contours", "sma");
    below("hillshade", "sma"); // relief no longer darkens the public-land colors
    below("sma", "vx-creek-line");
    below("vx-freeway", "units-casing");
    below("border-line", "vx-road-minor");
    below("unit-labels", "tracks-casing"); // labels under personal content
    below("live", "rings");
    below("tracks", "measure");
    const groups = mapLayerGroups(options());
    assert.equal(groupOf(groups, "sma"), "thematic");
    assert.equal(groupOf(groups, "contours"), "relief");
    assert.equal(groupOf(groups, "vx-landcover"), "base");
    assert.equal(groupOf(groups, "contour-labels"), "labels");
    assert.equal(groupOf(groups, "border-line"), "boundaries");
    assert.equal(groupOf(groups, "measure-pts"), "navigation");
    assert.equal(groupOf(groups, "live"), "personal");
  });

  it("orders labels by priority with unit numbers on top and contour elevations last", () => {
    const groups = mapLayerGroups(options());
    assert.deepEqual(ids(groups.labels), [...LABEL_LAYER_IDS]);
    assert.equal(groups.labels.at(-1)?.id, "unit-labels");
    assert.equal(groups.labels[0]?.id, "contour-labels");
  });

  it("collision-manages unit numbers instead of forcing overlap", () => {
    const units = find(buildLayers(options()), "unit-labels");
    assert.notEqual(units.layout?.["text-allow-overlap"], true);
    assert.notEqual(units.layout?.["text-ignore-placement"], true);
    assert.ok(Array.isArray(units.layout?.["text-size"]), "zoom-dependent size");
    // The sun label is active navigation content and stays forced on.
    assert.equal(find(buildLayers(options()), "sun-label").layout?.["text-allow-overlap"], true);
  });

  it("draws trails above local roads and under highways, with a casing on imagery", () => {
    const list = ids(buildLayers(options()));
    assert.ok(list.indexOf("vx-local") < list.indexOf("vx-track-casing"));
    assert.ok(list.indexOf("vx-track") < list.indexOf("vx-highway-casing"));
    const casing = find(buildLayers(options()), "vx-track-casing");
    assert.ok((casing.paint?.["line-opacity"] as number) > 0);
    // Sidewalks and footways (OpenMapTiles "path" subclasses) get no trail casing.
    assert.match(JSON.stringify((casing as { filter?: unknown }).filter), /"footway"/);
  });

  it("scales boundary weight with the boundary-strength setting", () => {
    const opacity = (strength: StyleOptions["boundaryStrength"], id: string) =>
      find(buildLayers(options({ boundaryStrength: strength })), id).paint?.["line-opacity"] as number;
    for (const id of ["units-casing", "units-line", "border-casing", "border-line"]) {
      assert.ok(opacity("subtle", id) < opacity("standard", id), `${id} subtle < standard`);
      assert.ok(opacity("standard", id) <= opacity("strong", id), `${id} standard <= strong`);
      assert.ok(opacity("strong", id) <= 1);
    }
    // Strong on imagery is close to the pre-MAP-02 look (unit casing 0.75, state casing 0.9).
    assert.ok(Math.abs(opacity("strong", "units-casing") - 0.75) < 0.05);
    assert.ok(Math.abs(opacity("strong", "border-casing") - 0.9) < 0.05);
  });

  it("applies the public-land opacity it is given", () => {
    assert.equal(find(buildLayers(options({ publicOpacity: 0.62 })), "sma").paint?.["raster-opacity"], 0.62);
  });

  it("hides vector detail and contours on the topo scan", () => {
    const topo = buildLayers(options({ basemap: "topo", showContours: true }));
    for (const id of ["vx-local", "vx-track", "vx-creek", "vx-peak", "vx-place-town", "contours", "contour-labels", "vx-landcover"]) {
      assert.equal(find(topo, id).layout?.visibility, "none", id);
    }
    assert.equal(find(topo, "hillshade").layout?.visibility, "none");
  });

  it("draws land, water and land cover only on the vector styles, never over imagery", () => {
    for (const basemap of BASEMAPS) {
      const layers = buildLayers(options({ basemap, showLandCover: true }));
      const vector = basemap === "terrain" || basemap === "field";
      assert.equal(find(layers, "vx-water").layout?.visibility, vector ? "visible" : "none", basemap);
      for (const id of ["vx-landcover", "vx-wood", "vx-landuse"]) assert.equal(find(layers, id).layout?.visibility, vector ? "visible" : "none", `${basemap} ${id}`);
    }
    // The land-cover switch hides the classes but keeps water.
    const off = buildLayers(options({ basemap: "terrain", showLandCover: false }));
    for (const id of LAND_COVER_LAYERS) assert.equal(find(off, id).layout?.visibility, "none", id);
    assert.equal(find(off, "vx-water").layout?.visibility, "visible");
    // Elevation tint is part of Terrain only.
    assert.equal(find(buildLayers(options({ basemap: "terrain" })), "terrain-tint").layout?.visibility, "visible");
    for (const basemap of ["satellite", "usgs", "topo", "field"] as const) {
      assert.equal(find(buildLayers(options({ basemap })), "terrain-tint").layout?.visibility, "none", basemap);
    }
  });

  it("classifies land cover only from source classes, with shrub from the grass subclasses", () => {
    const cover = find(buildLayers(options({ basemap: "terrain" })), "vx-landcover");
    const filter = JSON.stringify((cover as { filter?: unknown }).filter);
    for (const cls of ["grass", "wetland", "rock", "sand", "ice", "farmland"]) assert.match(filter, new RegExp(`"${cls}"`));
    const color = JSON.stringify(cover.paint?.["fill-color"]);
    assert.match(color, /"subclass"/);
    assert.match(color, /"scrub"/);
    const tokens = tokensFor("terrain").landcover;
    for (const value of [tokens.scrub, tokens.grass, tokens.wetland, tokens.rock]) assert.ok(color.includes(value));
  });

  it("matches the built style's visibility with the runtime table for every base and switch", () => {
    for (const basemap of BASEMAPS) {
      for (const flags of [{}, { showContours: false, showLandCover: false, showRoads: false, showShade: false, showPublic: false }]) {
        const o = options({ basemap, ...flags });
        const layers = buildLayers(o);
        for (const [id, on] of Object.entries(styleVisibility(o))) {
          assert.equal(find(layers, id).layout?.visibility ?? "visible", on ? "visible" : "none", `${basemap} ${id} ${JSON.stringify(flags)}`);
        }
      }
    }
  });

  it("takes colors from the style's tokens", () => {
    for (const basemap of BASEMAPS) {
      const tokens = tokensFor(basemap);
      const layers = buildLayers(options({ basemap }));
      assert.equal(find(layers, "land").paint?.["background-color"], tokens.land);
      assert.equal(find(layers, "units-line").paint?.["line-color"], tokens.unit.line);
      assert.equal(find(layers, "unit-labels").paint?.["text-color"], tokens.unitLabel.text);
      assert.equal(find(layers, "tracks").paint?.["line-color"], tokens.route.recorded);
      assert.equal(find(layers, "vx-wood").paint?.["fill-color"], tokens.vegetation);
      assert.equal(find(layers, "contour-labels").paint?.["text-color"], tokens.contour.label);
    }
  });

  it("keeps personal content and navigation colors the same in every style", () => {
    const families = Object.values(STYLE_TOKENS);
    for (const tokens of families) {
      assert.deepEqual(tokens.route, families[0].route);
      assert.deepEqual(tokens.nav, families[0].nav);
    }
  });
});

describe("three styles", () => {
  it("groups the five bases into Terrain, Satellite and Field", () => {
    assert.deepEqual(
      BASEMAPS.map((basemap) => [basemap, mapStyleOf(basemap), styleFamily(basemap), isVectorBase(basemap)]),
      [
        ["terrain", "terrain", "terrain", true],
        ["topo", "terrain", "topo", false],
        ["satellite", "satellite", "imagery", false],
        ["usgs", "satellite", "imagery", false],
        ["field", "field", "field", true],
      ],
    );
  });

  it("shows contours from the style's own switch: Satellite has a separate one", () => {
    assert.equal(contoursShown({ basemap: "satellite", showContours: true, showImageryContours: false }), false);
    assert.equal(contoursShown({ basemap: "usgs", showContours: false, showImageryContours: true }), true);
    assert.equal(contoursShown({ basemap: "terrain", showContours: true, showImageryContours: false }), true);
    assert.equal(contoursShown({ basemap: "field", showContours: false, showImageryContours: true }), false);
  });

  it("draws larger names in Field and the same sizes elsewhere", () => {
    const city = (basemap: StyleOptions["basemap"]) => find(buildLayers(options({ basemap })), "vx-place-city").layout?.["text-size"] as unknown[];
    assert.deepEqual(city("terrain"), LABEL_SIZES["vx-place-city"]);
    assert.deepEqual(city("satellite"), LABEL_SIZES["vx-place-city"], "imagery label sizes unchanged from MAP-02");
    const field = city("field");
    const terrain = city("terrain");
    for (let i = 4; i < field.length; i += 2) assert.ok((field[i] as number) > (terrain[i] as number));
    assert.equal(scaledSize(12, 1.15), 13.8);
    // A style switch re-applies every label size at runtime.
    const layout = styleLayout(options({ basemap: "field" }));
    for (const id of LABEL_LAYER_IDS) assert.ok(layout.some((entry) => entry.id === id && entry.prop === "text-size"), id);
  });
});

describe("contour layers", () => {
  it("draws index lines heavier than minor lines and scales with contour strength", () => {
    const tokens = tokensFor("terrain");
    const paint = contourPaint(tokens, 1);
    assert.deepEqual(paint["line-opacity"], ["case", [">", ["coalesce", ["get", "level"], 0], 0], tokens.contour.indexOpacity, tokens.contour.minorOpacity]);
    const strong = contourPaint(tokens, 1.6)["line-opacity"] as unknown[];
    assert.equal(strong[2], 1, "capped at fully opaque");
    assert.ok((strong[3] as number) > tokens.contour.minorOpacity);
    const faint = contourPaint(tokens, 0.5)["line-opacity"] as unknown[];
    assert.ok((faint[2] as number) < tokens.contour.indexOpacity);
    assert.equal(find(buildLayers(options({ contourStrength: 0.5 })), "contours").paint?.["line-opacity"]?.toString(), contourPaint(tokensFor("satellite"), 0.5)["line-opacity"].toString());
  });

  it("labels only index lines with the traced elevation, along the line", () => {
    const labels = find(buildLayers(options({ basemap: "terrain" })), "contour-labels");
    assert.deepEqual((labels as { filter?: unknown }).filter, [">", ["coalesce", ["get", "level"], 0], 0]);
    // The value is already in the user's unit (the tile URL carries the unit; see contours.test.ts).
    assert.deepEqual(labels.layout?.["text-field"], ["to-string", ["get", "ele"]]);
    assert.equal(labels.layout?.["symbol-placement"], "line");
    assert.deepEqual(labels.layout?.["text-font"], ["Noto Sans Regular"], "a packaged font, so labels draw offline");
  });

  it("reads contours from their own source, never from the imagery or topo scan", () => {
    for (const id of ["contours", "contour-labels"]) {
      const layer = find(buildLayers(options()), id) as { source?: string; "source-layer"?: string };
      assert.equal(layer.source, "contours");
      assert.equal(layer["source-layer"], "contours");
    }
  });
});

describe("label density", () => {
  const densities: LabelDensity[] = ["fewer", "standard", "more"];

  it("shows fewer labels later and more labels sooner, never moving unit numbers or cities", () => {
    const [fewer, standard, more] = densities.map(labelRules);
    for (const id of LABEL_LAYER_IDS) {
      assert.ok(fewer[id].minzoom >= standard[id].minzoom && standard[id].minzoom >= more[id].minzoom, id);
      assert.ok(fewer[id].padding >= standard[id].padding && standard[id].padding >= more[id].padding, id);
    }
    for (const id of ["unit-labels", "vx-place-city"] as const) {
      assert.equal(fewer[id].minzoom, more[id].minzoom);
    }
    assert.ok(fewer["vx-peak"].minzoom > more["vx-peak"].minzoom);
  });

  it("is what the built style uses", () => {
    for (const density of densities) {
      const rules = labelRules(density);
      const layers = buildLayers(options({ labelDensity: density }));
      for (const id of LABEL_LAYER_IDS) {
        const layer = find(layers, id);
        assert.equal(layer.minzoom, rules[id].minzoom, id);
        assert.equal(layer.layout?.["text-padding"], rules[id].padding, id);
      }
    }
  });
});

describe("relief", () => {
  it("is gentler on imagery than on Terrain, which has no real shadows", () => {
    const imagery = reliefPaint("satellite", 150, 35);
    const street = reliefPaint("terrain", 150, 35);
    assert.ok((imagery["hillshade-exaggeration"] as number) < (street["hillshade-exaggeration"] as number));
    const alpha = (paint: Record<string, string | number>) => Number(/([\d.]+)\)$/.exec(String(paint["hillshade-shadow-color"]))?.[1]);
    assert.ok(alpha(imagery) < alpha(street));
  });

  it("follows the sun and softens at night", () => {
    const day = reliefPaint("satellite", 120, 40);
    const night = reliefPaint("satellite", 120, -5);
    assert.equal(day["hillshade-illumination-direction"], 120);
    assert.equal(night["hillshade-illumination-altitude"], 3);
    const alpha = (paint: Record<string, string | number>) => Number(/([\d.]+)\)$/.exec(String(paint["hillshade-shadow-color"]))?.[1]);
    assert.ok(alpha(night) <= alpha(day));
    assert.equal(reliefPaint("satellite", null, null)["hillshade-illumination-direction"], 180);
  });
});
