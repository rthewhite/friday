/*
 * Friday's service worker. It does one thing: when opening a page fails because the server can't be reached, it
 * shows /offline.html instead of the browser's own error. It never answers anything else, and never stores anything
 * but that page: the portal's code, styles, the API, the login and the WebSockets always go to the network, so a
 * deploy takes effect as before (src/lib/stale-chunks.ts keeps working).
 *
 * Registered by src/lib/pwa.ts in builds for deployment. To retire it, ship a version that calls
 * self.registration.unregister() in "activate".
 */
const CACHE = "friday-offline-v1";
const OFFLINE = "/offline.html";
/** Left to the browser entirely, also when they are navigations (the login is a redirect chain through /auth). */
const PASS = ["/auth", "/api", "/ws", "/health"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(OFFLINE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("friday-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PASS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return;
  event.respondWith(
    fetch(request).catch(async () => (await caches.match(OFFLINE, { cacheName: CACHE })) ?? Response.error()),
  );
});
