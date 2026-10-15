#!/usr/bin/env node
/**
 * Fixed-view map gallery for before/after design review (spec §17 "Design
 * acceptance"). A manual visual tool, not a CI test: it loads live tiles and
 * live hunt-unit layers, so results depend on the network and providers.
 *
 * Usage (against a running build, e.g. `npm run build && npm run start`):
 *   FIELDLINE_URL=http://127.0.0.1:3100 node scripts/map-gallery.mjs
 *
 * Environment:
 *   FIELDLINE_URL               app origin (default http://127.0.0.1:3000)
 *   FIELDLINE_GALLERY_LABEL     sub-folder name (default "current")
 *   FIELDLINE_GALLERY_DIR       output folder (default screenshots/gallery/<label>)
 *   FIELDLINE_GALLERY_BASEMAPS  comma list of base maps (default "terrain,satellite,field,topo";
 *                               builds before MAP-03 know "hybrid", "street" instead of
 *                               "terrain", "field"). An entry may carry settings after a
 *                               colon, e.g. "satellite:showImageryContours=true", so one run
 *                               can mix styles with and without contours or land cover.
 *   FIELDLINE_GALLERY_VIEWS     comma list of view ids to keep (default all)
 *   FIELDLINE_GALLERY_VIEWPORTS comma list: desktop, narrow (default both)
 *   FIELDLINE_GALLERY_PREFS     JSON merged into the saved settings prefs,
 *                               e.g. '{"publicOpacity":0.2}' for opacity trials
 *   FIELDLINE_GALLERY_SETTLE_MS extra wait after the network goes quiet (default 2500)
 *
 * Each shot seeds localStorage (`fieldline-v1` lastView plus one mark and one
 * short track near the center, and `fieldline-settings` with the base map), and
 * fixes the clock at about 10:00 local solar time so sun shade is repeatable.
 * Images are written as <view>-z<zoom>-<basemap>-<viewport>.png. screenshots/
 * is gitignored; do not commit gallery images.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000";
const label = process.env.FIELDLINE_GALLERY_LABEL ?? "current";
const outDir = resolve(process.env.FIELDLINE_GALLERY_DIR ?? `screenshots/gallery/${label}`);
const basemaps = (process.env.FIELDLINE_GALLERY_BASEMAPS ?? "terrain,satellite,field,topo").split(",").map((s) => s.trim()).filter(Boolean);

/** "satellite:showImageryContours=true;contourDetail=fine" → base map, file tag and settings. */
function parseEntry(entry) {
  const [basemap, extra = ""] = entry.split(":");
  const prefs = {};
  for (const pair of extra.split(";").filter(Boolean)) {
    const [key, raw] = pair.split("=");
    prefs[key] = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const tag = extra ? `${basemap}+${Object.keys(prefs).map((key) => `${key}-${prefs[key]}`).join("+")}` : basemap;
  return { basemap, tag, prefs };
}
const viewFilter = process.env.FIELDLINE_GALLERY_VIEWS ? new Set(process.env.FIELDLINE_GALLERY_VIEWS.split(",").map((s) => s.trim())) : null;
const viewportFilter = (process.env.FIELDLINE_GALLERY_VIEWPORTS ?? "desktop,narrow").split(",").map((s) => s.trim());
const extraPrefs = process.env.FIELDLINE_GALLERY_PREFS ? JSON.parse(process.env.FIELDLINE_GALLERY_PREFS) : {};
const settleMs = Number(process.env.FIELDLINE_GALLERY_SETTLE_MS ?? 2500);

/** Fixed camera views from the spec's gallery list. Two zooms each. */
const VIEWS = [
  { id: "az-four-peaks", name: "Arizona desert, Four Peaks", lng: -111.325, lat: 33.684, zooms: [10.5, 13.5] },
  { id: "id-sawtooths", name: "Forested mountains, Sawtooths ID", lng: -114.98, lat: 44.12, zooms: [10.5, 13.5] },
  { id: "pa-rural", name: "Eastern rural, Penns Valley PA", lng: -77.55, lat: 40.86, zooms: [11, 14] },
  { id: "az-flagstaff", name: "Town, Flagstaff AZ", lng: -111.651, lat: 35.198, zooms: [12, 15] },
  { id: "ak-brooks", name: "Alaska, Brooks Range near Atigun Pass", lng: -149.6, lat: 68.13, zooms: [9, 12] },
  { id: "hi-mauna-kea", name: "Hawaii, Mauna Kea", lng: -155.468, lat: 19.821, zooms: [10, 13] },
];

const VIEWPORTS = [
  { id: "desktop", width: 1280, height: 800, mobile: false },
  { id: "narrow", width: 390, height: 844, mobile: true },
];

/** About 10:00 local solar time on a fixed autumn date, for repeatable sun shade. */
function fixedTime(lng) {
  const utcHours = 10 - lng / 15;
  return new Date(Date.UTC(2026, 9, 14, 0, 0, 0) + utcHours * 3_600_000);
}

function seed(view, zoom, basemap, entryPrefs = {}) {
  const dLng = 0.004 * 2 ** (13 - zoom);
  const dLat = 0.003 * 2 ** (13 - zoom);
  const now = 1_760_000_000_000;
  const hunt = {
    state: {
      waypoints: [
        {
          id: "gallery-mark",
          name: "Gallery mark",
          kind: "glass",
          lng: view.lng + dLng,
          lat: view.lat + dLat,
          notes: "",
          hunt: "",
          goodWinds: [],
          createdAt: now,
        },
      ],
      tracks: [
        {
          id: "gallery-track",
          name: "Gallery track",
          visible: true,
          createdAt: now,
          points: [
            { lng: view.lng - 2 * dLng, lat: view.lat - dLat, t: now },
            { lng: view.lng - dLng, lat: view.lat - 0.2 * dLat, t: now + 60_000 },
            { lng: view.lng, lat: view.lat - 0.6 * dLat, t: now + 120_000 },
            { lng: view.lng + 0.6 * dLng, lat: view.lat + 0.4 * dLat, t: now + 180_000 },
          ],
        },
      ],
      introDismissed: true,
      lastView: { lng: view.lng, lat: view.lat, zoom, bearing: 0, pitch: 0 },
    },
    version: 0,
  };
  const settings = { version: 1, state: { prefs: { basemap, startupView: "last", ...extraPrefs, ...entryPrefs }, preset: null, presetEdits: {} } };
  return { hunt: JSON.stringify(hunt), settings: JSON.stringify(settings) };
}

async function settle(page) {
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 20_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 25_000 });
  } catch {
    // Some providers keep connections busy; fall through to the fixed wait.
  }
  await page.waitForTimeout(settleMs);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
