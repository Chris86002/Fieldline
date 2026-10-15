import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidBounds } from "../../lib/geo/bounds.ts";
import { coverageFor, jurisdictionsAt, jurisdictionsInBounds, layerStatus } from "./coverage.ts";
import { JURISDICTIONS, LAYER_CATEGORIES } from "./coverage-data.ts";
import { UNIT_ADAPTERS } from "./adapters/index.ts";

const USPS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
];

const ids = (list: { id: string }[]) => list.map((j) => j.id);

describe("coverage register", () => {
  it("has exactly the 50 states and DC with unique ids", () => {
    assert.equal(USPS.length, 51);
    assert.equal(JURISDICTIONS.length, 51);
    assert.equal(new Set(ids([...JURISDICTIONS])).size, 51);
    assert.deepEqual(JURISDICTIONS.map((j) => j.usps).sort(), [...USPS].sort());
    for (const j of JURISDICTIONS) {
      assert.equal(j.id, `us-${j.usps.toLowerCase()}`);
      assert.ok(j.name.length > 0);
    }
  });

  it("gives every entry every layer category with a note", () => {
    for (const j of JURISDICTIONS) {
      assert.deepEqual(Object.keys(j.layers).sort(), [...LAYER_CATEGORIES].sort(), j.id);
      for (const category of LAYER_CATEGORIES) {
        const layer = j.layers[category];
        assert.ok(layer.note.length > 0, `${j.id} ${category} note`);
        if (layer.status === "available") assert.ok(layer.providerIds.length > 0);
        if (layer.status === "unavailable") assert.deepEqual(layer.providerIds, []);
      }
    }
  });

  it("has valid, non-crossing discovery boxes", () => {
    for (const j of JURISDICTIONS) {
      assert.ok(j.bounds.length >= 1, j.id);
      for (const b of j.bounds) {
        assert.ok(isValidBounds(b), `${j.id} bounds`);
        assert.ok(b.west < b.east, `${j.id} box is stored as plain halves`);
      }
    }
  });

  it("splits Alaska at the antimeridian", () => {
    const ak = coverageFor("us-ak");
    assert.ok(ak);
    assert.equal(ak.bounds.length, 2);
    assert.ok(ak.bounds.some((b) => b.west > 0 && b.east <= 180), "part west of 180");
    assert.ok(ak.bounds.some((b) => b.west >= -180 && b.east < 0), "part east of 180");
  });

  it("pairs agency names and URLs, and only uses https", () => {
    for (const j of JURISDICTIONS) {
      assert.equal(j.agencyName === null, j.agencyUrl === null, j.id);
      if (j.agencyUrl) assert.match(j.agencyUrl, /^https:\/\/[^/]+/);
    }
  });
});

describe("layer statuses", () => {
  it("reports hunt units only where a unit provider exists", () => {
    assert.deepEqual(layerStatus("us-az", "hunt-units").providerIds, ["azgfd-gmu"]);
    assert.equal(layerStatus("us-az", "hunt-units").status, "available");
    assert.deepEqual(layerStatus("us-id", "hunt-units").providerIds, ["idfg-gmu"]);
    assert.equal(layerStatus("us-id", "hunt-units").status, "available");
    assert.deepEqual(layerStatus("us-mt", "hunt-units").providerIds, ["mtfwp-deer-elk-lion"]);
    assert.equal(layerStatus("us-mt", "hunt-units").status, "available");
    assert.match(layerStatus("us-mt", "hunt-units").note, /deer, elk and mountain lion .* only; .*other species .* not included/);
    for (const j of JURISDICTIONS) {
      if (j.id === "us-az" || j.id === "us-co" || j.id === "us-id" || j.id === "us-mt" || j.id === "us-ut" || j.id === "us-nm") continue;
      assert.equal(layerStatus(j.id, "hunt-units").status, "unavailable", j.id);
      assert.deepEqual(layerStatus(j.id, "hunt-units").providerIds, [], j.id);
    }
  });

  it("lists exactly the registered unit adapters, each under its own jurisdictions", () => {
    const listed = JURISDICTIONS.flatMap((j) => layerStatus(j.id, "hunt-units").providerIds.map((p) => [j.id, p]));
    const registered = UNIT_ADAPTERS.flatMap((a) => a.info.jurisdictionIds.map((id) => [id, a.info.id]));
    assert.deepEqual(listed.sort(), registered.sort());
  });

  it("claims no parcels, access or legal hours anywhere", () => {
    for (const j of JURISDICTIONS) {
      for (const category of ["parcels", "access", "legal-hours"] as const) {
        assert.equal(layerStatus(j.id, category).status, "unavailable", `${j.id} ${category}`);
      }
      assert.match(layerStatus(j.id, "legal-hours").note, /check the agency/);
    }
  });

  it("uses BLM SMA for land management and says it is not ownership", () => {
    for (const j of JURISDICTIONS) {
      const land = layerStatus(j.id, "land-management");
      assert.deepEqual(land.providerIds, ["blm-sma"], j.id);
      assert.match(land.note, /not parcel ownership/);
    }
  });

  it("says unknown for ids outside the register, and accepts any case", () => {
    assert.equal(layerStatus("us-pr", "hunt-units").status, "unknown");
    assert.equal(coverageFor("us-xx"), null);
    assert.equal(coverageFor("US-AZ")?.name, "Arizona");
  });
});

