// app.js — wires the UI together: resolve location, fetch atmosphere, compute
// UVA, render the result and a transparent breakdown.

import { solarPosition } from './solar.js';
import { computeUVA } from './uva.js';
import { geocode, coordLabel, fetchWeather, fetchAirQuality } from './api.js';

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

// --- location handling ------------------------------------------------------

function useBrowserLocation() {
  if (!navigator.geolocation) {
    setStatus('Geolocation not supported by this browser.', true);
    return;
  }
  setStatus('Locating…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      location = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        label: coordLabel(pos.coords.latitude, pos.coords.longitude),
      };
      setLocationLabel(`📍 ${location.label}`);
      setStatus('');
      calculate();
    },
    (err) => setStatus(`Could not get location: ${err.message}`, true),
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

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
    const r = results[0];
    location = {
      lat: r.latitude,
      lon: r.longitude,
      label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    };
    setLocationLabel(`📍 ${location.label}`);
    setStatus('');
    calculate();
  } catch (e) {
    setStatus(`Search failed: ${e.message}`, true);
  }
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

    render(result, sun, weather, air);
    setStatus('');
  } catch (e) {
    setStatus(`Calculation failed: ${e.message}`, true);
  }
}

// --- rendering --------------------------------------------------------------

function fmt(v, digits = 1) {
  return typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '—';
}

function render(result, sun, weather, air) {
  $('result').hidden = false;

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
  $('datetime').value = nowLocalInputValue();
  $('use-location').addEventListener('click', useBrowserLocation);
  $('search-btn').addEventListener('click', searchLocation);
  $('place-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchLocation();
  });
  $('calculate').addEventListener('click', calculate);
  $('datetime').addEventListener('change', () => location && calculate());
  $('surface').addEventListener('change', () => location && calculate());
}

document.addEventListener('DOMContentLoaded', init);
