// Service worker for the standalone field-test page (CC-01): network first,
// falling back to the files the page cached, so the page reopens offline.
const CACHE = "fieldline-field-test-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.endsWith("/sw.js")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          const key = request.mode === "navigate" ? new URL("./", self.registration.scope).href : request;
          void caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const key = request.mode === "navigate" ? new URL("./", self.registration.scope).href : request;
        return (await cache.match(key, { ignoreSearch: true })) || Response.error();
      }),
  );
});
