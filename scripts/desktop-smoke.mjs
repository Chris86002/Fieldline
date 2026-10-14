import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { createServer } from "node:net";
import { _electron as electron } from "playwright";
import { ORIGIN, HOST, PORT, assertResources } from "../desktop/policy.mjs";

// Test the packaged executable, not Electron's development CLI or a system Node server.
const executable = resolve(process.env.FIELDLINE_DESKTOP_EXECUTABLE ?? (
  process.platform === "win32" ? "release/win-unpacked/Fieldline.exe" :
    process.platform === "darwin" ? "release/mac/Fieldline.app/Contents/MacOS/Fieldline" :
      "release/linux-unpacked/fieldline"
));
await access(executable);
const resources = process.platform === "darwin"
  ? resolve(executable, "../../Resources")
  : join(resolve(executable, ".."), "resources");
assertResources(join(resources, "fieldline"));
const profile = await mkdtemp(join(tmpdir(), "fieldline-desktop-smoke-"));
const waypointName = "Desktop Restart Stand";
let desktop;

// Remove developer runtimes from PATH without removing Windows' shell.
// Environment keys are case-insensitive on Windows; remove every PATH spelling.
const smokeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !["PATH", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key.toUpperCase())),
);
smokeEnv.PATH = process.platform === "win32"
  ? win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32")
  : "";
smokeEnv.FIELDLINE_SMOKE_PROFILE = profile;

async function launch() {
  const launched = await electron.launch({
    executablePath: executable,
    chromiumSandbox: true,
    // CI VMs on all platforms may lack hardware WebGL. Test-only flags.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    env: smokeEnv,
    timeout: 45_000,
  });
  assert.equal(launched.process().spawnargs.includes("--no-sandbox"), false);
  await launched.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (/^\/api\/dem\/(?:[0-9]|1[0-4])\//.test(url.pathname)) return route.abort();
    return route.continue();
  });
  const page = await launched.firstWindow();
  page.on("pageerror", (error) => console.error("Desktop page error:", error.message));
  await page.waitForURL(`${ORIGIN}/`);
  await page.getByText("FIELDLINE", { exact: true }).filter({ visible: true }).first().waitFor();
  try {
    await page.locator(".maplibregl-canvas").waitFor({ state: "attached" });
  } catch (error) {
    console.error((await page.locator("body").innerText()).slice(0, 2000));
    await launched.close();
    throw error;
  }
  return { launched, page };
}

async function assertPortClosed() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(PORT, HOST, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

try {
  ({ launched: desktop } = await launch());
  let page = await desktop.firstWindow();
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const preferences = await desktop.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  assert.equal((await fetch(ORIGIN)).status, 403, "ordinary browsers cannot call the internal server");
  assert.equal((await fetch(ORIGIN, { headers: { Host: "evil.test:47831" } })).status, 403);
  assert.equal(await page.evaluate(async () => (await fetch("/api/dem/99/0/0")).status), 400,
    "bundled server API routes retain input validation");

  const intro = page.getByRole("button", { name: /^(Get started|Start mapping|Let's go|Got it)$/i });
  if (await intro.count()) await intro.first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "desktop.gpx", mimeType: "application/gpx+xml",
    buffer: Buffer.from(`<?xml version="1.0"?><gpx version="1.1" creator="Fieldline"><wpt lat="33.76" lon="-111.27"><name>${waypointName}</name></wpt><trk><name>Desktop track</name><trkseg><trkpt lat="33.76" lon="-111.27"/><trkpt lat="33.77" lon="-111.28"/></trkseg></trk></gpx>`),
  });
  await page.waitForFunction((name) => {
    const saved = JSON.parse(localStorage.getItem("fieldline-v1") ?? "null");
    return saved?.state.waypoints.some((waypoint) => waypoint.name === name);
  }, waypointName);
  await page.getByText(waypointName, { exact: true }).first().waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fieldline-v1")));
  assert.equal(saved.version, 0);
  assert.equal(saved.state.tracks.length, 1);
  await desktop.evaluate(({ session }, destination) => {
    globalThis.smokeDownload = { state: "waiting" };
    session.fromPartition("persist:fieldline").once("will-download", (event, item, contents) => {
      globalThis.smokeDownload = { url: item.getURL(), cancelled: event.defaultPrevented, hasContents: !!contents, filename: item.getFilename(), state: "started" };
      item.setSavePath(destination);
      item.once("done", (_event, state) => { globalThis.smokeDownload.state = state; });
    });
  }, join(profile, "export.gpx"));
  await page.getByRole("button", { name: "Export GPX" }).click();
  for (let attempt = 0; attempt < 100; attempt++) {
    const download = await desktop.evaluate(() => globalThis.smokeDownload);
    if (download.state === "completed") break;
    if (["cancelled", "interrupted"].includes(download.state)) assert.fail(`Export ${download.state}`);
    await page.waitForTimeout(100);
  }
  const download = await desktop.evaluate(() => globalThis.smokeDownload);
  assert.equal(download.state, "completed");
  assert.equal(download.filename, "fieldline.gpx");
  assert.equal(download.cancelled, false);
  assert.match(await readFile(join(profile, "export.gpx"), "utf8"), /Desktop Restart Stand/);

  await page.evaluate(() => window.open("https://example.com"));
  await page.evaluate(() => { window.location.href = "file:///etc/passwd"; });
  await page.waitForTimeout(300);
  assert.equal(page.url(), `${ORIGIN}/`);
  assert.equal(desktop.windows().length, 1);
  await desktop.close();
  desktop = undefined;
  await assertPortClosed();
  ({ launched: desktop, page } = await launch());
  await page.getByText(waypointName, { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("fieldline-v1"))), saved,
    "waypoints, tracks, and settings survive full restart on the same origin/profile");
  await desktop.close();
  desktop = undefined;
  await assertPortClosed();
  console.log("Packaged Fieldline smoke passed: bundled UI/API, offline shell, import/export, security, restart persistence, server cleanup.");
} finally {
  await desktop?.close();
  await rm(profile, { recursive: true, force: true });
}
