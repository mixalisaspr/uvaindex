#!/usr/bin/env node
// validate.mjs — measure the UVA model against independent reference data.
//
// Replays archived Open-Meteo inputs (the same fields the site uses) through
// the site's own model code for past dates, and compares the result with a
// reference UVA record:
//
//   * NASA POWER hourly ALLSKY_SFC_UVA (W/m2) — satellite-derived (CERES
//     SYN1deg), free, global. Not a ground measurement, and a 1° grid, but
//     independent of our inputs: good for systematic bias by sun angle,
//     season and cloud.
//   * or a CSV of ground measurements (`time,uva` with ISO UTC times and W/m2)
//     from a broadband UVA radiometer or an integrated spectroradiometer.
//
// It reports bias and error overall and by sun angle and cloudiness, and fits
// the cloud coefficients that are still uncalibrated:
//   * CLOUD_UVA_EXP  — UVA cloud transmission = (UV Index ratio) ^ exp
//   * an alternative cloud source: the weather model's instantaneous
//     shortwave radiation over a clear-sky estimate, ^ exp
//
// Usage (Node 22+, no dependencies):
//   node scripts/validate.mjs --sites scripts/validation-sites.json \
//        --start 2025-06-01 --end 2025-06-30
//   node scripts/validate.mjs --lat 46.81 --lon 9.84 --start 2025-01-01 --end 2025-01-31
//   node scripts/validate.mjs --lat 52.1 --lon 5.18 --csv measured.csv \
//        --window instant --start 2025-05-01 --end 2025-05-31
//   Add --json results.json to save everything for later analysis.
//
// The archive APIs only reach back a few years (Open-Meteo's archived CAMS
// air-quality data starts in 2022), and NASA POWER's CERES data lags real
// time by a few months, so pick a period from roughly 2022 to ~4 months ago.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mergeHourly } from '../js/api.js';
import { ATMOSPHERE_FIELDS, atmosphereAt, resolveSurface, withCloudTransmission } from '../js/forecast.js';
import { solarPosition } from '../js/solar.js';
import { computeUVA, MODEL } from '../js/uva.js';

const HISTORICAL_FORECAST_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const POWER_URL = 'https://power.larc.nasa.gov/api/temporal/hourly/point';

const HOUR = 3600000;
// Model samples per reference interval (every 10 minutes across an hour).
const SUBSTEP_MINUTES = 10;
// Only compare daytime samples with the sun reasonably high: near the horizon
// both the reference and the model are tiny and relative errors meaningless.
const MAX_ZENITH = 85;

export const CLOUD_EXPONENTS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4];
export const GHI_EXPONENTS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// --- reference data ----------------------------------------------------------

// NASA POWER hourly JSON -> [{ time: Date (start of hour, UTC), uva }].
export function parsePower(json) {
  const series = json?.properties?.parameter?.ALLSKY_SFC_UVA;
  if (!series) throw new Error('POWER response has no ALLSKY_SFC_UVA series');
  const fill = json?.header?.fill_value ?? -999;
  return Object.entries(series)
    .filter(([, v]) => typeof v === 'number' && v !== fill && v > -900)
    .map(([k, v]) => ({
      time: new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(8, 10))),
      uva: v,
    }))
    .sort((a, b) => a.time - b.time);
}

