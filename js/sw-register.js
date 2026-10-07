// sw-register.js — registers the service worker and keeps installed copies of
// the site (PWA or a long-open tab) on the latest version. Shared by every
// page as a plain script:  <script src="js/sw-register.js" defer></script>
(function () {
  if (!('serviceWorker' in navigator)) return;
  const script = document.currentScript;
  const swUrl = new URL('../sw.js', script ? script.src : location.href);

  // When a new version takes over this page, reload onto it — but only if the
  // page was already controlled (a first visit gets claimed too, and needs no
  // reload). Reload at most once.
  const wasControlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(swUrl)
      .then((reg) => {
        // An installed PWA is usually resumed rather than reloaded, so the
        // browser's own update check never runs: check whenever it comes
        // back to the foreground (at most every 10 minutes).
        let lastCheck = Date.now();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() - lastCheck < 10 * 60 * 1000) return;
          lastCheck = Date.now();
          reg.update().catch(() => {});
        });
      })
      .catch(() => {
        /* PWA features unavailable; the site still works as a normal page. */
      });
  });
})();
