import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { getHuntStorageWarning, useHunt } from "./store.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const savedWaypoint = {
  id: "saved-waypoint",
  name: "North ridge",
  kind: "stand",
  lng: -111.3,
  lat: 33.7,
  notes: "",
  hunt: "Unit 22",
  goodWinds: [],
  createdAt: 1,
};

function installStorage(initial: string | null) {
  let value = initial;
  let writes = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
        writes += 1;
      },
      removeItem: () => {
        value = null;
      },
    },
  });
  return {
    current: () => value,
    writes: () => writes,
  };
}

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("fieldline-v1 persistence", () => {
  it("hydrates and writes the existing saved-data format", async () => {
    const local = installStorage(
      JSON.stringify({ state: { waypoints: [savedWaypoint], tracks: [], basemap: "topo" }, version: 0 }),
    );
    await useHunt.persist.rehydrate();
    assert.deepEqual(useHunt.getState().waypoints, [savedWaypoint]);
    assert.equal(useHunt.getState().basemap, "topo");

    useHunt.getState().setBasemap("street");
    const written = JSON.parse(local.current() ?? "null");
    assert.equal(written.state.waypoints[0].id, "saved-waypoint");
    assert.equal(written.state.basemap, "street");
    assert.equal(local.writes(), 1);
    assert.equal(getHuntStorageWarning(), null);
  });

  it("leaves corrupt stored data untouched and disables further writes", async () => {
    const local = installStorage("{");
    await useHunt.persist.rehydrate();
    assert.match(getHuntStorageWarning() ?? "", /stored copy was left untouched/);

    useHunt.getState().setBasemap("hybrid");
    assert.equal(local.current(), "{");
    assert.equal(local.writes(), 0);
  });
});
