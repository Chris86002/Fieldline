import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstLayerAbove, groupOf, orderLayers, RENDER_GROUPS, type GroupedLayers, type RenderGroup } from "./layer-groups.ts";

type L = { id: string };
const layers = (...ids: string[]): L[] => ids.map((id) => ({ id }));

const sample = (): Record<RenderGroup, L[]> => ({
  base: layers("land", "satellite"),
  relief: layers("hillshade"),
  thematic: layers("sma"),
  detail: layers("roads-casing", "roads"),
  boundaries: layers("units-line", "border-line"),
  labels: layers("towns", "unit-labels"),
  personal: layers("tracks"),
  navigation: layers("measure"),
  inspection: [],
});

const ids = (list: L[]) => list.map((layer) => layer.id);

/** Relative order of `subset` within `list`. */
function relative(list: string[], subset: string[]): string[] {
  return list.filter((id) => subset.includes(id));
}

describe("render groups", () => {
  it("follow the spec's semantic order", () => {
    assert.deepEqual(
      [...RENDER_GROUPS],
      ["base", "relief", "thematic", "detail", "boundaries", "labels", "personal", "navigation", "inspection"],
    );
  });

  it("flatten group by group, keeping order inside each group", () => {
    assert.deepEqual(ids(orderLayers(sample())), [
      "land",
      "satellite",
      "hillshade",
      "sma",
      "roads-casing",
      "roads",
      "units-line",
      "border-line",
      "towns",
      "unit-labels",
      "tracks",
      "measure",
    ]);
  });

  it("does not depend on the key order of the groups object", () => {
    const groups = sample();
    const shuffled: GroupedLayers<L> = {};
    for (const group of [...RENDER_GROUPS].reverse()) shuffled[group] = groups[group];
    assert.deepEqual(ids(orderLayers(shuffled)), ids(orderLayers(groups)));
  });

  it("inserting a layer leaves every other layer's relative order unchanged", () => {
    const before = ids(orderLayers(sample()));
    for (const group of RENDER_GROUPS) {
      for (let at = 0; at <= sample()[group].length; at += 1) {
        const groups = sample();
        groups[group] = [...groups[group].slice(0, at), { id: "new-layer" }, ...groups[group].slice(at)];
        const after = ids(orderLayers(groups));
        assert.equal(after.length, before.length + 1);
        assert.deepEqual(relative(after, before), before, `insert into ${group} at ${at}`);
        assert.equal(groupOf(groups, "new-layer"), group);
      }
    }
  });

  it("removing a layer leaves every other layer's relative order unchanged", () => {
    const before = ids(orderLayers(sample()));
    for (const removed of before) {
      const groups = sample();
      for (const group of RENDER_GROUPS) groups[group] = groups[group].filter((layer) => layer.id !== removed);
      const after = ids(orderLayers(groups));
      assert.deepEqual(after, before.filter((id) => id !== removed), `remove ${removed}`);
    }
  });

  it("rejects duplicate layer ids across groups", () => {
    const groups = sample();
    groups.inspection = layers("tracks");
    assert.throws(() => orderLayers(groups), /Duplicate map layer id "tracks"/);
  });

  it("finds the first live layer above a group for runtime re-insertion", () => {
    const groups = sample();
    assert.equal(firstLayerAbove(groups, "relief"), "sma");
    assert.equal(firstLayerAbove(groups, "relief", (id) => id !== "sma"), "roads-casing");
    assert.equal(firstLayerAbove(groups, "navigation"), undefined);
    assert.equal(groupOf(groups, "nope"), null);
  });
});
