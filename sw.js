// sw.js — service worker for the UVA Index PWA.
//
// Strategy:
//  • App shell (HTML/CSS/JS/icons) is precached so the UI loads instantly and
//    works offline.
//  • Open-Meteo API calls are NEVER cached — UVA needs fresh weather/air data,
//    so those requests always go to the network and fail loudly when offline.
//  • Navigations fall back to the cached page when the network is unavailable.

const CACHE = 'uvaindex-v2';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './favicon.svg',
  './manifest.webmanifest',
  './js/app.js',
  './js/api.js',
  './js/chart.js',
  './js/solar.js',
  './js/uva.js',
  './learn/',
  './learn/index.html',
  './learn/what-is-uva-radiation.html',
  './learn/uva-vs-uvb.html',
  './learn/dangers-of-uva.html',
  './learn/uv-index-vs-uva-index.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests from our own origin; let everything else
  // (including the Open-Meteo API) hit the network untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // For page navigations, try the network first so users get fresh HTML,
  // then fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        // Prefer the cached version of the page actually requested (e.g. a
        // knowledge-base article), then fall back to the calculator shell.
        caches
          .match(req, { ignoreSearch: true })
          .then((cached) => cached || caches.match('./index.html', { ignoreSearch: true }))
      )
    );
    return;
  }

  // Cache-first for the static shell; refresh the cache in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
