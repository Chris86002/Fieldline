import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { APP_VERSION } from "./app-version.ts";

it("matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(APP_VERSION, pkg.version);
});
