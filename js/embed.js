// embed.js — the embeddable UVA Index widget (embed.html). Reads its options
// from the URL, fetches the same Open-Meteo data as the calculator, runs the
// same model, and shows the reading now plus today's peak and protection
// window. No cookies, no analytics: it is meant to sit on other people's
// pages.

import { buildForecast } from './forecast.js';
import { fetchHourly, fetchTimezone } from './api.js';
import { browserTimeZone, formatClock } from './tz.js';
import { parseWidgetParams, calculatorUrl, SITE_URL } from './widget-config.js';

const $ = (id) => document.getElementById(id);
const opts = parseWidgetParams(location.search);

// Refetch the weather hourly; recompute "now" more often from what we have.
const FETCH_TTL_MS = 60 * 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

let data = null; // { hourly, fetchedAt, tz }

// --- per-browser cache ------------------------------------------------------
// A widget on a busy page is loaded again and again by the same visitor;
// reuse a recent fetch rather than asking Open-Meteo every time. Storage may
// be unavailable (blocked third-party storage, private mode) — then we just
// fetch.

const cacheKey = () => `uvaindex-widget:${opts.lat.toFixed(3)},${opts.lon.toFixed(3)}`;

function readCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const c = JSON.parse(raw);
    const fetchedAt = new Date(c.fetchedAt);
    if (!(Date.now() - fetchedAt < FETCH_TTL_MS)) return null;
    const hours = c.hourly.hours.map((h) => ({ ...h, time: new Date(h.time) }));
    return { hourly: { ...c.hourly, hours }, fetchedAt, tz: opts.tz || c.tz };
  } catch {
    return null;
  }
}

function writeCache(d) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(d));
  } catch {
    /* storage full or blocked — the widget works without it */
  }
}

// --- data -------------------------------------------------------------------

async function load() {
  const cached = readCache();
  if (cached) {
    data = cached;
    return;
  }
  const [hourly, tz] = await Promise.all([
    fetchHourly(opts.lat, opts.lon),
    opts.tz ? opts.tz : fetchTimezone(opts.lat, opts.lon).catch(() => null),
  ]);
  data = { hourly, fetchedAt: new Date(), tz: tz || browserTimeZone() };
  writeCache(data);
}

// --- rendering --------------------------------------------------------------

const fmt = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—');

// Round to 5 minutes: the curve is modelled, finer would be false precision.
function clock(date) {
  const step = 5 * 60000;
  return formatClock(new Date(Math.round(date.getTime() / step) * step), data.tz);
}

// Same piecewise scale as the calculator: five equal segments, one per band.
function pointerPosition(index) {
  const bands = [[0, 3], [3, 6], [6, 8], [8, 11], [11, 14]];
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i];
    if (index < hi || i === bands.length - 1) {
      const frac = Math.max(0, Math.min(1, (index - lo) / (hi - lo)));
      return Math.max(2, Math.min(98, i * 20 + frac * 20));
    }
  }
  return 98;
}

function render() {
  const now = new Date();
  const forecast = buildForecast(data.hourly, {
    now,
    timeZone: data.tz,
    dayCount: 1,
    lat: opts.lat,
    lon: opts.lon,
    surface: opts.surface,
  });
  const reading = forecast.now;
  const today = forecast.days[0]?.summary;

  const index = reading ? reading.index : NaN;
  const band = reading?.band;
  $('w-index').textContent = fmt(index);
  $('w-band').textContent = band ? band.label : '—';
  // Moderate and High are light colours: they need dark text on top.
  const root = document.documentElement;
  root.style.setProperty('--band', band ? band.color : 'var(--muted)');
  root.style.setProperty('--band-ink', band && (band.level === 1 || band.level === 2) ? '#1a1300' : '#fff');
  if ($('w-pointer')) $('w-pointer').style.left = `${pointerPosition(reading ? index : 0)}%`;

  let peakLine = 'No forecast for today';
  let protectLine = '';
  if (today?.peak) {
    const peak = `${fmt(today.peak.index)} at ${clock(today.peak.time)}`;
    peakLine = opts.layout === 'badge' ? `Peak ${peak}` : `Today’s peak ${peak}`;
    protectLine = today.protect
      ? `Protect ${clock(today.protect.start)}–${clock(today.protect.end)}`
      : 'Below Moderate all day';
  }
  $('w-peak').textContent = peakLine;
  if ($('w-protect')) $('w-protect').textContent = protectLine;
  $('w-time').textContent = formatClock(now, data.tz);

  const summary = reading
    ? `UVA Index ${fmt(index)}, ${band.label}${opts.name ? ` in ${opts.name}` : ''}. ${peakLine}. ${protectLine}`
    : 'UVA Index unavailable';
  $('w-link').setAttribute('aria-label', `${summary}. Open the full forecast on uvaindex.org`);
  document.body.classList.remove('is-loading');
}

function showError(message) {
  document.body.classList.remove('is-loading');
  document.body.classList.add('is-error');
  $('w-error').textContent = message;
}

// Where a click goes: the full calculator for this place. Tagged so the
// site's analytics can tell widget visits apart (and from which site).
function linkHref() {
  const url = new URL(calculatorUrl(opts, SITE_URL));
  url.searchParams.set('utm_source', 'widget');
  url.searchParams.set('utm_medium', 'embed');
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : '';
    if (host) url.searchParams.set('utm_campaign', host);
  } catch {
    /* no usable referrer */
  }
  return url.toString();
}

async function refresh() {
  try {
    await load();
    render();
  } catch {
    showError('UVA data is unavailable right now.');
  }
}

function init() {
  document.documentElement.dataset.theme = opts.theme;
  document.body.classList.add(`layout-${opts.layout}`);
  // The badge is one short row: the band chip joins the place line so the
  // number can stand alone on the left.
  if (opts.layout === 'badge') $('w-place').before($('w-band'));
  $('w-place').textContent = opts.name || 'UVA Index';

  if (opts.lat === null || opts.lon === null) {
    $('w-link').href = `${SITE_URL}/widget.html`;
    showError('Set a location for this widget.');
    return;
  }
  $('w-link').href = linkHref();

  refresh();
  // Keep a long-open page current: recompute "now", refetch when stale.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!data || Date.now() - data.fetchedAt >= FETCH_TTL_MS) refresh();
    else render();
  }, TICK_MS);
}

init();
