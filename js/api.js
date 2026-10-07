// api.js — Open-Meteo data fetch helpers. All endpoints are free, CORS-enabled,
// and need no API key.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
// BigDataCloud's client-side reverse geocoder is free, key-less and CORS-enabled
// — Open-Meteo has no reverse endpoint, so we use it to turn GPS coordinates
// into a human-friendly "city, region, country" label.
const REVERSE_GEOCODE_URL =
  'https://api.bigdatacloud.net/data/reverse-geocode-client';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return res.json();
}

// Search places by name. Returns an array of { name, country, admin1,
// latitude, longitude, population }. `count` controls how many candidates the
// caller gets back (used to populate the search-as-you-type suggestions).
export async function geocode(name, count = 5) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=${count}&language=en&format=json`;
  const data = await getJson(url);
  return (data.results || []).map((r) => ({
    name: r.name,
    country: r.country,
    admin1: r.admin1,
    latitude: r.latitude,
    longitude: r.longitude,
    population: r.population || 0,
    timezone: r.timezone || null,
  }));
}

// Fetch the IANA timezone name for a coordinate pair (used for GPS-located positions
// where we don't have a geocoding result that already includes the timezone).
export async function fetchTimezone(lat, lon) {
  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}&timezone=auto&current=temperature_2m`;
  const data = await getJson(url);
  return data.timezone || null;
}

// Turn GPS coordinates into the nearest city/town label. Best-effort: if the
// reverse-geocode service is unreachable the caller falls back to coordLabel().
export async function reverseGeocode(lat, lon) {
  const url = `${REVERSE_GEOCODE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const data = await getJson(url);
  const place =
    data.city || data.locality || data.principalSubdivision || null;
  // Build "City, Region, Country", dropping blanks and duplicates (e.g. when
  // the city and region share a name).
  const seen = new Set();
  const label = [place, data.principalSubdivision, data.countryName]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(', ');
  return label || null;
}

// Reverse-ish label for coordinates — the fallback when reverseGeocode() can't
// name the place.
export function coordLabel(lat, lon) {
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

// Open-Meteo returns hourly timestamps like "2026-07-04T14:00" — no "Z" or
// offset — even when queried with `timezone=UTC`. A bare ISO date-*time*
// string with no timezone designator is parsed by `new Date()` as *local*
// browser time, not UTC, so every one of these would silently be misread by
// an amount equal to the browser's UTC offset. Normalize to an explicit UTC
// string once, here, so every downstream `new Date(...)` call is correct.
function asUtcIso(t) {
  return t.endsWith('Z') ? t : `${t}Z`;
}

// How many local days the forecast covers (today + the next four). The
// air-quality model (CAMS) that supplies the UV Index and aerosol only reaches
// ~4-5 days ahead; past that the hours come back empty and the UVA model falls
// back to its parametric cloud-cover term, so later days are still computable.
export const FORECAST_DAYS = 5;

// Query window shared by both endpoints. We ask for UTC timestamps (so DST and
// half-hour zones can't skew the parsing) starting one UTC day back: a
// location's local midnight can fall on the previous UTC date (anywhere east of
// Greenwich), and the last local day can run up to 14 h into the UTC day after
// FORECAST_DAYS. The caller trims the result to the local days it needs.
const WINDOW = `&timezone=UTC&past_days=1&forecast_days=${FORECAST_DAYS + 1}`;

// Fetch every hourly input the model needs for the forecast window, merged
// from the forecast and air-quality APIs by timestamp. Returns
//   { elevationM, hours: [{ time: Date, cloudCover, aod, uvIndex,
//                           uvIndexClearSky, ozone }] }
// sorted by time. Missing values are left undefined/null for the model to
// skip.
export async function fetchHourly(lat, lon) {
  const coords = `latitude=${lat}&longitude=${lon}`;
  const [weather, air] = await Promise.all([
    getJson(`${FORECAST_URL}?${coords}&hourly=cloud_cover${WINDOW}`),
    getJson(
      `${AIR_QUALITY_URL}?${coords}` +
        `&hourly=uv_index,uv_index_clear_sky,aerosol_optical_depth,ozone${WINDOW}`
    ),
  ]);
  return {
    elevationM: weather.elevation ?? 0,
    hours: mergeHourly(weather.hourly, air.hourly),
  };
}

// Join the two APIs' hourly blocks on their timestamp strings (their arrays
// are not guaranteed to line up index-for-index).
export function mergeHourly(weatherHourly = {}, airHourly = {}) {
  const byTime = new Map();
  const row = (t) => {
    if (!byTime.has(t)) byTime.set(t, { time: new Date(asUtcIso(t)) });
    return byTime.get(t);
  };
  (weatherHourly.time || []).forEach((t, i) => {
    row(t).cloudCover = weatherHourly.cloud_cover?.[i];
  });
  (airHourly.time || []).forEach((t, i) => {
    const r = row(t);
    r.uvIndex = airHourly.uv_index?.[i];
    r.uvIndexClearSky = airHourly.uv_index_clear_sky?.[i];
    r.aod = airHourly.aerosol_optical_depth?.[i];
    r.ozone = airHourly.ozone?.[i];
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
