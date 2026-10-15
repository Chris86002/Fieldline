import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LayerSpecification } from "maplibre-gl";
import { groupOf } from "./layer-groups.ts";
import { LABEL_LAYER_IDS, labelRules, type LabelDensity } from "./labels.ts";
import { buildLayers, mapLayerGroups, type StyleOptions } from "./style-layers.ts";
import { reliefPaint, tokensFor } from "./tokens.ts";

const BASEMAPS = ["hybrid", "satellite", "usgs", "topo", "street"] as const;

const options = (patch: Partial<StyleOptions> = {}): StyleOptions => ({
  basemap: "hybrid",
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
  it("keeps every existing layer id, adds only the trail casing and offline-area outlines, and has no duplicates", () => {
    const list = ids(buildLayers(options()));
    assert.equal(new Set(list).size, list.length);
    for (const id of PRE_MAP01_IDS) assert.ok(list.includes(id), `${id} kept`);
    assert.deepEqual(list.filter((id) => !PRE_MAP01_IDS.includes(id)), ["vx-track-casing", "offline-areas-casing", "offline-areas", "offline-area-preview"]);
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
    below("hillshade", "sma"); // relief no longer darkens the public-land colors
    below("sma", "vx-creek-line");
    below("vx-freeway", "units-casing");
    below("border-line", "vx-road-minor");
    below("unit-labels", "tracks-casing"); // labels under personal content
    below("live", "rings");
    below("tracks", "measure");
    const groups = mapLayerGroups(options());
    assert.equal(groupOf(groups, "sma"), "thematic");
    assert.equal(groupOf(groups, "border-line"), "boundaries");
    assert.equal(groupOf(groups, "measure-pts"), "navigation");
    assert.equal(groupOf(groups, "live"), "personal");
  });

  it("orders labels by priority with unit numbers on top", () => {
    const groups = mapLayerGroups(options());
    assert.deepEqual(ids(groups.labels), [...LABEL_LAYER_IDS]);
    assert.equal(groups.labels.at(-1)?.id, "unit-labels");
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

  it("hides vector detail on the topo scan and shows street fills only on Street", () => {
    const topo = buildLayers(options({ basemap: "topo" }));
    for (const id of ["vx-local", "vx-track", "vx-creek", "vx-peak", "vx-place-town"]) assert.equal(find(topo, id).layout?.visibility, "none");
    assert.equal(find(topo, "hillshade").layout?.visibility, "none");
    assert.equal(find(buildLayers(options({ basemap: "street" })), "vx-water").layout?.visibility, "visible");
    assert.equal(find(buildLayers(options()), "vx-water").layout?.visibility, "none");
  });

  it("takes colors from the style's tokens", () => {
    for (const basemap of BASEMAPS) {
      const tokens = tokensFor(basemap);
      const layers = buildLayers(options({ basemap }));
      assert.equal(find(layers, "land").paint?.["background-color"], tokens.land);
      assert.equal(find(layers, "units-line").paint?.["line-color"], tokens.unit.line);
      assert.equal(find(layers, "unit-labels").paint?.["text-color"], tokens.unitLabel.text);
      assert.equal(find(layers, "tracks").paint?.["line-color"], tokens.route.recorded);
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
  it("is gentler on imagery than on Street, which has no real shadows", () => {
    const imagery = reliefPaint("satellite", 150, 35);
    const street = reliefPaint("street", 150, 35);
    assert.ok((imagery["hillshade-exaggeration"] as number) < (street["hillshade-exaggeration"] as number));
    const alpha = (paint: Record<string, string | number>) => Number(/([\d.]+)\)$/.exec(String(paint["hillshade-shadow-color"]))?.[1]);
    assert.ok(alpha(imagery) < alpha(street));
  });

  it("follows the sun and softens at night", () => {
    const day = reliefPaint("hybrid", 120, 40);
    const night = reliefPaint("hybrid", 120, -5);
    assert.equal(day["hillshade-illumination-direction"], 120);
    assert.equal(night["hillshade-illumination-altitude"], 3);
    const alpha = (paint: Record<string, string | number>) => Number(/([\d.]+)\)$/.exec(String(paint["hillshade-shadow-color"]))?.[1]);
    assert.ok(alpha(night) <= alpha(day));
    assert.equal(reliefPaint("hybrid", null, null)["hillshade-illumination-direction"], 180);
  });
});
