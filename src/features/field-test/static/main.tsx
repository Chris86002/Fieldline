import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FieldTestScreen } from "../FieldTestScreen.tsx";
import "./field-test.css";

/**
 * Standalone field-test page (CC-01): the same screen as /field-test, built
 * as static files (`npm run field-test:build`) so it can be served from any
 * free HTTPS static host without Fieldline's server functions.
 */
const CACHE = "fieldline-field-test-v1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FieldTestScreen flavor="static" />
  </StrictMode>,
);

/**
 * Offline reopening (tests 9–11): the service worker answers from this cache
 * when there's no network. The page stores its own files here right away,
 * so one online visit is enough.
 */
async function keepOffline() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    const files = new Set<string>([new URL("./", location.href).href]);
    for (const script of document.querySelectorAll<HTMLScriptElement>("script[src]")) files.add(script.src);
    for (const link of document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet], link[rel=modulepreload], link[rel=manifest], link[rel=apple-touch-icon]")) files.add(link.href);
    const cache = await caches.open(CACHE);
    await cache.addAll([...files]);
  } catch {
    // Offline reopening is a convenience; the test still runs without it.
  }
}

if (document.readyState === "complete") void keepOffline();
else window.addEventListener("load", () => void keepOffline(), { once: true });
