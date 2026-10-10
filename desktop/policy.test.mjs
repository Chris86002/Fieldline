import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORIGIN, HOST, PORT, PROFILE_NAME, AUTH_HEADER, isAppUrl, isAppNavigation,
  isExternalUrl, isAllowedRequest, canRequestLocation, isAppDownload, assertResources,
} from "./policy.mjs";

test("origin and profile remain stable across launches and upgrades", () => {
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 47831);
  assert.equal(ORIGIN, "http://127.0.0.1:47831");
  assert.equal(PROFILE_NAME, "Fieldline");
});

test("packaging rejects missing UI or server-function resources", () => {
  const root = mkdtempSync(join(tmpdir(), "fieldline-resources-"));
  try {
    assert.throws(() => assertResources(root), /Missing desktop resource/);
    for (const folder of ["server/_ssr", "public/assets", "public/icons"]) mkdirSync(join(root, folder), { recursive: true });
    for (const file of ["server/index.mjs", "public/icons/fieldline-512.png", "public/assets/ui.js", "public/assets/ui.css"]) writeFileSync(join(root, file), "");
    assert.throws(() => assertResources(root), /Missing server function: search/);
    writeFileSync(join(root, "server/_ssr/search.functions-test.mjs"), "");
    assert.throws(() => assertResources(root), /Missing server function: weather/);
    writeFileSync(join(root, "server/_ssr/weather.functions-test.mjs"), "");
    assert.doesNotThrow(() => assertResources(root));
    rmSync(join(root, "public/assets/ui.css"));
    assert.throws(() => assertResources(root), /JavaScript\/CSS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigation stays on the app root; URLs cannot smuggle credentials or another origin", () => {
  assert.ok(isAppNavigation(`${ORIGIN}/?install=1`));
  assert.ok(isAppUrl(`${ORIGIN}/api/dem/1/0/0`));
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", `${ORIGIN}.evil.test/`, "http://localhost:47831/", "http://127.0.0.1:47832/", "http://user@127.0.0.1:47831/"]) {
    assert.equal(isAppUrl(url), false, url);
  }
  assert.equal(isAppNavigation(`${ORIGIN}/api/dem/1/0/0`), false);
});

test("only narrowly allowed HTTPS provider websites may open externally", () => {
  assert.ok(isExternalUrl("https://www.openstreetmap.org/copyright"));
  for (const url of ["https://evil.test", "https://www.openstreetmap.org.evil.test", "https://user@www.openstreetmap.org", "https://www.openstreetmap.org:8443", "file:///tmp/a", "http://www.blm.gov", "https://127.0.0.1"]) {
    assert.equal(isExternalUrl(url), false, url);
  }
});

test("loopback requests require private authentication and reject cross-site requests", () => {
  const headers = { host: "127.0.0.1:47831", [AUTH_HEADER]: "private", origin: ORIGIN, "sec-fetch-site": "same-origin" };
  assert.ok(isAllowedRequest(headers, "private"));
  assert.equal(isAllowedRequest(headers, "other"), false);
  assert.equal(isAllowedRequest({ ...headers, host: "evil.test:47831" }, "private"), false);
  assert.equal(isAllowedRequest({ ...headers, origin: "https://evil.test" }, "private"), false);
  assert.equal(isAllowedRequest({ ...headers, "sec-fetch-site": "cross-site" }, "private"), false);
  assert.equal(isAllowedRequest({ host: headers.host }, "private"), false);
});

test("permissions only cover geolocation in the trusted main frame; exports are local blobs", () => {
  assert.ok(canRequestLocation("geolocation", ORIGIN, `${ORIGIN}/`, true));
  for (const permission of ["notifications", "media", "clipboard-read", "fileSystem"]) {
    assert.equal(canRequestLocation(permission, ORIGIN, `${ORIGIN}/`, true), false);
  }
  assert.equal(canRequestLocation("geolocation", "https://evil.test", ORIGIN, true), false);
  assert.equal(canRequestLocation("geolocation", ORIGIN, ORIGIN, false), false);
  assert.ok(isAppDownload(`blob:${ORIGIN}/id`));
  assert.equal(isAppDownload("blob:https://evil.test/id"), false);
  assert.equal(isAppDownload(`${ORIGIN}/file`), false);
});