mkdirSync(outDir, { recursive: true });
const manifest = { label, baseUrl, createdAt: new Date().toISOString(), prefs: extraPrefs, shots: [] };

try {
  for (const viewport of VIEWPORTS.filter((v) => viewportFilter.includes(v.id))) {
    for (const view of VIEWS.filter((v) => !viewFilter || viewFilter.has(v.id))) {
      for (const zoom of view.zooms) {
        for (const entry of basemaps) {
          const { basemap, tag, prefs: entryPrefs } = parseEntry(entry);
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: 1,
            serviceWorkers: "block",
            ...(viewport.mobile
              ? {
                  isMobile: true,
                  hasTouch: true,
                  userAgent:
                    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
                }
              : {}),
          });
          const page = await context.newPage();
          await page.clock.setFixedTime(fixedTime(view.lng));
          const data = seed(view, zoom, basemap, entryPrefs);
          await page.addInitScript((values) => {
            localStorage.setItem("fieldline-v1", values.hunt);
            localStorage.setItem("fieldline-settings", values.settings);
            localStorage.setItem("fieldline-install-dismissed", "1");
          }, data);
          const file = `${view.id}-z${zoom}-${tag}-${viewport.id}.png`;
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await settle(page);
            await page.screenshot({ path: resolve(outDir, file) });
            manifest.shots.push({ file, view: view.id, name: view.name, zoom, basemap, prefs: entryPrefs, viewport: viewport.id, errors });
            console.log(`ok   ${file}${errors.length ? ` (${errors.length} page errors)` : ""}`);
          } catch (error) {
            manifest.shots.push({ file, view: view.id, zoom, basemap, viewport: viewport.id, failed: String(error) });
            console.log(`FAIL ${file}: ${error instanceof Error ? error.message : error}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  }
} finally {
  await browser.close();
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

console.log(`Gallery: ${manifest.shots.length} shots in ${outDir}`);
