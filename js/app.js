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
    if (!silent) setStatus('Geolocation not supported by this browser.', true);
    return;
  }
  setLocating(true);
  if (!silent) setStatus('Finding your location…');
  const seq = ++locationSeq;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      // The user picked a place while we were waiting — theirs wins.
      if (seq !== locationSeq) return setLocating(false);
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      hideSuggestions();
      setLocationLabel('Locating nearest place…');
      // Resolve city name and timezone in parallel.
      const [name, tz] = await Promise.all([
        reverseGeocode(lat, lon).catch(() => null),
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
        setStatus(`Could not get location: ${err.message}`, true);
      } else if (!location) {
        setLocationLabel('Search for a place to begin');
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
  setStatus('Searching…');
  try {
    const results = await geocode(q);
    if ($('place-search').value.trim() !== q) return; // query changed meanwhile
    if (!results.length) {
      setStatus('No matching place found.', true);
      return;
    }
    selectPlace(rankSuggestions(results)[0]);
  } catch (e) {
    setStatus(`Search failed: ${e.message}`, true);
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
      const results = await geocode(q, 8);
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

function formatPopulation(p) {
  if (p >= 1e6) return `${(p / 1e6).toFixed(p >= 1e7 ? 0 : 1)}M`;
  if (p >= 1e3) return `${Math.round(p / 1e3)}k`;
  return String(p);
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
    setLocationLabel('Search for a place to begin');
    return;
  }
  try {
    if (navigator.permissions) {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') {
        setLocationLabel('Search for a place to begin');
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
    setStatus('Choose a location first.', true);
    return;
  }
  const seq = ++fetchSeq;
  const loc = location;
  setRefreshing(true);
  setStatus('Fetching atmospheric data…');
  try {
    const hourly = await fetchHourly(loc.lat, loc.lon);
    if (seq !== fetchSeq) return; // a newer refresh (or location) took over
    data = { hourly, fetchedAt: new Date(), location: loc };
    recompute();
    setStatus('');
  } catch (e) {
    if (seq !== fetchSeq) return;
    setStatus(`Calculation failed: ${e.message}`, true);
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
  $('refresh-label').textContent = on ? 'Refreshing…' : 'Refresh';
}

// --- rendering --------------------------------------------------------------

function fmt(v, digits = 1) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '—';
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
  if (i === 0) return 'Today';
  if (i === 1) return 'Tomorrow';
  return formatDay(day.start, timeZone(), { long: true });
}

// One line describing a day: its peak and when protection is advised.
function summaryLine(day, i) {
  const { peak, protect } = day.summary;
  if (!peak) return '';
  const when = i === 0 ? 'Today' : dayName(day, i);
  let line = `${when}: peak ${fmt(peak.index)} (${peak.band.label}) around ${roundedClock(peak.time)}`;
  line += protect
    ? ` · Moderate or higher ${roundedClock(protect.start)}–${roundedClock(protect.end)}`
    : ' · below Moderate all day';
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
  $('uva-band').textContent = band ? band.label : '—';
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
      const name = i === 0 ? 'Today' : formatDay(day.start, timeZone());
      return (
        `<button type="button" class="day" data-i="${i}" aria-pressed="${i === selectedDay}"` +
        ` aria-label="${dayName(day, i)}: peak ${fmt(peak?.index)} ${peak?.band.label ?? ''}">` +
        `<span class="day-name">${name}</span>` +
        `<span class="day-peak" style="color:${peak?.band.color ?? 'inherit'}">${fmt(peak?.index)}</span>` +
        `<span class="day-band">${peak?.band.label ?? '—'}</span>` +
        `</button>`
      );
    })
    .join('');
}

function renderSelectedDay() {
  const day = forecast.days[selectedDay];
  if (!day) {
    $('day-summary').textContent = '';
    $('chart').innerHTML = '<p class="chart-empty">No forecast data for this location.</p>';
    return;
  }
  const line = summaryLine(day, selectedDay);
  $('day-summary').textContent = line;
  renderChart($('chart'), {
    day,
    timeZone: timeZone(),
    now: forecast.now?.time,
    label: `UVA Index through the day. ${line}`,
  });
}

function selectDay(i) {
  selectedDay = i;
  $('days')
    .querySelectorAll('.day')
    .forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)));
  renderSelectedDay();
}

function renderTables(now) {
  const atm = now?.atm ?? {};
  const sun = now?.sun ?? {};
  const rows = [
    ['Solar zenith angle', `${fmt(sun.zenith)}°`],
    ['Solar elevation', `${fmt(sun.elevation)}°`],
    ['Elevation', `${fmt(data.hourly.elevationM, 0)} m`],
    ['Cloud cover', atm.cloudCover != null ? `${fmt(atm.cloudCover, 0)} %` : '—'],
    ['Aerosol optical depth', fmt(atm.aod, 2)],
    ['Surface ozone (info)', atm.ozone != null ? `${fmt(atm.ozone, 0)} µg/m³` : '—'],
    ['UV Index (cross-check)', fmt(atm.uvIndex, 1)],
    ['UV Index clear sky', fmt(atm.uvIndexClearSky, 1)],
  ];

  const f = now?.factors ?? {};
  const factorRows = [
    ['Clear-sky baseline', `${fmt(f.baseline, 1)} W/m²`],
    ['× Altitude', `×${fmt(f.altitude, 3)}`],
    ['× Aerosol', `×${fmt(f.aerosol, 3)}`],
    ['× Cloud', `×${fmt(f.cloud, 3)}`],
    ['× Albedo', `×${fmt(f.albedo, 3)}`],
  ];

  $('params').innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join('');
  $('factors').innerHTML = factorRows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
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

  // ...and tries to pull the current location automatically.
  autoLocate();
}

document.addEventListener('DOMContentLoaded', init);
