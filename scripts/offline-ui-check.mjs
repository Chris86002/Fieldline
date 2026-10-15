#!/usr/bin/env node
/**
 * Offline maps screens, end to end against a running production build (live
 * providers, about 80 polite requests; not part of `npm test`):
 *
 *   npm run build && npm start          # serves http://127.0.0.1:3000
 *   node scripts/offline-ui-check.mjs   # env FIELDLINE_URL, FIELDLINE_SCREENSHOTS_DIR
 *
 * Plans a small Flagstaff area at map zoom 12 (USGS base map, 3D terrain and
 * sun shade on), downloads it
 * with a pause and resume, then blocks every tile host and reloads: every
 * map tile must come from the package (only OpenFreeMap's TileJSON, asked
 * online first by design, may reach the network). Zooms two levels past the
 * package (tiles are enlarged, screenshot), checks the spot card's "Offline
 * here" line, shows the area outline, and deletes the area.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000";
const shots = resolve(process.env.FIELDLINE_SCREENSHOTS_DIR ?? "screenshots");
mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fieldline-offline-ui-"));
const context = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const TILE_HOSTS = ["basemap.nationalmap.gov", "tiles.openfreemap.org", "gis.blm.gov", "server.arcgisonline.com"];

try {
  // Fixture view: Flagstaff at map zoom 12 (not personal data).
  await page.addInitScript(() => {
    if (!localStorage.getItem("fieldline-v1")) {
      localStorage.setItem(
        "fieldline-v1",
        JSON.stringify({ state: { waypoints: [], tracks: [], introDismissed: true, lastView: { lng: -111.65, lat: 35.2, zoom: 12, bearing: 0, pitch: 0 } }, version: 0 }),
      );
      localStorage.setItem("fieldline-install-dismissed", "1");
    }
  });
  const visible = (name) => page.locator("button:visible", { hasText: new RegExp(`^${name}$`) }).first();
  const openOffline = async () => {
    await visible("Layers").click();
    await page.getByRole("button", { name: "Offline maps" }).click();
  };

  await page.goto(baseUrl);
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(2500);

  // Satellite style on USGS imagery, so nothing on screen is live-only; 3D
  // terrain on, which asks for terrain tiles differently from hillshade
  // (docs/storage.md).
  await visible("Layers").click();
  await page.getByRole("radio", { name: "Satellite", exact: true }).click();
  await page.getByRole("radio", { name: "USGS", exact: true }).click();
  const terrain = page.getByRole("switch", { name: "3D terrain" });
  if ((await terrain.getAttribute("aria-checked")) !== "true") await terrain.click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Offline maps" }).click();
  const dialog = page.getByRole("dialog", { name: "Offline maps" });
  await dialog.getByRole("heading", { name: "Download an area" }).waitFor();
  await dialog.getByLabel("From zoom").selectOption("12");
  await dialog.getByLabel("To zoom").selectOption("12");
  assert.equal(await dialog.locator("input[type=checkbox]:checked").count(), 4, "imagery, public land, roads/labels and terrain preselected");
  assert.match((await dialog.getByText(/^About .* files/).textContent()) ?? "", /^About [\d.]+ MB, \d+ files/);
  assert.match((await dialog.getByText(/^Not included:/).allTextContents()).join(" "), /Hunt units/);
  await page.screenshot({ path: join(shots, "offline-1-plan.png") });

  // Download, pause almost at once, then resume.
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await dialog.getByRole("button", { name: "Pause" }).click({ timeout: 10000 });
  await dialog.getByText(/^Paused\./).waitFor({ timeout: 30000 });
  assert.equal(await dialog.locator("li").first().getByText("Paused", { exact: true }).count(), 1);
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await dialog.getByText(/^Ready offline: all/).waitFor({ timeout: 180000 });
  assert.equal(await dialog.locator("li").first().getByText("Ready offline", { exact: true }).count(), 1);
  await page.screenshot({ path: join(shots, "offline-2-ready.png") });

  // The package's tile ranges per layer, from its record in IndexedDB.
  const ranges = await page.evaluate(
    () =>
      new Promise((done, fail) => {
        const open = indexedDB.open("fieldline-content");
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction("packages").objectStore("packages").getAll();
          request.onsuccess = () => {
            const out = {};
            for (const record of request.result) for (const layer of record.active.layers) (out[layer.layerId] ??= []).push(...layer.ranges);
            open.result.close();
            done(out);
          };
        };
      }),
  );
  const inPackage = (layerId, z, x, y) => (ranges[layerId] ?? []).some((r) => r.z === z && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);

  // Every tile host unreachable; reload at the same view. Any tile the package
  // holds must come from it. With 3D terrain on the map is tilted, and a tilted
  // view also draws other zooms toward the horizon and edges outside the
  // flat-view rectangle; those are expected misses, listed, not failures.
  const missed = [];
  const outside = [];
  let tileJson = 0;
  await context.route(
    (url) => TILE_HOSTS.includes(url.hostname) || url.pathname.startsWith("/api/dem/"),
    (route) => {
      const url = new URL(route.request().url());
      // Land lookups (identify) are online-only by design; only tiles count here.
      if (url.pathname === "/planet") tileJson += 1;
      else if (!url.pathname.includes("/identify")) {
        const nums = (url.pathname.match(/(\d+)\/(\d+)\/(\d+)(\.\w+)?$/) ?? []).slice(1, 4).map(Number);
        const [layerId, z, x, y] = url.pathname.startsWith("/api/dem/")
          ? ["dem", nums[0], nums[1], nums[2]]
          : url.hostname === "tiles.openfreemap.org"
            ? ["ofm-vector", nums[0], nums[1], nums[2]]
            : url.hostname === "gis.blm.gov"
              ? ["blm-sma", nums[0], nums[2], nums[1]]
              : url.pathname.includes("USGSImageryOnly")
                ? ["usgs-imagery", nums[0], nums[2], nums[1]]
                : ["other", ...nums];
        (inPackage(layerId, z, x, y) ? missed : outside).push(`${layerId} ${z}/${x}/${y}`);
      }
      return route.abort("internetdisconnected");
    },
  );
  await page.reload();
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(shots, "offline-3-tile-hosts-blocked.png") });
  assert.deepEqual(missed, [], `packaged tiles reached the network: ${missed.join(", ")}`);
  assert.ok(tileJson <= 1, "OpenFreeMap's TileJSON is asked online once, then served from the package");
  console.log(`Tiles outside the package the tilted view asked for (expected): ${outside.length ? outside.join(", ") : "none"}`);

  // Two levels past the package: enlarged from it (see the screenshot).
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(shots, "offline-4-past-package-zoom.png") });

  // The spot card says the spot is covered.
  await canvas.click({ button: "right", position: { x: box.width / 2, y: box.height / 2 } });
  const here = page.getByText(/^Offline here:/);
  await here.waitFor({ timeout: 10000 });
  assert.match((await here.textContent()) ?? "", /USGS imagery zoom 12.*terrain zoom 12/);
  await page.screenshot({ path: join(shots, "offline-5-spot.png") });
  await page.keyboard.press("Escape");

  // Show on map, then delete.
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await openOffline();
  await dialog.getByRole("button", { name: "Show on map" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, "offline-6-outline.png") });
  await openOffline();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByText(/^Deleted “/).waitFor({ timeout: 10000 });
  assert.equal(await dialog.getByText("None yet.").count(), 1);
  assert.deepEqual(errors, []);
  console.log(`offline-ui-check passed; screenshots in ${shots}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
