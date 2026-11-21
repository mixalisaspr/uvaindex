// app.js — wires the UI together: resolve location, fetch atmosphere, compute
// UVA, render the result and a transparent breakdown.

import { buildForecast } from './forecast.js';
import {
  geocode,
  reverseGeocode,
  coordLabel,
  fetchHourly,
  fetchTimezone,
  FORECAST_DAYS,
} from './api.js';
import { renderChart } from './chart.js';
import { browserTimeZone, formatClock, formatDay, tzAbbr } from './tz.js';
import { parseWidgetParams } from './widget-config.js';
import { pageLang, localeFor, translator, bandLabel } from './i18n.js';

const LANG = pageLang();
const LOCALE = localeFor(LANG);
const t = translator(LANG);
const band$ = (band) => (band ? bandLabel(band.level, LANG) : '');

const $ = (id) => document.getElementById(id);

// Current location chosen by the user.
let location = null; // { lat, lon, label, timezone }

// Bumped whenever the location changes, so a slow GPS fix that resolves after
// the user has already picked a place can't overwrite their choice.
let locationSeq = 0;
// Bumped per fetch, so an older response landing late is ignored.
let fetchSeq = 0;

// Last fetched atmosphere for `location` (+ the instant it was fetched for).
// The surface selector only changes the albedo term, so it recomputes from
// this instead of re-fetching.
let data = null; // { hourly, fetchedAt, location }
// Rendered forecast + which day the chart shows.
let forecast = null;
let selectedDay = 0;

// --- UI helpers -------------------------------------------------------------

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

function setLocationLabel(text) {
  $('location-label').textContent = text;
}

// Great-circle distance in km — used to nudge nearby places up the suggestions.
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// --- location handling ------------------------------------------------------

