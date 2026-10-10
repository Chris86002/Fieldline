import { app, BrowserWindow, dialog, session, shell, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_HEADER, ORIGIN, PORT, PROFILE_NAME, isAppUrl, isAppNavigation,
  isExternalUrl, isAppDownload, canRequestLocation,
} from "./policy.mjs";
import { waitForServer } from "./lifecycle.mjs";

app.setName("Fieldline");
app.setPath("userData", process.env.FIELDLINE_SMOKE_PROFILE || join(app.getPath("appData"), PROFILE_NAME));
app.enableSandbox();
let window;
let server;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    server?.kill();
    server = undefined;
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch(() => fail("Fieldline could not start. Please reinstall or contact the person who shared the installer."));
}

function fail(message) {
  if (quitting) return;
  dialog.showErrorBox("Fieldline could not start", message);
  app.quit();
}

async function openExternal(url) {
  if (!isExternalUrl(url) || !window) return;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Open provider website?",
    message: `Open ${new URL(url).hostname} in your default browser?`,
    detail: "Fieldline itself runs here. This optional attribution link opens a separate website.",
    buttons: ["Cancel", "Open website"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await shell.openExternal(url);
}

async function start() {
  const root = app.isPackaged
    ? join(process.resourcesPath, "fieldline")
    : fileURLToPath(new URL("../.desktop-output/", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const desktopSession = session.fromPartition("persist:fieldline");
  let locationAllowed = false;
  let locationPrompt;
  desktopSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    // No credentials are exposed to renderer JavaScript or forwarded to providers.
    if (isAppUrl(details.url)) headers[AUTH_HEADER] = token;
    callback({ requestHeaders: headers });
  });
  desktopSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    locationAllowed && contents === window?.webContents &&
    canRequestLocation(permission, origin, contents.getURL(), details.isMainFrame));
  desktopSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window?.webContents ||
        !canRequestLocation(permission, details.requestingUrl, contents.getURL(), details.isMainFrame)) {
      callback(false);
      return;
    }
    locationPrompt ??= dialog.showMessageBox(window, {
      type: "question", title: "Use your location?",
      message: "Allow Fieldline to use this computer's location for GPS positioning or tracking?",
      detail: "Location accuracy and availability depend on your computer and OS location settings.",
      buttons: ["Not now", "Allow"], defaultId: 0, cancelId: 0,
    });
    const { response } = await locationPrompt;
    locationPrompt = undefined;
    locationAllowed = response === 1 && !window.isDestroyed();
    callback(locationAllowed);
  });
  desktopSession.on("will-download", (event, item, contents) => {
    if (contents !== window?.webContents || !isAppNavigation(contents.getURL()) || !isAppDownload(item.getURL())) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "Export Fieldline GPX",
      defaultPath: join(app.getPath("downloads"), "fieldline.gpx"),
      filters: [{ name: "GPS Exchange", extensions: ["gpx"] }],
    });
  });
  server = utilityProcess.fork(fileURLToPath(new URL("./server.mjs", import.meta.url)), [], { serviceName: "Fieldline local server" });
  const ready = waitForServer(server);
  server.postMessage({ root, token });
  try {
    await ready;
  } catch (error) {
    fail(error.message === "EADDRINUSE"
      ? `Fieldline's private port ${PORT} is already in use. Close other Fieldline copies or restart your computer. Fieldline will not change ports because your saved maps belong to this origin.`
      : "The bundled map server did not start in time. Try restarting Fieldline or reinstalling.");
    return;
  }
  server.once("exit", () => fail("The local map server stopped unexpectedly. Restart Fieldline. Your saved data remains in the desktop profile."));
  window = new BrowserWindow({
    title: "Fieldline", width: 1280, height: 850, minWidth: 800, minHeight: 600,
    backgroundColor: "#121410", show: false,
    icon: app.isPackaged ? join(process.resourcesPath, "fieldline-icon.png") : join(root, "public/icons/fieldline-512.png"),
    webPreferences: {
      session: desktopSession, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppNavigation(url)) {
      event.preventDefault();
      void openExternal(url);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isAppNavigation(event.url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", () => fail("The map window stopped unexpectedly. Restart Fieldline."));
  window.on("page-title-updated", (event) => event.preventDefault());
  await window.loadURL(ORIGIN);
  window.show();
}
