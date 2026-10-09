const CACHE_NAME = "fieldline-shell-v1";
const SHELL_CACHE_PREFIX = "fieldline-shell-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .catch(() => undefined)
      .then(() => self.clients.claim())
      .catch(() => undefined),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/sw.js"
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && url.pathname === "/") {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => {
          try {
            return (await caches.open(CACHE_NAME)).match("/") || Response.error();
          } catch {
            return Response.error();
          }
        }),
    );
    return;
  }

  if (["script", "style", "font", "image"].includes(request.destination)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const update = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void cache.put(request, copy).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached ?? (await update) ?? Response.error();
      }),
    );
  }
});
