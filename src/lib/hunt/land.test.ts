import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { identifyLand, landFromResults, landTag } from "./land.ts";

const realFetch = globalThis.fetch;

function stubFetch(response: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => response()) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function sma(code: string, area: number, extra: Record<string, string> = {}) {
  return {
    layerName: "Surface Management Agency",
    attributes: { ADMIN_AGENCY_CODE: code, Shape_Area: String(area), ADMIN_ST: "AZ", ...extra },
  };
}

describe("surface-management identification", () => {
  it("treats an empty successful answer as unknown ownership, not private", () => {
    const hit = landFromResults([], 10);
    assert.equal(hit.status, "no-record");
    assert.equal(hit.tone, "unknown");
    assert.equal(hit.label, "Ownership unknown");
    assert.doesNotMatch(hit.label + hit.note, /likely private|treat it as private/i);
    assert.equal(landTag(hit), "Owner unknown");
    assert.equal(hit.checkedAt, 10);
  });

  it("does not treat unknown or undetermined agency codes as records", () => {
    const hit = landFromResults([sma("UND", 5), sma("UNK", 6), sma("", 7)], 1);
    assert.equal(hit.status, "no-record");
  });

  it("gives an unrecognized agency an unknown tone instead of public", () => {
    const hit = landFromResults([sma("XYZ", 5)], 1);
    assert.equal(hit.status, "record");
    assert.equal(hit.agency, "XYZ");
    assert.equal(hit.tone, "unknown");
    assert.match(hit.note, /access is unknown/i);
    assert.equal(landTag(hit), "XYZ (unrecognized)");
  });

  it("keeps known private data as private", () => {
    const hit = landFromResults([sma("PVT", 5)], 1);
    assert.equal(hit.tone, "private");
    assert.equal(landTag(hit), "Private");
  });

  it("lists every overlapping record instead of silently dropping them", () => {
    const hit = landFromResults(
      [sma("BLM", 900, { ADMIN_UNIT_NAME: "Safford" }), sma("USFS", 50, { ADMIN_UNIT_NAME: "Coronado" }), sma("BLM", 900, { ADMIN_UNIT_NAME: "Safford" })],
      1,
    );
    assert.equal(hit.agency, "USFS");
    assert.equal(hit.tone, "public");
    assert.deepEqual(
      hit.others.map((record) => record.agency),
      ["BLM"],
    );
  });

  it("throws on provider failure so the UI can show an outage", async () => {
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await assert.rejects(identifyLand(-111, 34), /unavailable/);
  });

  it("throws when ArcGIS reports an error inside an HTTP 200 body", async () => {
    stubFetch(() => Response.json({ error: { code: 500, message: "Service busy" } }));
    await assert.rejects(identifyLand(-111, 34), /unavailable/);
  });

  it("returns a no-record answer for an empty successful response", async () => {
    stubFetch(() => Response.json({ results: [] }));
    const hit = await identifyLand(-111, 34);
    assert.equal(hit.status, "no-record");
  });
});