// Pull the device location via the browser. `silent` suppresses error noise for
// automatic attempts (page load).
function useBrowserLocation({ silent = false } = {}) {
  if (!navigator.geolocation) {
    if (!silent) setStatus(t('geoUnsupported'), true);
    return;
  }
  setLocating(true);
  if (!silent) setStatus(t('findingLocation'));
  const seq = ++locationSeq;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      // The user picked a place while we were waiting — theirs wins.
      if (seq !== locationSeq) return setLocating(false);
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      hideSuggestions();
      setLocationLabel(t('locatingPlace'));
      // Resolve city name and timezone in parallel.
      const [name, tz] = await Promise.all([
        reverseGeocode(lat, lon, LANG).catch(() => null),
        fetchTimezone(lat, lon).catch(() => null),
      ]);
      setLocating(false);
      if (seq !== locationSeq) return;
      setLocation({ lat, lon, label: name || coordLabel(lat, lon), timezone: tz });
    },
    (err) => {
      setLocating(false);
      if (seq !== locationSeq) return;
      if (!silent) {
        setStatus(t('locationFailed', { msg: err.message }), true);
      } else if (!location) {
        setLocationLabel(t('searchToBegin'));
      }
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

// Toggle the spinning/disabled feedback on the locate button only — locating
// has nothing to do with the date/time controls.
function setLocating(on) {
  const btn = $('use-location');
  btn.classList.toggle('spinning', on);
  btn.disabled = on;
}

// Make `loc` the current location and fetch its forecast.
function setLocation(loc) {
  location = loc;
  selectedDay = 0;
  $('refresh').disabled = false;
  setLocationLabel(loc.label);
  setStatus('');
  refresh();
}

// Set the chosen location from a geocoding result and recalculate.
function selectPlace(r) {
  ++locationSeq; // supersede any GPS lookup still in flight
  $('place-search').value = r.name;
  hideSuggestions();
  setLocation({
    lat: r.latitude,
    lon: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    timezone: r.timezone || null,
  });
}

// Enter-to-search fallback when no suggestion is highlighted.
async function searchLocation() {
  const q = $('place-search').value.trim();
  if (!q) return;
  setStatus(t('searching'));
  try {
    const results = await geocode(q, 5, LANG);
    if ($('place-search').value.trim() !== q) return; // query changed meanwhile
    if (!results.length) {
      setStatus(t('noPlace'), true);
      return;
    }
    selectPlace(rankSuggestions(results)[0]);
  } catch (e) {
    setStatus(t('searchFailed', { msg: e.message }), true);
  }
}

// --- search-as-you-type suggestions ----------------------------------------

let suggestions = [];
let activeSuggestion = -1;
let suggestTimer = null;

// Rank candidates: keep Open-Meteo's relevance order as the backbone, then
// gently nudge bigger places — and, when we know where the user is, nearer
// ones — upward. The nudge is small so an exact-name match is never buried.
function rankSuggestions(results) {
  const n = results.length;
  return results
    .map((r, i) => {
      let score = n - i; // provider relevance (first result scores highest)
      if (r.population) score += Math.min(2, Math.max(0, Math.log10(r.population) - 4));
      if (location) {
        const d = distanceKm(location.lat, location.lon, r.latitude, r.longitude);
        score += Math.max(0, 2 - d / 1500); // up to +2 for places within ~1500 km
      }
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

function onSearchInput() {
  const q = $('place-search').value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const results = await geocode(q, 8, LANG);
      // Ignore stale responses: the box has since been edited or cleared,
      // and a newer request owns the dropdown.
      if ($('place-search').value.trim() !== q) return;
      suggestions = rankSuggestions(results);
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }, 220);
}

function renderSuggestions() {
  const box = $('suggestions');
  if (!suggestions.length) {
    hideSuggestions();
    return;
  }
  activeSuggestion = -1;
  box.innerHTML = suggestions
    .map((r, i) => {
      const meta = [r.admin1, r.country].filter(Boolean).join(', ');
      const pop = r.population ? ` · ${formatPopulation(r.population)}` : '';
      return (
        `<li class="suggestion" role="option" id="suggestion-${i}" aria-selected="false" data-i="${i}">` +
        `<span class="s-name">${escapeHtml(r.name)}</span>` +
        `<span class="s-meta">${escapeHtml(meta)}${pop}</span>` +
        `</li>`
      );
    })
    .join('');
  box.hidden = false;
  $('place-search').setAttribute('aria-expanded', 'true');
}

function hideSuggestions() {
  suggestions = [];
  activeSuggestion = -1;
  const box = $('suggestions');
  box.hidden = true;
  box.innerHTML = '';
  $('place-search').setAttribute('aria-expanded', 'false');
  $('place-search').removeAttribute('aria-activedescendant');
}

function moveActive(delta) {
  if (!suggestions.length) return;
  activeSuggestion =
    (activeSuggestion + delta + suggestions.length) % suggestions.length;
  const items = $('suggestions').querySelectorAll('.suggestion');
  items.forEach((el, i) => {
    el.classList.toggle('active', i === activeSuggestion);
    el.setAttribute('aria-selected', String(i === activeSuggestion));
  });
  $('place-search').setAttribute('aria-activedescendant', `suggestion-${activeSuggestion}`);
}

function onSearchKeydown(e) {
  if (!suggestions.length) {
    if (e.key === 'Enter') searchLocation();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectPlace(suggestions[activeSuggestion >= 0 ? activeSuggestion : 0]);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

const populationFormat = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
function formatPopulation(p) {
  return populationFormat.format(p);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Try to locate the user automatically on load — but don't re-prompt if they've
// previously denied permission, so reloads stay quiet.
async function autoLocate() {
  if (!navigator.geolocation) {
    setLocationLabel(t('searchToBegin'));
    return;
  }
  try {
    if (navigator.permissions) {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') {
        setLocationLabel(t('searchToBegin'));
        return;
      }
    }
  } catch {
    /* Permissions API unavailable — just try anyway. */
  }
  useBrowserLocation({ silent: true });
}

// --- fetch + compute -------------------------------------------------------

// Zone of the location the shown data belongs to (falls back to the
// browser's when the location's zone couldn't be looked up).
function timeZone() {
  return (data?.location ?? location)?.timezone || browserTimeZone();
}

// Fetch fresh atmosphere for the current location, then recompute.
async function refresh() {
  if (!location) {
    setStatus(t('chooseLocation'), true);
    return;
  }
  const seq = ++fetchSeq;
  const loc = location;
  setRefreshing(true);
  setStatus(t('fetching'));
  try {
    const hourly = await fetchHourly(loc.lat, loc.lon);
    if (seq !== fetchSeq) return; // a newer refresh (or location) took over
    data = { hourly, fetchedAt: new Date(), location: loc };
    recompute();
    setStatus('');
  } catch (e) {
    if (seq !== fetchSeq) return;
    setStatus(t('calcFailed', { msg: e.message }), true);
  } finally {
    if (seq === fetchSeq) setRefreshing(false);
  }
}

// Rebuild the forecast from the cached data (no network).
function recompute() {
  if (!data) return;
  const { lat, lon } = data.location;
  forecast = buildForecast(data.hourly, {
    now: data.fetchedAt,
    timeZone: timeZone(),
    dayCount: FORECAST_DAYS,
    lat,
    lon,
    surface: $('surface').value,
  });
  selectedDay = Math.min(selectedDay, Math.max(0, forecast.days.length - 1));
  render();
}

function setRefreshing(on) {
  $('refresh').disabled = on || !location;
  $('refresh').classList.toggle('spinning', on);
  $('refresh-label').textContent = on ? t('refreshing') : t('refresh');
}

// --- rendering --------------------------------------------------------------

// Numbers in the page's own conventions (7.5 / 7,5), without thousands
// separators so "1234 m" reads the same everywhere.
const numberFormats = new Map();
function fmt(v, digits = 1) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  let f = numberFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
    numberFormats.set(digits, f);
  }
  return f.format(v);
}

// Maps a UVA index value to a left-percentage position on the 5-segment scale.
// Each segment occupies 20% of the bar width; the pointer floats continuously
// within its segment based on where the value falls in that band's range.
function uvaPointerPosition(index) {
  const bands = [[0, 3], [3, 6], [6, 8], [8, 11], [11, 14]];
  for (let i = 0; i < bands.length; i++) {
    const [lo, hi] = bands[i];
    if (index < hi || i === bands.length - 1) {
      const frac = Math.max(0, Math.min(1, (index - lo) / (hi - lo)));
      // Keep the centred number inside the bar at the extremes.
      return Math.max(4, Math.min(96, i * 20 + frac * 20));
    }
  }
  return 100;
}

// Clock time rounded to 5 minutes — the curve is modelled, so finer
// precision would be false precision.
function roundedClock(date) {
  const step = 5 * 60000;
  return formatClock(new Date(Math.round(date.getTime() / step) * step), timeZone());
}

function dayName(day, i) {
  if (i === 0) return t('today');
  if (i === 1) return t('tomorrow');
  return formatDay(day.start, timeZone(), { long: true, locale: LOCALE });
}

// One line describing a day: its peak and when protection is advised.
function summaryLine(day, i) {
  const { peak, protect } = day.summary;
  if (!peak) return '';
  let line = t('summaryPeak', {
    day: dayName(day, i),
    index: fmt(peak.index),
    band: band$(peak.band),
    time: roundedClock(peak.time),
  });
  line += protect
    ? t('summaryProtect', { start: roundedClock(protect.start), end: roundedClock(protect.end) })
    : t('summaryNoProtect');
  return line;
}

function render() {
  $('result').hidden = false;
  const tz = timeZone();
  const now = forecast.now;

  // Headline number (1 decimal); pointer slides to its position on the scale.
  const index = now ? now.index : NaN;
  const band = now ? now.band : null;
  $('uva-index').textContent = fmt(index, 1);
  $('uva-index').style.color = band ? band.color : '';
  $('uva-pointer').style.left = uvaPointerPosition(now ? index : 0) + '%';
  $('uva-band').textContent = band ? band$(band) : '—';
  $('uva-value').textContent = fmt(now?.uva, 1);
  $('as-of').textContent = `· ${formatClock(data.fetchedAt, tz)} ${tzAbbr(data.fetchedAt, tz)}`;

  renderDays();
  renderSelectedDay();
  renderTables(now);
}

function renderDays() {
  $('days').innerHTML = forecast.days
    .map((day, i) => {
      const peak = day.summary.peak;
      const name = i === 0 ? t('today') : formatDay(day.start, timeZone(), { locale: LOCALE });
      const aria = t('dayAria', { day: dayName(day, i), index: fmt(peak?.index), band: band$(peak?.band) });
      return (
        `<button type="button" class="day" data-i="${i}" aria-pressed="${i === selectedDay}"` +
        ` aria-label="${escapeHtml(aria)}">` +
        `<span class="day-name">${escapeHtml(name)}</span>` +
        `<span class="day-peak" style="color:${peak?.band.color ?? 'inherit'}">${fmt(peak?.index)}</span>` +
        `<span class="day-band">${peak ? escapeHtml(band$(peak.band)) : '—'}</span>` +
        `</button>`
      );
    })
    .join('');
}

function renderSelectedDay() {
  const day = forecast.days[selectedDay];
  if (!day) {
    $('day-summary').textContent = '';
    $('chart').innerHTML = `<p class="chart-empty">${escapeHtml(t('noForecast'))}</p>`;
    return;
  }
  const line = summaryLine(day, selectedDay);
  $('day-summary').textContent = line;
  renderChart($('chart'), {
    day,
    timeZone: timeZone(),
    now: forecast.now?.time,
    label: t('chartLabel', { line }),
    lang: LANG,
  });
}

function selectDay(i) {
  selectedDay = i;
  $('days')
    .querySelectorAll('.day')
    .forEach((b) => {
      const on = Number(b.dataset.i) === i;
      b.setAttribute('aria-pressed', String(on));
      // Keep the chosen day in view when the row is scrolled sideways.
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  renderSelectedDay();
}

function renderTables(now) {
  const atm = now?.atm ?? {};
  const sun = now?.sun ?? {};
  const auto = $('surface').value === 'auto';
  let surfaceText = '—';
  if (now?.surface) {
    const name = t(`surfaces.${now.surface}`);
    surfaceText = t('surfaceText', {
      surface: auto ? t('surfaceAuto', { surface: name }) : name,
      albedo: fmt(now.albedo, 2),
    });
  }
  const rows = [
    [t('rows.zenith'), `${fmt(sun.zenith)}°`],
    [t('rows.elevationAngle'), `${fmt(sun.elevation)}°`],
    [t('rows.distance'), sun.distanceAU != null ? `${fmt(sun.distanceAU, 4)} AU` : '—'],
    [t('rows.elevation'), `${fmt(data.hourly.elevationM, 0)} m`],
    [t('rows.pressure'), now?.pressureHpa != null ? `${fmt(now.pressureHpa, 0)} hPa` : '—'],
    [t('rows.cloudCover'), atm.cloudCover != null ? `${fmt(atm.cloudCover, 0)} %` : '—'],
    [t('rows.aod'), fmt(atm.aod, 2)],
    [t('rows.snowDepth'), atm.snowDepth != null ? `${fmt(atm.snowDepth * 100, 0)} cm` : '—'],
    [t('rows.surroundings'), surfaceText],
    [t('rows.ozone'), atm.ozone != null ? `${fmt(atm.ozone, 0)} µg/m³` : '—'],
    [t('rows.uvIndex'), fmt(atm.uvIndex, 1)],
    [t('rows.uvIndexClear'), fmt(atm.uvIndexClearSky, 1)],
  ];

  const f = now?.factors ?? {};
  const factorRows = [
    [t('factors.baseline'), `${fmt(f.baseline, 1)} W/m²`],
    [t('factors.altitude'), `×${fmt(f.altitude, 3)}`],
    [t('factors.aerosol'), `×${fmt(f.aerosol, 3)}`],
    [t('factors.surroundings'), `×${fmt(f.albedo, 3)}`],
    [t('factors.distance'), `×${fmt(f.distance, 3)}`],
    [t('factors.cloud'), `×${fmt(f.cloud, 3)}`],
  ];

  $('params').innerHTML = rows
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  $('factors').innerHTML = factorRows
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
}

// --- wire up ----------------------------------------------------------------

function init() {
  $('use-location').addEventListener('click', () => useBrowserLocation());

  const search = $('place-search');
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', onSearchKeydown);
  // Close the dropdown when focus leaves the box (delay lets clicks register).
  search.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

  // Select a suggestion on click.
  $('suggestions').addEventListener('mousedown', (e) => {
    const item = e.target.closest('.suggestion');
    if (item) selectPlace(suggestions[Number(item.dataset.i)]);
  });

  $('refresh').addEventListener('click', refresh);
  // Surface only changes the albedo term — recompute, don't re-fetch.
  $('surface').addEventListener('change', recompute);

  $('days').addEventListener('click', (e) => {
    const btn = e.target.closest('.day');
    if (btn) selectDay(Number(btn.dataset.i));
  });

  // Redraw the chart at the new width (it's drawn 1:1 so text stays legible).
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (forecast && w && w !== lastWidth) renderSelectedDay();
    lastWidth = w;
  }).observe($('chart'));

  // A link that names a place (?lat=…&lon=…&name=…, e.g. from the embeddable
  // widget) opens straight on it; otherwise try the visitor's own location.
  const linked = parseWidgetParams(window.location.search);
  if (linked.lat !== null && linked.lon !== null) {
    const surface = new URLSearchParams(window.location.search).get('surface');
    if (surface) $('surface').value = linked.surface;
    if (linked.name) $('place-search').value = linked.name;
    setLocation({
      lat: linked.lat,
      lon: linked.lon,
      label: linked.name || coordLabel(linked.lat, linked.lon),
      timezone: linked.tz,
    });
    if (!linked.tz) {
      fetchTimezone(linked.lat, linked.lon)
        .then((tz) => {
          if (tz && location?.lat === linked.lat && location?.lon === linked.lon && !location.timezone) {
            location.timezone = tz;
            recompute();
          }
        })
        .catch(() => {});
    }
  } else {
    autoLocate();
  }
}

document.addEventListener('DOMContentLoaded', init);
