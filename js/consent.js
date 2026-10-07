// consent.js — loads Google Analytics only with the visitor's consent where the
// law requires it to be asked (EU/EEA, UK, Switzerland), and lets anyone change
// their choice later. Plain classic script, shared by every page:
//
//   <script src="js/consent.js" data-ga-id="G-XXXX" defer></script>
//
// - A stored choice ("granted" / "denied") always wins, everywhere.
// - With no stored choice, visitors whose timezone is in Europe (or an EU
//   outermost region) see the banner and nothing is loaded until they accept;
//   everyone else gets analytics as before.
// - Any element with [data-consent-open] (the footer's "Cookie settings")
//   reopens the banner.
(function () {
  const script = document.currentScript;
  const GA_ID = script && script.dataset.gaId;
  const KEY = 'uvaindex-consent';
  const privacyUrl = new URL('../about.html#privacy', script ? script.src : location.href).href;

  // Timezones of the EU/EEA, UK and Switzerland — a privacy-preserving stand-in
  // for "where is the visitor" (no IP lookup). Over-inclusive on purpose:
  // every Europe/* zone asks, plus EU territories outside Europe.
  const CONSENT_ZONES = [
    'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Reykjavik',
    'Africa/Ceuta', 'Asia/Nicosia', 'Asia/Famagusta', 'Arctic/Longyearbyen',
    'America/Guadeloupe', 'America/Martinique', 'America/Cayenne',
    'America/St_Barthelemy', 'America/Marigot',
    'Indian/Reunion', 'Indian/Mayotte',
  ];

  function needsConsent() {
    let tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      /* unknown zone: ask, to be safe */
    }
    return !tz || tz.startsWith('Europe/') || CONSENT_ZONES.includes(tz);
  }

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function store(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* storage blocked: the choice lasts for this page view only */
    }
  }

  let loaded = false;
  function loadAnalytics() {
    if (!GA_ID) return;
    window['ga-disable-' + GA_ID] = false;
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
  }

  // Withdrawing consent: stop GA sending anything more and clear its cookies.
  function disableAnalytics() {
    if (GA_ID) window['ga-disable-' + GA_ID] = true;
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim();
      if (name === '_ga' || name.startsWith('_ga_') || name === '_gid') {
        const host = location.hostname;
        const expire = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        document.cookie = name + expire;
        document.cookie = name + expire + '; domain=' + host;
        document.cookie = name + expire + '; domain=.' + host.replace(/^www\./, '');
      }
    });
  }

  let banner = null;
  function hideBanner() {
    if (banner) banner.remove();
    banner = null;
  }

  function showBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.className = 'consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Analytics cookies');
    banner.innerHTML =
      '<p>We’d like to use Google Analytics cookies to count visits and see ' +
      'which pages help people. No ads, nothing sold. ' +
      '<a href="' + privacyUrl + '">Privacy details</a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" data-choice="denied">Decline</button>' +
      '<button type="button" data-choice="granted">Accept</button>' +
      '</div>';
    banner.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn) return;
      const choice = btn.dataset.choice;
      store(choice);
      if (choice === 'granted') loadAnalytics();
      else disableAnalytics();
      hideBanner();
    });
    document.body.appendChild(banner);
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-consent-open]')) {
      e.preventDefault();
      showBanner();
    }
  });

  const choice = stored();
  if (choice === 'granted' || (choice !== 'denied' && !needsConsent())) {
    loadAnalytics();
  } else if (choice !== 'denied') {
    showBanner();
  }
})();
