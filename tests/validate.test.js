import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePower,
  parseCsv,
  sampleTimes,
  haurwitzGhi,
  metrics,
  pairUp,
  report,
  fetchInputs,
  fetchPower,
  formatReport,
} from '../scripts/validate.mjs';
import { withCloudTransmission, atmosphereAt } from '../js/forecast.js';
import { solarPosition } from '../js/solar.js';
import { computeUVA, MODEL } from '../js/uva.js';

test('parsePower reads POWER hourly JSON and drops fill values', () => {
  const rows = parsePower({
    header: { fill_value: -999 },
    properties: { parameter: { ALLSKY_SFC_UVA: { 2025060112: 41.2, 2025060100: 0, 2025060113: -999 } } },
  });
  assert.deepEqual(
    rows.map((r) => [r.time.toISOString(), r.uva]),
    [['2025-06-01T00:00:00.000Z', 0], ['2025-06-01T12:00:00.000Z', 41.2]]
  );
  assert.throws(() => parsePower({}), /ALLSKY_SFC_UVA/);
});

test('parseCsv takes time/uva in any column order, UTC by default', () => {
  const rows = parseCsv('uva,time,other\n12.5,2025-06-01T10:00,x\n13,2025-06-01T11:00+02:00,y\nbad,row\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].time.toISOString(), '2025-06-01T10:00:00.000Z');
  assert.equal(rows[1].time.toISOString(), '2025-06-01T09:00:00.000Z');
  assert.throws(() => parseCsv('a,b\n1,2'), /time/);
});

test('sampleTimes covers the right window', () => {
  const t = new Date('2025-06-01T12:00:00Z');
  const begin = sampleTimes(t, 'hour-beginning');
  assert.equal(begin.length, 6);
  assert.equal(begin[0].toISOString(), '2025-06-01T12:05:00.000Z');
  assert.equal(begin.at(-1).toISOString(), '2025-06-01T12:55:00.000Z');
  assert.equal(sampleTimes(t, 'hour-ending')[0].toISOString(), '2025-06-01T11:05:00.000Z');
  assert.deepEqual(sampleTimes(t, 'instant'), [t]);
});

test('haurwitzGhi is ~1035 W/m2 overhead and 0 at night', () => {
  assert.ok(Math.abs(haurwitzGhi(0) - 1035.1) < 0.5);
  assert.equal(haurwitzGhi(95), 0);
});

test('metrics: bias, RMSE and correlation', () => {
  const pairs = [1, 2, 3, 4].map((x) => ({ ref: x, m: 2 * x }));
  const m = metrics(pairs, 'm');
  assert.equal(m.n, 4);
  assert.equal(m.bias, 2.5);
  assert.equal(m.biasPct, 100);
  assert.ok(Math.abs(m.r - 1) < 1e-12);
  assert.deepEqual(metrics([], 'm'), { n: 0 });
});

// --- end to end with mocked APIs -------------------------------------------

const SITE = { name: 'Test', lat: 40.6, lon: 22.9 };
const START = '2025-06-01';
const END = '2025-06-03';

// Three days of hourly inputs with cloud that comes and goes.
function synthetic() {
  const time = [];
  const t0 = Date.parse(`${START}T00:00:00Z`);
  for (let i = 0; i < 72; i++) time.push(new Date(t0 + i * 3600000).toISOString().slice(0, 16));
  const ratio = time.map((_, i) => 0.35 + 0.6 * Math.abs(Math.sin(i / 3)));
  return {
    weather: {
      elevation: 30,
      hourly: {
        time,
        cloud_cover: ratio.map((r) => Math.round((1 - r) * 100)),
        surface_pressure: time.map(() => 1009),
        snow_depth: time.map(() => 0),
        shortwave_radiation_instant: time.map(() => null),
      },
    },
    air: {
      hourly: {
        time,
        uv_index: ratio.map((r) => 8 * r),
        uv_index_clear_sky: time.map(() => 8),
        aerosol_optical_depth: time.map(() => 0.2),
        ozone: time.map(() => 70),
      },
    },
  };
}

let realFetch;
let referenceExp = 1.0;
beforeEach(() => {
  realFetch = globalThis.fetch;
  const data = synthetic();
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    let body;
    if (u.host.startsWith('historical-forecast')) body = data.weather;
    else if (u.host.startsWith('air-quality')) body = data.air;
    else body = await powerFrom(data, referenceExp);
    return { ok: true, json: async () => body };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A POWER-shaped reference made from the model itself with a chosen cloud
// exponent, averaged over each hour like POWER's data.
async function powerFrom(data, exp) {
  const { mergeHourly } = await import('../js/api.js');
  const hours = withCloudTransmission(mergeHourly(data.weather.hourly, data.air.hourly));
  const series = {};
  for (const h of hours) {
    const vals = sampleTimes(h.time, 'hour-beginning').map((t) => {
      const atm = atmosphereAt(hours, t);
      if (!atm) return NaN;
      const sun = solarPosition(t, SITE.lat, SITE.lon);
      return computeUVA(
        {
          zenith: sun.zenith, aboveHorizon: sun.aboveHorizon, pressureHpa: atm.pressure,
          distanceAU: sun.distanceAU, aod: atm.aod, cloudCover: atm.cloudCover,
          uvCloudTransmission: atm.uvCloud, surface: 'grass',
        },
        { ...MODEL, CLOUD_UVA_EXP: exp }
      ).uva;
    });
    const ok = vals.filter(isFinite);
    const key = h.time.toISOString().slice(0, 13).replace(/[-T]/g, '');
    series[key] = ok.length === vals.length ? ok.reduce((a, b) => a + b, 0) / ok.length : -999;
  }
  return { header: { fill_value: -999 }, properties: { parameter: { ALLSKY_SFC_UVA: series } } };
}

test('replaying the model against itself gives zero bias', async () => {
  referenceExp = 1.0;
  const inputs = await fetchInputs(SITE, START, END);
  const ref = await fetchPower(SITE, START, END);
  const pairs = pairUp(ref, inputs.hours, { ...SITE, elevationM: inputs.elevationM }, 'hour-beginning');
  assert.ok(pairs.length > 20, `${pairs.length} pairs`);
  const rep = report(pairs);
  assert.ok(Math.abs(rep.all.biasPct) < 0.5, `bias ${rep.all.biasPct}%`);
  assert.equal(rep.camsFit[0].exp, 1.0);
  assert.match(formatReport('Test', rep), /\| all daytime \|/);
});

test('the fit recovers a different cloud exponent', async () => {
  referenceExp = 1.3;
  const inputs = await fetchInputs(SITE, START, END);
  const ref = await fetchPower(SITE, START, END);
  const rep = report(pairUp(ref, inputs.hours, { ...SITE, elevationM: inputs.elevationM }, 'hour-beginning'));
  assert.equal(rep.camsFit[0].exp, 1.3);
  assert.ok(rep.all.bias > 0, 'exponent 1.0 over-predicts a cloudier truth');
});