describe("jurisdictionsInBounds", () => {
  it("returns both states for a view straddling a border", () => {
    // Arizona Strip / southern Utah.
    const azUt = ids(jurisdictionsInBounds({ west: -113, south: 36.7, east: -112, north: 37.3 }));
    assert.ok(azUt.includes("us-az") && azUt.includes("us-ut"), azUt.join());
    // Lost Trail Pass area on the Idaho-Montana line.
    const idMt = ids(jurisdictionsInBounds({ west: -114.3, south: 45.5, east: -113.6, north: 45.9 }));
    assert.ok(idMt.includes("us-id") && idMt.includes("us-mt"), idMt.join());
    // Northern-tier Pennsylvania / Southern Tier of New York.
    const paNy = ids(jurisdictionsInBounds({ west: -77, south: 41.8, east: -76.5, north: 42.2 }));
    assert.ok(paNy.includes("us-pa") && paNy.includes("us-ny"), paNy.join());
  });

  it("finds Alaska in a view crossing the antimeridian", () => {
    const found = ids(jurisdictionsInBounds({ west: 170, south: 50, east: -170, north: 55 }));
    assert.deepEqual(found, ["us-ak"]);
    // The same view as a wrapped map viewport.
    const wrapped = ids(jurisdictionsInBounds({ west: 170, south: 50, east: 190, north: 55 }));
    assert.deepEqual(wrapped, ["us-ak"]);
  });

  it("finds Hawaii, including the Northwestern Hawaiian Islands", () => {
    assert.deepEqual(
      ids(jurisdictionsInBounds({ west: -158.5, south: 20.5, east: -157.5, north: 21.8 })),
      ["us-hi"],
    );
    assert.deepEqual(
      ids(jurisdictionsInBounds({ west: -178.4, south: 28.1, east: -178.2, north: 28.5 })),
      ["us-hi"],
    );
  });

  it("returns everything for a whole-world view and nothing for open ocean", () => {
    assert.equal(jurisdictionsInBounds({ west: -180, south: -90, east: 180, north: 90 }).length, 51);
    assert.deepEqual(jurisdictionsInBounds({ west: -140, south: 0, east: -130, north: 10 }), []);
    assert.deepEqual(jurisdictionsInBounds({ west: 0, south: 10, east: 1, north: 5 }), []);
  });
});

describe("jurisdictionsAt", () => {
  it("finds Alaska at an Aleutian point west of 180", () => {
    assert.deepEqual(ids(jurisdictionsAt({ lng: 179.5, lat: 51.8 })), ["us-ak"]);
    // Adak, east of 180.
    assert.deepEqual(ids(jurisdictionsAt({ lng: -176.6, lat: 51.88 })), ["us-ak"]);
  });

  it("finds Hawaii at Honolulu", () => {
    assert.deepEqual(ids(jurisdictionsAt({ lng: -157.8583, lat: 21.3069 })), ["us-hi"]);
  });

  it("includes DC for a point on the National Mall", () => {
    assert.ok(ids(jurisdictionsAt({ lng: -77.0365, lat: 38.8895 })).includes("us-dc"));
  });

  it("returns candidates, not a boundary answer, near borders", () => {
    // Four Corners: every one of the four boxes touches it.
    const fc = ids(jurisdictionsAt({ lng: -109.045, lat: 36.999 }));
    for (const id of ["us-az", "us-co", "us-nm", "us-ut"]) assert.ok(fc.includes(id), id);
  });

  it("returns nothing for invalid points", () => {
    assert.deepEqual(jurisdictionsAt({ lng: Number.NaN, lat: 40 }), []);
    assert.deepEqual(jurisdictionsAt({ lng: -100, lat: 95 }), []);
  });
});
