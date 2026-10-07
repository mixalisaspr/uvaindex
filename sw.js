// sw.js — service worker for the UVA Index PWA.
//
// Strategy: one versioned app shell.
//  • Every page, script, stylesheet and icon is precached together under one
//    cache name that hashes all of their contents, so a deploy that changes
//    any of them ships a new service worker and a new cache.
//  • Pages AND assets are served from that cache, so the HTML and the
//    JavaScript a visitor runs always come from the same version. (Serving
//    fresh HTML with cached JS from an older version is what broke returning
//    PWA users after a deploy.)
//  • The new version is fetched past the browser's HTTP cache, activates
//    straight away, and js/sw-register.js reloads open pages onto it.
//  • Open-Meteo and other third-party requests are never touched — UVA needs
//    fresh weather data.
//
// GENERATED FILE — do not edit by hand. Run `python3 scripts/build_kb.py`.
// SHELL is derived from content/site.json and content/learn/*.html; CACHE is
// a hash of SHELL *and the contents of every file in it*.

const CACHE = 'uvaindex-shell-12dafbbbe3';

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
    "./js/consent.js",
    "./js/forecast.js",
    "./js/lut.js",
    "./js/solar.js",
    "./js/sw-register.js",
    "./js/tz.js",
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
    caches
      .open(CACHE)
      // 'reload' skips the HTTP cache: the host lets browsers keep files for
      // minutes, which could otherwise slip an old file into the new version.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // ignoreSearch: "/?source=pwa" is the same page as "/".
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch (err) {
        // Offline and not precached: a page falls back to the calculator.
        if (req.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })
  );
});
