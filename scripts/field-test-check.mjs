#!/usr/bin/env node
/**
 * Headless Chromium check of the phone field-test tool (CC-01).
 *
 *   node scripts/field-test-check.mjs            # /field-test on a running build (FIELDLINE_URL, default http://127.0.0.1:3000)
 *   node scripts/field-test-check.mjs --static   # dist/field-test (npm run field-test:build), served here under /Fieldline/
 *
 * Emulates a walking phone with Playwright geolocation, hides the page,
 * freezes it where Chromium allows, reloads mid-run (the stand-in for a
 * kill), continues the recovered run, stops, and checks the report, the
 * JSON and GPX downloads, and an offline reopen. Desktop Chromium is not a
 * phone: this proves the tool works, not how any phone behaves.
 */
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const staticMode = process.argv.includes("--static");
const screenshots = resolve(process.env.FIELDLINE_SCREENSHOTS_DIR ?? "screenshots");
mkdirSync(screenshots, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };

/** Minimal static server for dist/field-test under /Fieldline/ (like GitHub Pages). localhost is a secure context. */
async function serveStatic() {
  const root = resolve("dist/field-test");
  assert.ok(existsSync(join(root, "index.html")), "Run `npm run field-test:build` first.");
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!path.startsWith("/Fieldline/")) {
      res.writeHead(404).end();
      return;
    }
    let file = normalize(join(root, path.slice("/Fieldline/".length) || "index.html"));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://localhost:${server.address().port}/Fieldline/` };
}

