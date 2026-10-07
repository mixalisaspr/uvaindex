// forecast.js — turns hourly atmospheric data into UVA Index values: the
// reading for "now", a smooth curve for each local day, and the day's headline
// facts (peak, and when UVA is Moderate or higher). Pure functions.

import { solarPosition } from './solar.js';
import { computeUVA, classifyUVA, MODEL } from './uva.js';
import { localDays } from './tz.js';

// Curve resolution. Solar geometry is exact at every step; the hourly
// atmosphere is interpolated between samples.
export const STEP_MINUTES = 15;

// The band from which sun protection is advised — "Moderate" (3+), as with the
// WHO UV Index guidance the bands are borrowed from.
export const PROTECT_FROM = 3;

// Erythemal cloud transmission = live UV index / clear-sky UV index. This
// isolates the cloud effect (aerosol, ozone and geometry cancel in the ratio).
// Returns undefined when the clear-sky reference is missing or too small to be
// reliable (sun low), so the model falls back to its parametric cloud term.
export function cloudTransmission(uvIndex, uvIndexClearSky) {
  if (typeof uvIndex !== 'number' || typeof uvIndexClearSky !== 'number') {
    return undefined;
  }
  if (uvIndexClearSky < 0.1) return undefined;
  return uvIndex / uvIndexClearSky;
}

const isNum = (v) => typeof v === 'number' && isFinite(v);

// Linear interpolation that degrades to the nearest sample when either side
// is missing.
function lerp(a, b, frac) {
  if (isNum(a) && isNum(b)) return a + (b - a) * frac;
  return frac < 0.5 ? (isNum(a) ? a : b) : isNum(b) ? b : a;
}

export const ATMOSPHERE_FIELDS = ['cloudCover', 'pressure', 'snowDepth', 'aod', 'uvIndex', 'uvIndexClearSky', 'ozone', 'uvCloud'];

// Atmosphere at instant `t`, interpolated between the surrounding hourly
// samples (`hours` sorted by time, each optionally carrying `uvCloud`).
// Returns null outside the data's range. `fields` picks what to interpolate.
export function atmosphereAt(hours, t, fields = ATMOSPHERE_FIELDS) {
  const ms = t.getTime();
  if (!hours.length || ms < hours[0].time - 1 || ms > hours[hours.length - 1].time.getTime() + 1) {
    return null;
  }
  let i = 0;
  while (i < hours.length - 2 && hours[i + 1].time.getTime() <= ms) i++;
  const a = hours[i];
  const b = hours[Math.min(i + 1, hours.length - 1)];
  const span = b.time - a.time;
  const frac = span > 0 ? Math.min(1, Math.max(0, (ms - a.time) / span)) : 0;
  const out = {};
  for (const f of fields) out[f] = lerp(a[f], b[f], frac);
  return out;
}

// Precompute the per-hour cloud transmission once, so interpolation works on
// the ratio itself rather than on its two halves.
export function withCloudTransmission(hours) {
  return hours.map((h) => ({ ...h, uvCloud: cloudTransmission(h.uvIndex, h.uvIndexClearSky) }));
}

// The surroundings to model: the user's choice, or for 'auto' snow when the
// forecast has snow on the ground and ordinary ground otherwise.
export function resolveSurface(surface, snowDepth) {
  if (surface !== 'auto') return surface;
  return typeof snowDepth === 'number' && snowDepth >= MODEL.SNOW_DEPTH_M ? 'snow' : 'grass';
}

// Model output at instant `t`. Returns null when there's no atmospheric data
// for that instant.
export function uvaAt(t, hours, { lat, lon, elevationM, surface }) {
  const atm = atmosphereAt(hours, t);
  if (!atm) return null;
  const sun = solarPosition(t, lat, lon);
  const resolvedSurface = resolveSurface(surface, atm.snowDepth);
  const result = computeUVA({
    zenith: sun.zenith,
    aboveHorizon: sun.aboveHorizon,
    pressureHpa: atm.pressure,
    elevationM,
    distanceAU: sun.distanceAU,
    aod: atm.aod,
    cloudCover: atm.cloudCover,
    // Derive the real cloud effect from live UV (erythemal) and let the model
    // lift it for UVA's better cloud penetration; falls back to cloudCover.
    uvCloudTransmission: atm.uvCloud,
    surface: resolvedSurface,
  });
  return { time: t, sun, atm, surface: resolvedSurface, ...result };
}

// Curve points for one local day [start, end).
export function daySeries(day, hours, site) {
  const points = [];
  const step = STEP_MINUTES * 60000;
  for (let ms = day.start.getTime(); ms <= day.end.getTime(); ms += step) {
    const r = uvaAt(new Date(ms), hours, site);
    if (r) points.push({ time: r.time, index: r.index });
  }
  return points;
}

// Where a straight line between two samples crosses `level` (as a Date).
function crossing(p, q, level) {
  const frac = (level - p.index) / (q.index - p.index);
  return new Date(p.time.getTime() + frac * (q.time - p.time));
}

// The day's headline facts:
//   peak    — { index, time, band } of the highest point, or null if no data
//   protect — { start, end } of the span at PROTECT_FROM or above, or null if
//             the day never gets there
export function summarizeDay(points) {
  if (!points.length) return { peak: null, protect: null };
  let peak = points[0];
  for (const p of points) if (p.index > peak.index) peak = p;

  let protect = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].index < PROTECT_FROM) continue;
    const start = i > 0 ? crossing(points[i - 1], points[i], PROTECT_FROM) : points[i].time;
    let j = i;
    while (j + 1 < points.length && points[j + 1].index >= PROTECT_FROM) j++;
    const end = j + 1 < points.length ? crossing(points[j], points[j + 1], PROTECT_FROM) : points[j].time;
    // UVA rises and falls once a day; if cloud splits the span, report its
    // full extent (first rise to last fall).
    protect = protect ? { start: protect.start, end } : { start, end };
    i = j;
  }

  return {
    peak: { index: peak.index, time: peak.time, band: classifyUVA(peak.index) },
    protect,
  };
}

// Everything the page shows, from one fetch:
//   now  — model output for `now` (null if the data doesn't cover it)
//   days — [{ start, end, points, summary }] for `dayCount` local days from
//          the one containing `now`; days with no data are dropped
export function buildForecast(data, { now, timeZone, dayCount, ...site }) {
  const hours = withCloudTransmission(data.hours);
  const ctx = { ...site, elevationM: data.elevationM };
  const days = localDays(now, timeZone, dayCount)
    .map((day) => {
      const points = daySeries(day, hours, ctx);
      return { ...day, points, summary: summarizeDay(points) };
    })
    .filter((d) => d.points.length >= 2);
  return { now: uvaAt(now, hours, ctx), days };
}
