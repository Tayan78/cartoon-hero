// Cachar appens skal så att den startar direkt från hemskärmen.
// API-anrop går alltid mot nätet. Höj VERSION vid ändringar i appen.
const VERSION = "v4";
const SHELL = ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Nätet först (så att uppdateringar syns direkt), cachen om du saknar täckning.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
