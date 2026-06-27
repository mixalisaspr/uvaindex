// app.js — wires the UI together: resolve location, fetch atmosphere, compute
// UVA, render the result and a transparent breakdown.

import { solarPosition } from './solar.js';
import { computeUVA } from './uva.js';
import {
  geocode,
  reverseGeocode,
  coordLabel,
  fetchWeather,
  fetchAirQuality,
} from './api.js';
import { renderChart } from './chart.js';

const $ = (id) => document.getElementById(id);

// Current location chosen by the user.
let location = null; // { lat, lon, label }

// --- UI helpers -------------------------------------------------------------

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

function setLocationLabel(text) {
  $('location-label').textContent = text;
}

function nowLocalInputValue() {
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
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
// automatic attempts (page load / refresh); `fallbackRecalc` recalculates with
// the existing location if a fresh fix can't be obtained.
function useBrowserLocation({ silent = false, fallbackRecalc = false } = {}) {
  if (!navigator.geolocation) {
    if (!silent) setStatus('Geolocation not supported by this browser.', true);
    return;
  }
  setLocating(true);
  if (!silent) setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      location = { lat, lon, label: coordLabel(lat, lon) };
      hideSuggestions();
      setLocationLabel('Locating nearest place…');
      // Replace the raw coordinates with a friendly city/town name.
      try {
        const name = await reverseGeocode(lat, lon);
        if (name) location.label = name;
      } catch {
        /* keep the coordinate fallback */
      }
      setLocationLabel(location.label);
      setLocating(false);
      setStatus('');
      calculate();
    },
    (err) => {
      setLocating(false);
      if (location && fallbackRecalc) {
        setStatus('');
        calculate();
        return;
      }
      if (!silent) {
        setStatus(`Could not get location: ${err.message}`, true);
      } else if (!location) {
        setLocationLabel('Search for a place to begin');
      }
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

// Toggle the spinning/disabled feedback on the locate + refresh buttons.
function setLocating(on) {
  ['use-location', 'refresh'].forEach((id) => {
    const btn = $(id);
    btn.classList.toggle('spinning', on);
    btn.disabled = on;
  });
}

// Refresh button: reset the time to now and re-pull the location, then
// recalculate. Falls back to the current location if geolocation is blocked.
function refreshAll() {
  $('datetime').value = nowLocalInputValue();
  useBrowserLocation({ silent: true, fallbackRecalc: true });
}

// Set the chosen location from a geocoding result and recalculate.
function selectPlace(r) {
  location = {
    lat: r.latitude,
    lon: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  };
  $('place-search').value = r.name;
  setLocationLabel(location.label);
  hideSuggestions();
  setStatus('');
  calculate();
}

// Enter-to-search fallback when no suggestion is highlighted.
async function searchLocation() {
  const q = $('place-search').value.trim();
  if (!q) return;
  setStatus('Searching…');
  try {
    const results = await geocode(q);
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
      // Ignore stale responses if the box has since been cleared.
      if (!$('place-search').value.trim()) return;
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
        `<li class="suggestion" role="option" data-i="${i}">` +
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
}

function moveActive(delta) {
  if (!suggestions.length) return;
  activeSuggestion =
    (activeSuggestion + delta + suggestions.length) % suggestions.length;
  const items = $('suggestions').querySelectorAll('.suggestion');
  items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestion));
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

// --- main calculation -------------------------------------------------------

async function calculate() {
  if (!location) {
    setStatus('Choose a location first.', true);
    return;
  }
  const when = new Date($('datetime').value);
  if (isNaN(when.getTime())) {
    setStatus('Pick a valid date and time.', true);
    return;
  }
  const surface = $('surface').value;

  setStatus('Fetching atmospheric data…');
  try {
    const [weather, air] = await Promise.all([
      fetchWeather(location.lat, location.lon, when),
      fetchAirQuality(location.lat, location.lon, when),
    ]);

    const sun = solarPosition(when, location.lat, location.lon);

    const result = computeUVA({
      zenith: sun.zenith,
      aboveHorizon: sun.aboveHorizon,
      elevationM: weather.elevationM,
      // Open-Meteo air-quality ozone is surface concentration (ug/m3), not the
      // total-column Dobson Units our model expects, so we deliberately omit it
      // and let the (weak) ozone term default to 1. Shown as info only below.
      aod: air.aod,
      cloudCover: weather.cloudCover,
      surface,
    });

    const series = buildDailySeries(weather, air, surface);

    render(result, sun, weather, air);
    renderChart($('chart'), series, when);
    setStatus('');
  } catch (e) {
    setStatus(`Calculation failed: ${e.message}`, true);
  }
}

// Compute a full-day UVA series (one point per available hour) so the chart can
// show how the UVA Index rises and falls. Uses the same model as the headline
// number, just evaluated at every hour with that hour's cloud/aerosol values.
function buildDailySeries(weather, air, surface) {
  const times = weather.hourly?.time || [];
  // Map air-quality AOD by timestamp so it lines up even if arrays differ.
  const aodByTime = new Map();
  const airTimes = air.hourly?.time || [];
  airTimes.forEach((t, i) => aodByTime.set(t, air.hourly.aod[i]));

  return times.map((t, i) => {
    const when = new Date(t);
    const sun = solarPosition(when, location.lat, location.lon);
    const r = computeUVA({
      zenith: sun.zenith,
      aboveHorizon: sun.aboveHorizon,
      elevationM: weather.elevationM,
      aod: aodByTime.get(t),
      cloudCover: weather.hourly.cloudCover[i],
      surface,
    });
    return { time: when, index: r.index };
  });
}

// --- rendering --------------------------------------------------------------

function fmt(v, digits = 1) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '—';
}

function render(result, sun, weather, air) {
  $('result').hidden = false;

  // Headline is the UVA Index (0-11+); raw irradiance is the technical sub-value.
  $('uva-index').textContent = fmt(result.index, 1);
  $('uva-value').textContent = fmt(result.uva, 1);
  const band = $('uva-band');
  band.textContent = result.band.label;
  band.style.background = result.band.color;

  // Parameter breakdown table.
  const rows = [
    ['Solar zenith angle', `${fmt(sun.zenith)}°`],
    ['Solar elevation', `${fmt(sun.elevation)}°`],
    ['Elevation', `${fmt(weather.elevationM, 0)} m`],
    ['Cloud cover', weather.cloudCover != null ? `${fmt(weather.cloudCover, 0)} %` : '—'],
    ['Aerosol optical depth', fmt(air.aod, 2)],
    ['Surface ozone (info)', air.ozone != null ? `${fmt(air.ozone, 0)} µg/m³` : '—'],
    ['UV Index (cross-check)', fmt(air.uvIndex, 1)],
    ['UV Index clear sky', fmt(air.uvIndexClearSky, 1)],
  ];

  const f = result.factors;
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
  // Refreshing the page resets the time to now...
  $('datetime').value = nowLocalInputValue();

  $('use-location').addEventListener('click', () => useBrowserLocation());
  $('refresh').addEventListener('click', refreshAll);

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

  $('calculate').addEventListener('click', calculate);
  $('datetime').addEventListener('change', () => location && calculate());
  $('surface').addEventListener('change', () => location && calculate());

  // ...and tries to pull the current location automatically.
  autoLocate();
}

document.addEventListener('DOMContentLoaded', init);
