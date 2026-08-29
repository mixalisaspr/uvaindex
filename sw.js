// sw.js — service worker for the UVA Index PWA.
//
// Strategy:
//  • App shell (HTML/CSS/JS/icons) is precached so the UI loads instantly and
//    works offline.
//  • Open-Meteo API calls are NEVER cached — UVA needs fresh weather/air data,
//    so those requests always go to the network and fail loudly when offline.
//  • Navigations fall back to the cached page when the network is unavailable.
//
// GENERATED FILE — do not edit by hand. Run `python3 scripts/build_kb.py`.
// SHELL is derived from content/learn/*.html; CACHE is a hash of SHELL so it
// only changes when the actual set of precached paths changes.

const CACHE = 'uvaindex-shell-91b99f2163';

const SHELL = [
    "./",
    "./index.html",
    "./about.html",
    "./styles.css",
    "./favicon.svg",
    "./manifest.webmanifest",
    "./js/app.js",
    "./js/api.js",
    "./js/chart.js",
    "./js/solar.js",
    "./js/uva.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/maskable-192.png",
    "./icons/maskable-512.png",
    "./icons/apple-touch-icon.png",
    "./learn/",
    "./learn/index.html",
    "./learn/dangers-of-uva.html",
    "./learn/does-clothing-block-uva.html",
    "./learn/does-glass-block-uva.html",
    "./learn/does-uva-change-with-the-seasons.html",
    "./learn/does-uva-tan-or-burn.html",
    "./learn/how-to-measure-uva.html",
    "./learn/how-uva-index-is-calculated.html",
    "./learn/indoor-uva-nail-lamps-tanning-beds.html",
    "./learn/reflected-uva-snow-sand-water.html",
    "./learn/sunscreen-application-uva-protection.html",
    "./learn/uv-index-scale-explained.html",
    "./learn/uv-index-vs-uva-index.html",
    "./learn/uva-and-skin-aging.html",
    "./learn/uva-and-vitamin-d.html",
    "./learn/uva-and-your-eyes.html",
    "./learn/uva-at-altitude.html",
    "./learn/uva-by-latitude-and-location.html",
    "./learn/uva-melasma-and-skin-tone.html",
    "./learn/uva-on-cloudy-days.html",
    "./learn/uva-photosensitivity-medications.html",
    "./learn/uva-sunscreen-labels-explained.html",
    "./learn/uva-vs-uvb.html",
    "./learn/what-is-uva-radiation.html",
    "./learn/what-time-is-uva-highest.html",
    "./learn/tags/",
    "./learn/tags/index.html",
    "./learn/tags/basics.html",
    "./learn/tags/comparison.html",
    "./learn/tags/environment.html",
    "./learn/tags/health.html",
    "./learn/tags/methodology.html",
    "./learn/tags/protection.html",
    "./learn/tags/risks.html",
    "./learn/tags/spectrum.html",
    "./learn/tags/technical.html",
    "./learn/tags/uv-index.html"
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
