/* FrameLabs 2 PWA service worker */
"use strict";

const CACHE_NAME = "framelabs-2-shell-v1";
const APP_ROOT = new URL("./", self.registration.scope);
const APP_SHELL = [
  APP_ROOT.href,
  new URL("index.html", APP_ROOT).href,
  new URL("manifest.json", APP_ROOT).href,
  new URL("css/styles.css", APP_ROOT).href,
  new URL("js/compute-backends.js", APP_ROOT).href,
  new URL("js/materials.js", APP_ROOT).href,
  new URL("js/physics-model.js", APP_ROOT).href,
  new URL("js/replay-tools.js", APP_ROOT).href,
  new URL("js/main.js", APP_ROOT).href,
  new URL("assets/icons/framelabs-192.png", APP_ROOT).href,
  new URL("assets/icons/framelabs-512.png", APP_ROOT).href
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("framelabs-2-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;

      if (request.mode === "navigate") {
        const appPage = await cache.match(new URL("index.html", APP_ROOT).href);
        if (appPage) return appPage;
      }

      return new Response("FrameLabs 2 is unavailable offline until this resource has been cached.", {
        status: 503,
        statusText: "Offline"
      });
    }
  })());
});
