#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000";
const screenshots = resolve(process.env.FIELDLINE_SCREENSHOTS_DIR ?? "screenshots");
const icon = readFileSync(new URL("../public/icons/fieldline-180.png", import.meta.url));
const errors = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
mkdirSync(screenshots, { recursive: true });

const savedWaypoint = {
  id: "smoke-stand",
  name: "Smoke Stand",
  kind: "stand",
  lng: -111.38,
  lat: 33.95,
  notes: "Saved locally",
  hunt: "Smoke test",
  goodWinds: [0],
  createdAt: 1,
};

function mockUnits(idaho = false) {
  return {
    features: Array.from({ length: 22 }, (_, index) => {
      const lng = -111.38 + ((index % 5) - 2) * 0.02;
      const lat = 33.95 + (Math.floor(index / 5) - 2) * 0.02;
      const ring = [
        [lng - 0.008, lat - 0.008],
        [lng + 0.008, lat - 0.008],
        [lng + 0.008, lat + 0.008],
        [lng - 0.008, lat + 0.008],
        [lng - 0.008, lat - 0.008],
      ];
      return {
        type: "Feature",
        properties: idaho
          ? { NAME: `Zone ${index + 1}`, Elk_Zone: "Mock region" }
          : { GMU: String(index + 1), REG_NAME: "Mock region", SQ_MILES: 100, LANDOWN: "Public", HUNT: "Deer", USFSName: "Mock forest" },
        geometry: { type: "Polygon", coordinates: [ring] },
      };
    }),
  };
}

async function installMocks(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "tiles.openfreemap.org") {
      if (url.pathname === "/planet") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            tilejson: "3.0.0",
            tiles: ["https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf"],
            minzoom: 0,
            maxzoom: 14,
            vector_layers: [
              "transportation",
              "water",
              "landcover",
              "park",
              "waterway",
              "place",
            ].map((id) => ({ id, fields: {} })),
          }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: "application/x-protobuf", body: Buffer.alloc(0) });
      }
      return;
    }
    if (url.hostname === "gis.blm.gov" && url.pathname.includes("/identify")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"results":[]}' });
      return;
    }
    if (
      url.hostname === "server.arcgisonline.com" ||
      url.hostname === "basemap.nationalmap.gov" ||
      url.hostname === "gis.blm.gov"
    ) {
      await route.fulfill({ status: 200, contentType: "image/png", body: icon });
      return;
    }
    if (url.hostname === "services8.arcgis.com") {
      await route.fulfill({ status: 200, contentType: "application/geo+json", body: JSON.stringify(mockUnits()) });
      return;
    }
    if (url.hostname === "gisportal-idfg.idaho.gov") {
      await route.fulfill({ status: 200, contentType: "application/geo+json", body: JSON.stringify(mockUnits(true)) });
      return;
    }
    if (url.pathname.startsWith("/api/dem/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: icon });
      return;
    }
    await route.continue();
  });
}

async function openSavedPanel(page, mobile) {
  if (!mobile) return;
  await page.getByRole("button", { name: "Saved" }).click();
  await page.getByRole("dialog", { name: "Saved" }).waitFor({ state: "visible" });
}

async function waitForBrand(page) {
  await page.getByText("FIELDLINE", { exact: true }).filter({ visible: true }).first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

async function exerciseMapControls(page) {
  const state = page.getByRole("group", { name: "Hunt state" });
  const arizona = state.getByRole("button", { name: "AZ", exact: true });
  const idaho = state.getByRole("button", { name: "ID", exact: true });
  await idaho.click();
  assert.equal(await idaho.getAttribute("data-on"), "true");

  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("dialog", { name: "Layers" }).waitFor({ state: "visible" });
  await page
    .getByText("Idaho Fish and Game units. Reference lines, not the legal boundary.", { exact: true })
    .waitFor({ state: "visible" });
  if (await page.evaluate(() => /iPhone|iPod|iPad/.test(navigator.userAgent))) {
    await page.getByRole("button", { name: "Add to home screen", exact: true }).click();
    await page.getByRole("dialog", { name: "iPhone" }).waitFor({ state: "visible" });
    await page.getByText("Tap Share, then Add to Home Screen.", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }

  await arizona.click();
  assert.equal(await arizona.getAttribute("data-on"), "true");
  const search = page.getByRole("textbox", { name: "Search places" });
  await search.fill("smoke search");
  await page.getByText("Press Enter to search nearby places.", { exact: true }).waitFor({ state: "visible" });
  await search.fill("");
}

try {
  const viewports = [
    { name: "desktop", width: 1280, height: 800, mobile: false },
    { name: "mobile", width: 390, height: 844, mobile: true },
  ];

  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      serviceWorkers: "block",
      acceptDownloads: true,
      ...(viewport.mobile
        ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }
        : {}),
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${viewport.name}: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`${viewport.name}: ${error.message}`));
    await installMocks(page);
    await page.addInitScript(
      ({ waypoint }) => {
        if (sessionStorage.getItem("fieldline-smoke-seeded") !== "1") {
          localStorage.setItem(
            "fieldline-v1",
            JSON.stringify({
              state: { waypoints: [waypoint], tracks: [], introDismissed: true },
              version: 0,
            }),
          );
          localStorage.setItem("fieldline-install-dismissed", "1");
          sessionStorage.setItem("fieldline-smoke-seeded", "1");
        }
      },
      { waypoint: savedWaypoint },
    );

    const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.equal(response?.status(), 200, `${viewport.name} should load successfully`);
    await waitForBrand(page);
    await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 15_000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1),
      false,
      `${viewport.name} should not have horizontal overflow`,
    );

    if (viewport.mobile) {
      for (const label of ["GPS", "Mark", "Measure", "Track", "Layers", "Saved"]) {
        await page.getByRole("button", { name: label, exact: true }).waitFor({ state: "visible" });
      }
    }
    await exerciseMapControls(page);
    if (viewport.mobile) {
      await openSavedPanel(page, true);
    }
    await page.getByText(savedWaypoint.name, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });

    const importedName = `Smoke Import ${viewport.name}`;
    await page.locator('input[type="file"]').setInputFiles({
      name: "smoke.gpx",
      mimeType: "application/gpx+xml",
      buffer: Buffer.from(
        `<?xml version="1.0"?><gpx version="1.1" creator="Fieldline"><wpt lat="33.76" lon="-111.27"><name>${importedName}</name></wpt></gpx>`,
      ),
    });
    await page.getByText(importedName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export GPX" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "fieldline.gpx");
    await page.screenshot({ path: resolve(screenshots, `${viewport.name}.png`) });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForBrand(page);
    await openSavedPanel(page, viewport.mobile);
    await page.getByText(importedName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    await page.goto(`${baseUrl}/?install=1&platform=ios`, { waitUntil: "domcontentloaded" });
    await waitForBrand(page);
    assert.equal((await page.locator("body").innerText()).includes("Grok"), false);
    await context.close();
  }

  assert.deepEqual(errors, [], "browser console and page should be free of errors");
  console.log(`Fieldline browser smoke passed for desktop and mobile at ${baseUrl}`);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