// CSV with a header containing `time` and `uva` columns (any order).
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const ti = header.indexOf('time');
  const ui = header.indexOf('uva');
  if (ti < 0 || ui < 0) throw new Error('CSV needs `time` and `uva` columns');
  return lines
    .map((l) => l.split(','))
    .map((c) => {
      const t = c[ti].trim();
      return { time: new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`), uva: parseFloat(c[ui]) };
    })
    .filter((r) => !isNaN(r.time) && isFinite(r.uva));
}

// Instants at which to evaluate the model for one reference value.
//   'hour-beginning': mean over [t, t+1h)   (NASA POWER's labelling)
//   'hour-ending':    mean over (t-1h, t]
//   'instant':        the instant t itself
export function sampleTimes(time, window) {
  if (window === 'instant') return [time];
  const start = window === 'hour-ending' ? time.getTime() - HOUR : time.getTime();
  const n = 60 / SUBSTEP_MINUTES;
  // Midpoints of n equal sub-intervals.
  return Array.from({ length: n }, (_, i) => new Date(start + ((i + 0.5) * HOUR) / n));
}

// --- model variants ------------------------------------------------------------

// Clear-sky global shortwave (Haurwitz 1945), W/m2 — the denominator for the
// shortwave cloud-transmission candidate.
export function haurwitzGhi(zenith) {
  const c = Math.cos((zenith * Math.PI) / 180);
  return c > 0 ? 1098 * c * Math.exp(-0.059 / c) : 0;
}

// All model variants at one instant: { 'cams^1.0': W/m2, 'ghi^0.7': ..., clearSky }.
const FIELDS = [...ATMOSPHERE_FIELDS, 'ghi'];

export function variantsAt(t, hours, site) {
  const atm = atmosphereAt(hours, t, FIELDS);
  if (!atm) return null;
  const sun = solarPosition(t, site.lat, site.lon);
  const base = {
    zenith: sun.zenith,
    aboveHorizon: sun.aboveHorizon,
    pressureHpa: atm.pressure,
    elevationM: site.elevationM,
    distanceAU: sun.distanceAU,
    aod: atm.aod,
    cloudCover: atm.cloudCover,
    surface: resolveSurface('auto', atm.snowDepth),
  };
  const out = { zenith: sun.zenith, uvCloud: atm.uvCloud, cloudCover: atm.cloudCover };
  out.clearSky = computeUVA({ ...base, cloudCover: undefined }).uva;
  for (const e of CLOUD_EXPONENTS) {
    out[`cams^${e.toFixed(1)}`] = computeUVA(
      { ...base, uvCloudTransmission: atm.uvCloud },
      { ...MODEL, CLOUD_UVA_EXP: e }
    ).uva;
  }
  const ghiClear = haurwitzGhi(sun.zenith);
  const tSw =
    ghiClear > 50 && isFinite(atm.ghi) ? Math.min(1.2, Math.max(0, atm.ghi / ghiClear)) : undefined;
  for (const e of GHI_EXPONENTS) {
    out[`ghi^${e.toFixed(1)}`] = computeUVA({
      ...base,
      uvCloudTransmission: tSw === undefined ? undefined : Math.pow(tSw, e),
    }).uva;
  }
  return out;
}

// Mean of each variant over a reference value's sample instants.
function meanVariants(samples) {
  const out = {};
  for (const key of Object.keys(samples[0])) {
    const vals = samples.map((s) => s[key]).filter((v) => typeof v === 'number' && isFinite(v));
    out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  }
  return out;
}

// Pair each reference value with the model variants over its window.
export function pairUp(reference, hours, site, window) {
  const prepared = withCloudTransmission(hours);
  const pairs = [];
  for (const r of reference) {
    const samples = sampleTimes(r.time, window)
      .map((t) => variantsAt(t, prepared, site))
      .filter(Boolean);
    if (!samples.length) continue;
    const m = meanVariants(samples);
    if (!(m.zenith < MAX_ZENITH)) continue;
    pairs.push({ time: r.time, ref: r.uva, ...m });
  }
  return pairs;
}

// --- statistics -----------------------------------------------------------------

export function metrics(pairs, key) {
  const xs = pairs.filter((p) => isFinite(p[key]) && isFinite(p.ref));
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = (f) => xs.reduce((a, p) => a + f(p), 0) / n;
  const refMean = mean((p) => p.ref);
  const modMean = mean((p) => p[key]);
  const bias = modMean - refMean;
  const mae = mean((p) => Math.abs(p[key] - p.ref));
  const rmse = Math.sqrt(mean((p) => (p[key] - p.ref) ** 2));
  const cov = mean((p) => (p[key] - modMean) * (p.ref - refMean));
  const sd = (f, m) => Math.sqrt(mean((p) => (f(p) - m) ** 2));
  const r = cov / (sd((p) => p[key], modMean) * sd((p) => p.ref, refMean));
  return { n, refMean, modMean, bias, biasPct: (100 * bias) / refMean, mae, rmse, r };
}

const ZENITH_BINS = [[0, 30], [30, 50], [50, 70], [70, MAX_ZENITH]];
const CLOUD_BINS = [
  ['clear (UV ratio ≥ 0.9)', (p) => p.uvCloud >= 0.9],
  ['broken (0.5–0.9)', (p) => p.uvCloud >= 0.5 && p.uvCloud < 0.9],
  ['overcast (< 0.5)', (p) => p.uvCloud < 0.5],
];

export function report(pairs, { key = 'cams^1.0' } = {}) {
  const all = metrics(pairs, key);
  const byZenith = ZENITH_BINS.map(([lo, hi]) => ({
    label: `${lo}–${hi}°`,
    ...metrics(pairs.filter((p) => p.zenith >= lo && p.zenith < hi), key),
  }));
  const byCloud = CLOUD_BINS.map(([label, f]) => ({ label, ...metrics(pairs.filter(f), key) }));
  // Clear-sky check: the radiative-transfer table and aerosol on their own.
  const clear = metrics(pairs.filter(CLOUD_BINS[0][1]), 'clearSky');
  const fit = (prefix, exps) =>
    exps
      .map((e) => ({ exp: e, ...metrics(pairs, `${prefix}^${e.toFixed(1)}`) }))
      .sort((a, b) => a.rmse - b.rmse);
  return { all, byZenith, byCloud, clear, camsFit: fit('cams', CLOUD_EXPONENTS), ghiFit: fit('ghi', GHI_EXPONENTS) };
}

// --- I/O ----------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json()).slice(0, 300);
    } catch {
      /* no body */
    }
    throw new Error(`HTTP ${res.status} for ${url}\n${detail}`);
  }
  return res.json();
}

export async function fetchInputs(site, start, end) {
  const coords = `latitude=${site.lat}&longitude=${site.lon}&start_date=${start}&end_date=${end}&timezone=UTC`;
  const [weather, air] = await Promise.all([
    fetchJson(
      `${HISTORICAL_FORECAST_URL}?${coords}` +
        '&hourly=cloud_cover,surface_pressure,snow_depth,shortwave_radiation_instant'
    ),
    fetchJson(`${AIR_QUALITY_URL}?${coords}&hourly=uv_index,uv_index_clear_sky,aerosol_optical_depth,ozone`),
  ]);
  const hours = mergeHourly(weather.hourly, air.hourly);
  // mergeHourly covers the site's fields; add the shortwave candidate.
  const ghi = new Map((weather.hourly?.time || []).map((t, i) => [t, weather.hourly.shortwave_radiation_instant?.[i]]));
  for (const h of hours) h.ghi = ghi.get(h.time.toISOString().slice(0, 16));
  return { elevationM: weather.elevation ?? 0, hours };
}

export async function fetchPower(site, start, end) {
  const d = (s) => s.replaceAll('-', '');
  const url =
    `${POWER_URL}?parameters=ALLSKY_SFC_UVA&community=RE&longitude=${site.lon}&latitude=${site.lat}` +
    `&start=${d(start)}&end=${d(end)}&format=JSON&time-standard=UTC`;
  return parsePower(await fetchJson(url));
}

const f = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');

export function formatReport(name, rep) {
  const row = (label, m) =>
    `| ${label} | ${m.n} | ${f(m.refMean)} | ${f(m.modMean)} | ${f(m.bias)} (${f(m.biasPct, 0)}%) | ${f(m.mae)} | ${f(m.rmse)} | ${f(m.r, 3)} |`;
  const head = '| subset | n | ref W/m² | model W/m² | bias | MAE | RMSE | r |\n|---|---|---|---|---|---|---|---|';
  const fitRow = (prefix) => (m) => `| ${prefix}^${m.exp.toFixed(1)} | ${f(m.bias)} (${f(m.biasPct, 0)}%) | ${f(m.rmse)} | ${f(m.r, 3)} |`;
  return [
    `## ${name}`,
    '',
    'Current model (CAMS UV-ratio cloud, exponent 1.0):',
    '',
    head,
    row('all daytime', rep.all),
    ...rep.byZenith.map((m) => row(`zenith ${m.label}`, m)),
    ...rep.byCloud.map((m) => row(m.label, m)),
    row('clear hours, no cloud term', rep.clear),
    '',
    'Cloud-term candidates, best first (lower RMSE is better):',
    '',
    '| cloud source ^ exponent | bias | RMSE | r |\n|---|---|---|---|',
    ...rep.camsFit.slice(0, 3).map(fitRow('cams')),
    ...rep.ghiFit.slice(0, 3).map(fitRow('ghi')),
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return args;
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (!args.start || !args.end || (!args.sites && !(args.lat && args.lon))) {
    console.error('Usage: node scripts/validate.mjs (--sites FILE | --lat LAT --lon LON) --start YYYY-MM-DD --end YYYY-MM-DD [--csv FILE] [--window hour-beginning|hour-ending|instant] [--json OUT]');
    return 2;
  }
  const sites = args.sites
    ? JSON.parse(await readFile(args.sites, 'utf8'))
    : [{ name: args.name || `${args.lat}, ${args.lon}`, lat: +args.lat, lon: +args.lon }];
  const window = args.window || (args.csv ? 'instant' : 'hour-beginning');
  const allPairs = [];
  const results = [];
  for (const site of sites) {
    process.stderr.write(`${site.name}: fetching… `);
    const [inputs, reference] = await Promise.all([
      fetchInputs(site, args.start, args.end),
      args.csv ? readFile(args.csv, 'utf8').then(parseCsv) : fetchPower(site, args.start, args.end),
    ]);
    const s = { ...site, elevationM: inputs.elevationM };
    const pairs = pairUp(reference, inputs.hours, s, window);
    process.stderr.write(`${pairs.length} daytime pairs\n`);
    // Sanity check on time alignment: a mislabelled window shows up as a
    // much better correlation one hour off.
    if (!args.csv) {
      const other = metrics(pairUp(reference, inputs.hours, s, 'hour-ending'), 'cams^1.0');
      const mine = metrics(pairs, 'cams^1.0');
      if (other.r > mine.r + 0.02) {
        console.error(`  warning: hour-ending alignment fits better (r ${f(other.r, 3)} vs ${f(mine.r, 3)}) — check --window`);
      }
    }
    const rep = report(pairs);
    results.push({ site: s, report: rep });
    allPairs.push(...pairs);
    console.log(formatReport(site.name, rep));
  }
  if (sites.length > 1) console.log(formatReport('All sites', report(allPairs)));
  if (args.json) {
    await writeFile(args.json, JSON.stringify({ args, results, pairs: allPairs }, null, 1));
    console.error(`Saved ${args.json}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(1);
    }
  );
}
