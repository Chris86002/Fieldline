#!/usr/bin/env node
/**
 * Map rendering cost at a fixed view, for before/after comparisons of map
 * styles (spec §17 "map remains legible and responsive"). A manual
 * measurement tool, not a CI test: it loads live tiles, so results depend on
 * the network, the providers and the machine. Headless Chromium draws with
 * SwiftShader (software WebGL), so absolute frame times are far worse than on
 * a real GPU; compare runs made on the same machine in the same session.
 *
 * Usage (against a running build):
 *   FIELDLINE_URL=http://127.0.0.1:3100 node scripts/map-perf.mjs
 *
 * Environment:
 *   FIELDLINE_URL            app origin (default http://127.0.0.1:3000)
 *   FIELDLINE_PERF_BASEMAPS  comma list, entries as in map-gallery.mjs
 *                            ("terrain", "satellite:showImageryContours=true", ...)
 *   FIELDLINE_PERF_VIEW      lng,lat,zoom (default Sawtooths ID, -114.98,44.12,12.5)
 *   FIELDLINE_PERF_RUNS      runs per entry; the median is reported (default 3)
 *
 * Per run: a fresh profile loads the view; "load" figures cover navigation
 * until the network is quiet plus 2 s. Then a scripted pan (three drags) and
 * a zoom in and out; "interaction" figures cover those 6 s. Long tasks are
 * main-thread tasks over 50 ms (PerformanceObserver "longtask"); frame
 * intervals come from requestAnimationFrame.
 */
import { chromium } from "playwright";

const baseUrl = process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000";
const entries = (process.env.FIELDLINE_PERF_BASEMAPS ?? "terrain,satellite,field").split(",").map((s) => s.trim()).filter(Boolean);
const [lng, lat, zoom] = (process.env.FIELDLINE_PERF_VIEW ?? "-114.98,44.12,12.5").split(",").map(Number);
const runs = Number(process.env.FIELDLINE_PERF_RUNS ?? 3);

function parseEntry(entry) {
  const [basemap, extra = ""] = entry.split(":");
  const prefs = {};
  for (const pair of extra.split(";").filter(Boolean)) {
    const [key, raw] = pair.split("=");
    prefs[key] = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return { basemap, prefs };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
};

async function measure(browser, entry) {
  const { basemap, prefs } = parseEntry(entry);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const page = await context.newPage();
  // No fixed clock here: Playwright's fake clock replaces performance timing. Sun shade follows the real time.
  await page.addInitScript(
    (v) => {
      localStorage.setItem("fieldline-v1", JSON.stringify({ state: { waypoints: [], tracks: [], introDismissed: true, lastView: { lng: v.lng, lat: v.lat, zoom: v.zoom, bearing: 0, pitch: 0 } }, version: 0 }));
      localStorage.setItem("fieldline-settings", JSON.stringify({ version: 1, state: { prefs: { basemap: v.basemap, startupView: "last", ...v.prefs }, preset: null, presetEdits: {} } }));
      localStorage.setItem("fieldline-install-dismissed", "1");
      // The default buffer (250 entries) fills with app assets before the tiles arrive.
      performance.setResourceTimingBufferSize(20000);
      const perf = { longtasks: [], frames: [] };
      window.__perf = perf;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) perf.longtasks.push([e.startTime, e.duration]);
        }).observe({ type: "longtask", buffered: true });
      } catch {
        // No long-task support: figures stay empty.
      }
      let last = 0;
      const loop = (t) => {
        if (last) perf.frames.push([t, t - last]);
        last = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    { lng, lat, zoom, basemap, prefs },
  );
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".maplibregl-canvas").waitFor({ state: "attached", timeout: 30_000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
  } catch {
    // Providers may keep connections open; the fixed wait below still applies.
  }
  await page.waitForTimeout(2000);
  const load = await page.evaluate(() => {
    const p = window.__perf;
    const tiles = performance.getEntriesByType("resource").filter((e) => /\/api\/dem\/|openfreemap|arcgis|nationalmap|blm\.gov/.test(e.name));
    return {
      lastTileMs: Math.round(Math.max(0, ...tiles.map((e) => e.responseEnd))),
      tileRequests: tiles.length,
      demRequests: tiles.filter((e) => e.name.includes("/api/dem/")).length,
      longTaskMs: Math.round(p.longtasks.reduce((sum, [, d]) => sum + d, 0)),
      longTasks: p.longtasks.length,
      maxLongTaskMs: Math.round(Math.max(0, ...p.longtasks.map(([, d]) => d))),
      lastLongTaskEndMs: Math.round(Math.max(0, ...p.longtasks.map(([s, d]) => s + d))),
      now: performance.now(),
    };
  });
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const start = await page.evaluate(() => performance.now());
  for (const [dx, dy] of [
    [-260, 0],
    [0, -180],
    [220, 160],
  ]) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(6000 - 3 * 250 - 700);
  const interaction = await page.evaluate((from) => {
    const p = window.__perf;
    const frames = p.frames.filter(([t]) => t >= from).map(([, d]) => d);
    const tasks = p.longtasks.filter(([s]) => s >= from);
    return { frames, longTaskMs: Math.round(tasks.reduce((sum, [, d]) => sum + d, 0)), longTasks: tasks.length, maxLongTaskMs: Math.round(Math.max(0, ...tasks.map(([, d]) => d))) };
  }, start);
  await context.close();
  return {
    load,
    interaction: {
      frameP50: percentile(interaction.frames, 0.5),
      frameP95: percentile(interaction.frames, 0.95),
      framesOver50: interaction.frames.filter((d) => d > 50).length,
      frames: interaction.frames.length,
      longTaskMs: interaction.longTaskMs,
      longTasks: interaction.longTasks,
      maxLongTaskMs: interaction.maxLongTaskMs,
    },
  };
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const report = {};
try {
  for (const entry of entries) {
    const results = [];
    for (let i = 0; i < runs; i += 1) results.push(await measure(browser, entry));
    const pick = (fn) => Math.round(median(results.map(fn)) * 10) / 10;
    report[entry] = {
      runs,
      lastTileMs: pick((r) => r.load.lastTileMs),
      tileRequests: pick((r) => r.load.tileRequests),
      demRequests: pick((r) => r.load.demRequests),
      loadLongTaskMs: pick((r) => r.load.longTaskMs),
      loadMaxLongTaskMs: pick((r) => r.load.maxLongTaskMs),
      loadSettledMs: pick((r) => Math.max(r.load.lastTileMs, r.load.lastLongTaskEndMs)),
      panFrameP50Ms: pick((r) => r.interaction.frameP50),
      panFrameP95Ms: pick((r) => r.interaction.frameP95),
      panFramesOver50: pick((r) => r.interaction.framesOver50),
      panLongTaskMs: pick((r) => r.interaction.longTaskMs),
      panMaxLongTaskMs: pick((r) => r.interaction.maxLongTaskMs),
    };
    console.log(entry, JSON.stringify(report[entry]));
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ baseUrl, view: { lng, lat, zoom }, report }, null, 2));
