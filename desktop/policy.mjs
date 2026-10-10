import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// This origin and profile are part of the saved-data contract. Never choose a fallback port.
export const HOST = "127.0.0.1";
export const PORT = 47831;
export const ORIGIN = `http://${HOST}:${PORT}`;
export const PROFILE_NAME = "Fieldline";
export const AUTH_HEADER = "x-fieldline-desktop";

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAppNavigation(value) {
  return isAppUrl(value) && new URL(value).pathname === "/";
}

const externalHosts = new Set([
  "www.openstreetmap.org", "openstreetmap.org", "openfreemap.org",
  "www.esri.com", "www.usgs.gov", "www.blm.gov", "www.weather.gov",
  "open-meteo.com", "www.azgfd.com", "idfg.idaho.gov",
]);

export function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && externalHosts.has(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedRequest(headers, token) {
  return headers.host === `${HOST}:${PORT}` &&
    headers[AUTH_HEADER] === token &&
    (!headers.origin || headers.origin === ORIGIN) &&
    (!headers["sec-fetch-site"] || ["same-origin", "none"].includes(headers["sec-fetch-site"]));
}

export function isAppDownload(value) {
  return value.startsWith(`blob:${ORIGIN}/`);
}

export function canRequestLocation(permission, requestingUrl, mainUrl, isMainFrame) {
  return permission === "geolocation" && isMainFrame === true &&
    isAppUrl(requestingUrl) && isAppNavigation(mainUrl);
}

export function assertResources(root) {
  for (const relative of ["server/index.mjs", "public/assets", "public/icons/fieldline-512.png"]) {
    if (!existsSync(join(root, relative))) throw new Error(`Missing desktop resource: ${relative}`);
  }
  const assets = readdirSync(join(root, "public/assets"));
  if (!assets.some((name) => name.endsWith(".js")) || !assets.some((name) => name.endsWith(".css"))) {
    throw new Error("Desktop UI JavaScript/CSS assets are missing");
  }
  const server = readdirSync(join(root, "server/_ssr"));
  for (const prefix of ["search.functions-", "weather.functions-"]) {
    if (!server.some((name) => name.startsWith(prefix))) throw new Error(`Missing server function: ${prefix}`);
  }
}
