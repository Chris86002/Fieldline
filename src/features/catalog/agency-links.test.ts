import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The desktop shell only opens allowlisted HTTPS hosts; agency links must pass it.
import { isExternalUrl } from "../../../desktop/policy.mjs";
import { JURISDICTIONS } from "./coverage-data.ts";

describe("agency links", () => {
  it("every agency link in the coverage register can open from the desktop app", () => {
    for (const place of JURISDICTIONS) {
      if (!place.agencyUrl) continue;
      assert.ok(isExternalUrl(place.agencyUrl), `${place.name}: ${place.agencyUrl} is not in desktop/policy.mjs`);
    }
  });
});