const served = staticMode ? await serveStatic() : null;
const pageUrl = served ? served.url : `${process.env.FIELDLINE_URL ?? "http://127.0.0.1:3000"}/field-test`;
const label = staticMode ? "static" : "app";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
const results = [];
const note = (text) => {
  results.push(text);
  console.log(`  ${text}`);
};

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude: 45, longitude: -110, accuracy: 6 },
    permissions: ["geolocation"],
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(message.text())) errors.push(`console: ${message.text()}`);
  });

  let lat = 45;
  async function walk(steps, everyMs = 400) {
    for (let i = 0; i < steps; i += 1) {
      lat += 2e-5;
      await context.setGeolocation({ latitude: lat, longitude: -110, accuracy: 5 + (i % 7) });
      await page.waitForTimeout(everyMs);
    }
  }
  async function counters() {
    return page.getByTestId("live-counters").innerText();
  }
  async function savedFixes() {
    const text = await counters();
    const match = /FIXES SAVED\s+(\d+) \/ (\d+)/i.exec(text);
    return match ? { saved: Number(match[1]), received: Number(match[2]) } : null;
  }

  console.log(`Field-test check (${label}): ${pageUrl}`);
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.getByRole("heading", { name: "New test run" }).waitFor({ timeout: 20_000 });
  // Load once more so the service worker controls the page and caches it for offline reopening.
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: "load" });
  await page.getByRole("heading", { name: "New test run" }).waitFor({ timeout: 20_000 });
  note("page opens; setup card shown");

  await page.getByLabel("Scenario").selectOption("2");
  assert.match(await page.getByTestId("scenario-steps").innerText(), /lock the phone/);
  await page.getByRole("button", { name: "Start test 2" }).click();
  await page.getByRole("region", { name: "Live test" }).waitFor();
  await walk(10);
  let fixes = await savedFixes();
  assert.ok(fixes && fixes.saved >= 5, `fixes are recorded (${JSON.stringify(fixes)})`);
  note(`recording: ${fixes.saved}/${fixes.received} fixes saved/received after 10 position changes`);
  await page.screenshot({ path: join(screenshots, `field-test-${label}-live.png`), fullPage: true });

  // Hide the page: another tab in front; fall back to a synthetic visibilitychange if headless keeps it visible.
  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.waitForTimeout(300);
  let hiddenBy = "another tab in front";
  if ((await page.evaluate(() => document.visibilityState)) !== "hidden") {
    hiddenBy = "synthetic visibilitychange (headless kept the page visible)";
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }
  // Freeze where Chromium allows it (Page Lifecycle), to exercise freeze/resume.
  const cdp = await context.newCDPSession(page);
  let froze = false;
  try {
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    froze = true;
  } catch {
    // Chromium refuses to freeze some pages; the hidden period still applies.
  }
  // 17 s with no position change: a gap over the 15 s threshold.
  await page.waitForTimeout(17_000);
  if (froze) await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await page.bringToFront();
  await other.close();
  if (hiddenBy.startsWith("synthetic")) {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }
  note(`page hidden for 17 s by ${hiddenBy}${froze ? ", frozen through CDP" : ", not frozen (CDP refused)"}`);
  await walk(6);
  const beforeReload = await savedFixes();
  const log = await page.getByTestId("event-log").innerText();
  assert.match(log, /hidden/);
  assert.match(log, /visible/);

  // Reload mid-run: the stand-in for a kill. Wait past one heartbeat save first.
  await page.waitForTimeout(16_000);
  await page.reload({ waitUntil: "load" });
  const recovered = page.getByTestId("recovered-summary");
  await recovered.waitFor({ timeout: 20_000 });
  const recoveredText = await recovered.innerText();
  const back = Number(/(\d+) fixes were read back/.exec(recoveredText)?.[1]);
  assert.ok(back >= beforeReload.saved, `recovered ${back} ≥ ${beforeReload.saved} saved before reload`);
  note(`reload mid-run: ${back} fixes read back (${beforeReload.saved} were saved on screen before)`);
  await page.screenshot({ path: join(screenshots, `field-test-${label}-recovered.png`), fullPage: true });

  await page.getByRole("button", { name: "Continue this run" }).click();
  await page.getByRole("region", { name: "Live test" }).waitFor();
  await walk(8);
  await page.getByPlaceholder("Note a moment (e.g. locking now)").fill("check note");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const after = await savedFixes();
  assert.ok(after.saved > 0, "fixes recorded after continuing");
  await page.getByRole("button", { name: "Stop and make report" }).click();
  const summary = page.getByTestId("report-summary");
  await summary.waitFor({ timeout: 20_000 });
  const summaryText = await summary.innerText();
  note(`report: ${summaryText.replace(/\s+/g, " ").slice(0, 300)}`);
  assert.match(summaryText, /Interruptions\s+\d+ fixes recovered/);
  await page.screenshot({ path: join(screenshots, `field-test-${label}-report.png`), fullPage: true });

  // Downloads: JSON report (without and with coordinates) and GPX.
  const [jsonDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report" }).click()]);
  await jsonDownload.saveAs(join(screenshots, `field-test-${label}-report.json`));
  const report = JSON.parse(readFileSync(await jsonDownload.path(), "utf8"));
  assert.equal(report.format, "fieldline-field-test-report");
  assert.equal(report.run.scenario, 2);
  assert.equal(report.coordinatesIncluded, false);
  assert.equal(report.fixes[0].lat, undefined);
  assert.ok(report.fixes.length === report.counts.fixesSaved && report.fixes.length >= 15, `fixes in report: ${report.fixes.length}`);
  assert.ok(report.gaps.count >= 1 && report.gaps.longestMs > 15_000, `gap measured: ${JSON.stringify(report.gaps.list[0])}`);
  assert.ok(report.hidden.count >= 1, "hidden period recorded");
  assert.equal(report.interruptions.length, 1, "reload recorded as one interruption");
  assert.ok(report.interruptions[0].fixesRecovered >= beforeReload.saved);
  assert.equal(report.run.pageLoads, 2);
  assert.equal(report.build.flavor, label);
  assert.ok(report.device.userAgent.includes("Chrome"), "device info recorded");
  assert.equal(report.capabilities.secureContext, true);
  const types = new Set(report.events.map((event) => event.type));
  for (const type of ["run-started", "hidden", "visible", "recovered", "resumed", "tester-mark", "stopped"]) assert.ok(types.has(type), `event ${type} logged`);
  note(
    `JSON report: ${report.fixes.length} fixes, ${report.gaps.count} gap(s), longest ${Math.round(report.gaps.longestMs / 1000)} s (hidden ${Math.round(report.gaps.list[0].hiddenMs / 1000)} s of it), ${report.hidden.count} hidden period(s), freeze events ${types.has("freeze") ? "seen" : "not seen"}, timers-paused ${types.has("timers-paused") ? "seen" : "not seen"}, battery ${report.battery.start ? `${Math.round(report.battery.start.level * 100)}%` : "n/a"}, commit ${report.build.commit}`,
  );
  note(`counts: ${JSON.stringify(report.counts)}; segment starts: ${JSON.stringify(report.segmentStarts)}`);
  await page.getByLabel(/Include map positions/).check();
  await page.waitForTimeout(300);
  const [jsonWithCoordinates] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report" }).click()]);
  const withCoordinates = JSON.parse(readFileSync(await jsonWithCoordinates.path(), "utf8"));
  assert.equal(withCoordinates.coordinatesIncluded, true);
  assert.equal(typeof withCoordinates.fixes[0].lat, "number");
  const [gpxDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download GPX" }).click()]);
  const gpx = readFileSync(await gpxDownload.path(), "utf8");
  const segments = (gpx.match(/<trkseg>/g) ?? []).length;
  assert.ok(segments >= 2, `GPX splits the run at the gap and the interruption (${segments} segments)`);
  assert.match(gpxDownload.suggestedFilename(), /^fieldline-field-test-s02-\d{8}-\d{4}\.gpx$/);
  note(`downloads: ${jsonDownload.suggestedFilename()}, ${gpxDownload.suggestedFilename()} (${segments} track segments)`);
  assert.match((await page.getByTestId("result-template").textContent()) ?? "", /Scenario #: 2 Screen locked/);

  // Runs are kept apart from the app's content database.
  const databases = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : []));
  assert.ok(databases.includes("fieldline-field-test"), `test database exists (${databases.join(", ")})`);
  assert.ok(!databases.includes("fieldline-content"), "the field test never opens the app's content database");
  note(`databases on this origin: ${databases.join(", ")}`);

  // Reopen with no network (airplane mode, kill + reopen with no signal).
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("past-runs").waitFor({ timeout: 20_000 });
  note("offline reopen: page and finished runs load with the network off");
  await context.setOffline(false);
  await page.screenshot({ path: join(screenshots, `field-test-${label}-offline.png`), fullPage: true });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal overflow at 390 px (${overflow})`);
  assert.deepEqual(errors, [], "no page errors");
  console.log(`Field-test check (${label}) passed.`);
} catch (error) {
  console.error(`Field-test check (${label}) failed:`, error);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  served?.server.close();
}
