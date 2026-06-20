// api.js — Open-Meteo data fetch helpers. All endpoints are free, CORS-enabled,
// and need no API key.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return res.json();
}

// Search places by name. Returns an array of { name, country, latitude,
// longitude, admin1 }.
export async function geocode(name) {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  const data = await getJson(url);
  return (data.results || []).map((r) => ({
    name: r.name,
    country: r.country,
    admin1: r.admin1,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
}

// Reverse-ish label for coordinates (best-effort; geocoding API has no true
// reverse endpoint, so we just format the coords if nothing better is known).
export function coordLabel(lat, lon) {
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

// Pick the array index whose ISO hour string is closest to `target` (a Date).
function nearestHourIndex(times, target) {
  const targetMs = target.getTime();
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(new Date(times[i]).getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

// Fetch cloud cover, surface pressure and elevation around `when` (a Date).
export async function fetchWeather(lat, lon, when) {
  const dateStr = when.toISOString().slice(0, 10);
  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover,surface_pressure` +
    `&start_date=${dateStr}&end_date=${dateStr}&timezone=UTC`;
  const data = await getJson(url);
  const times = data.hourly?.time || [];
  const idx = nearestHourIndex(times, when);
  return {
    elevationM: data.elevation ?? 0,
    cloudCover: data.hourly?.cloud_cover?.[idx],
    surfacePressure: data.hourly?.surface_pressure?.[idx],
    time: times[idx],
  };
}

// Fetch UV index, aerosol optical depth and ozone around `when` (a Date).
export async function fetchAirQuality(lat, lon, when) {
  const dateStr = when.toISOString().slice(0, 10);
  const url =
    `${AIR_QUALITY_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=uv_index,uv_index_clear_sky,aerosol_optical_depth,ozone,dust` +
    `&start_date=${dateStr}&end_date=${dateStr}&timezone=UTC`;
  const data = await getJson(url);
  const times = data.hourly?.time || [];
  const idx = nearestHourIndex(times, when);
  // Open-Meteo's `ozone` here is column-integrated; units vary, so we treat it
  // as a soft hint and let the model's weak ozone term handle it gracefully.
  return {
    uvIndex: data.hourly?.uv_index?.[idx],
    uvIndexClearSky: data.hourly?.uv_index_clear_sky?.[idx],
    aod: data.hourly?.aerosol_optical_depth?.[idx],
    ozone: data.hourly?.ozone?.[idx],
    dust: data.hourly?.dust?.[idx],
    time: times[idx],
  };
}
