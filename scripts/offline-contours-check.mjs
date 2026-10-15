#!/usr/bin/env node
/**
 * Contours and land cover offline (MAP-03), end to end against a running
 * production build (live providers, a few hundred polite requests; not part
 * of `npm test`):
 *
 *   npm run build && npm start               # serves http://127.0.0.1:3000
 *   node scripts/offline-contours-check.mjs  # env FIELDLINE_URL, FIELDLINE_SCREENSHOTS_DIR
 *
 * A fresh profile opens on the Terrain style (contours and land cover on)
 * near Flagstaff at map zoom 12, downloads that view (public land, OpenFreeMap
 * vector tiles and fonts, terrain tiles), then blocks every tile host and the
 * terrain proxy and reloads. It checks that no tile the package holds reached
 * the network, that contours are drawn (screenshots with contours on and off
 * differ along the lines), then zooms two levels past the package on the Field
 * style with sun shade off (contours the only terrain consumer) and checks
 * that no terrain tile was asked for twice (failed tiles are remembered), and
 * saves the screenshots. Contour tiles are made
 * in the browser from the packaged terrain tiles; nothing about them is
 * downloaded separately.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000";
const shots = resolve(process.env.FIELDLINE_SCREENSHOTS_DIR ?? "screenshots");
mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "fieldline-offline-contours-"));
const context = await chromium.launchPersistentContext(profile, {
  viewport: { width: 1280, height: 800 },
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const TILE_HOSTS = ["basemap.nationalmap.gov", "tiles.openfreemap.org", "gis.blm.gov", "server.arcgisonline.com"];

/** Fraction of pixels (inside the map, away from panels) that differ between two screenshots. */
async function pixelDifference(a, b) {
  return page.evaluate(
    async ([one, two]) => {
      const load = async (base64) => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const [x, y] = await Promise.all([load(one), load(two)]);
      const read = (bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context2d = canvas.getContext("2d");
        context2d.drawImage(bitmap, 0, 0);
        // The map area right of the side panel, between the search bar and the bottom controls.
        return context2d.getImageData(420, 140, bitmap.width - 460, bitmap.height - 320).data;
      };
      const [p, q] = [read(x), read(y)];
      let changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) changed += 1;
      }
      return changed / (p.length / 4);
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

try {
  // Fixture view: the San Francisco Peaks foothills north of Flagstaff (not personal data).
  await page.addInitScript(() => {
    if (!localStorage.getItem("fieldline-v1")) {
      localStorage.setItem(
        "fieldline-v1",
        JSON.stringify({ state: { waypoints: [], tracks: [], introDismissed: true, lastView: { lng: -111.66, lat: 35.29, zoom: 12, bearing: 0, pitch: 0 } }, version: 0 }),
      );
      localStorage.setItem("fieldline-install-dismissed", "1");
    }
  });
  const visible = (name) => page.locator("button:visible", { hasText: new RegExp(`^${name}$`) }).first();

  await page.goto(baseUrl);
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(3000);

  // A new profile starts on Terrain with contours and land cover on.
  await visible("Layers").click();
  assert.equal(await page.getByRole("radio", { name: "Terrain", exact: true }).getAttribute("aria-checked"), "true", "Terrain is the default style");
  assert.equal(await page.getByRole("switch", { name: "Contours" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("switch", { name: "Land cover" }).getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "Offline maps" }).click();
  const dialog = page.getByRole("dialog", { name: "Offline maps" });
  await dialog.getByRole("heading", { name: "Download an area" }).waitFor();
  await dialog.getByLabel("From zoom").selectOption("12");
  await dialog.getByLabel("To zoom").selectOption("12");
  // Terrain has no raster base: public land, vector tiles and terrain (fonts are added to every package).
  assert.equal(await dialog.locator("input[type=checkbox]:checked").count(), 3, "public land, roads/labels and terrain preselected");
  assert.equal(await dialog.getByText(/Esri/).count(), 0, "nothing live-only on screen");
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await dialog.getByText(/^Ready offline: all/).waitFor({ timeout: 240000 });
  await page.screenshot({ path: join(shots, "contours-offline-1-ready.png") });

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
  assert.ok(ranges.dem?.length, "terrain tiles are in the package");
  const inPackage = (layerId, z, x, y) => (ranges[layerId] ?? []).some((r) => r.z === z && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);

  // Every tile host and the terrain proxy unreachable; reload at the same view.
  const missed = [];
  const outside = [];
  await context.route(
    (url) => TILE_HOSTS.includes(url.hostname) || url.pathname.startsWith("/api/dem/"),
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/planet" && !url.pathname.includes("/identify")) {
        const nums = (url.pathname.match(/(\d+)\/(\d+)\/(\d+)(\.\w+)?$/) ?? []).slice(1, 4).map(Number);
        const [layerId, z, x, y] = url.pathname.startsWith("/api/dem/")
          ? ["dem", nums[0], nums[1], nums[2]]
          : url.hostname === "tiles.openfreemap.org"
            ? ["ofm-vector", nums[0], nums[1], nums[2]]
            : url.hostname === "gis.blm.gov"
              ? ["blm-sma", nums[0], nums[2], nums[1]]
              : ["other", ...nums];
        (inPackage(layerId, z, x, y) ? missed : outside).push(`${layerId} ${z}/${x}/${y}`);
      }
      return route.abort("internetdisconnected");
    },
  );
  await page.reload();
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(8000);
  const withContours = await page.screenshot({ path: join(shots, "contours-offline-2-blocked-on.png") });
  assert.deepEqual(missed, [], `packaged tiles reached the network: ${missed.join(", ")}`);

  // Contours off, same view: the difference is the contour lines and labels.
  await visible("Layers").click();
  await page.getByRole("switch", { name: "Contours" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(2500);
  const withoutContours = await page.screenshot({ path: join(shots, "contours-offline-3-blocked-off.png") });
  const changed = await pixelDifference(withContours, withoutContours);
  console.log(`Pixels that changed when contours were turned off (offline): ${(changed * 100).toFixed(2)} %`);
  assert.ok(changed > 0.01, "contours drew from the package while offline");
  assert.deepEqual(missed, []);
  console.log(`Tiles outside the package the map asked for (expected at the edges): ${outside.length ? outside.join(", ") : "none"}`);

  // Contours back on, two zooms past the package: terrain is enlarged from packaged
  // ancestors, and a terrain tile that can't load is asked for once, not by every
  // contour tile next to it. Field style (no elevation tint) and sun shade off, so
  // contours are the only terrain consumer (tint and hillshade ask for the same URLs).
  await visible("Layers").click();
  await page.getByRole("switch", { name: "Contours" }).click();
  await page.getByRole("switch", { name: "Sun shade" }).click();
  await page.getByRole("radio", { name: "Field", exact: true }).click();
  assert.equal(await page.getByRole("switch", { name: "Contours" }).getAttribute("aria-checked"), "true", "Field shares the Terrain contour switch");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const before = outside.length;
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(8000);
  await page.screenshot({ path: join(shots, "contours-offline-4-past-package.png") });
  const deeper = outside.slice(before).filter((entry) => entry.startsWith("dem "));
  const repeated = deeper.filter((entry, index) => deeper.indexOf(entry) !== index);
  console.log(`Terrain requests past the package: ${deeper.length} for ${new Set(deeper).size} tiles${repeated.length ? `; repeated: ${[...new Set(repeated)].join(", ")}` : ""}`);
  assert.ok(deeper.length > 0, "contours asked for terrain past the package");
  assert.deepEqual(repeated, [], "each terrain tile is asked for once");
  assert.deepEqual(missed, [], `packaged tiles reached the network: ${missed.join(", ")}`);
  assert.deepEqual(errors, []);
  console.log(`offline-contours-check passed; screenshots in ${shots}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
