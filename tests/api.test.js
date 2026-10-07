import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHourly, mergeHourly, FORECAST_DAYS } from '../js/api.js';

// Open-Meteo timestamps carry no zone; they must be read as UTC even when the
// machine's local zone isn't UTC.
process.env.TZ = 'Australia/Sydney';

let realFetch;
let requested;
beforeEach(() => {
  realFetch = globalThis.fetch;
  requested = [];
  globalThis.fetch = async (url) => {
    requested.push(new URL(url));
    const isAir = url.includes('air-quality');
    const body = isAir
      ? {
          hourly: {
            time: ['2026-10-07T01:00', '2026-10-07T00:00'], // deliberately out of order
            uv_index: [4, 2],
            uv_index_clear_sky: [5, 4],
            aerosol_optical_depth: [0.2, 0.1],
            ozone: [70, 60],
          },
        }
      : {
          elevation: 58,
          hourly: {
            time: ['2026-10-07T00:00', '2026-10-07T01:00'],
            cloud_cover: [10, 20],
            surface_pressure: [1012, 1011],
            snow_depth: [0, 0.12],
          },
        };
    return { ok: true, json: async () => body };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('requests a UTC window wide enough for every local day', async () => {
  await fetchHourly(-33.87, 151.21);
  assert.equal(requested.length, 2);
  for (const u of requested) {
    assert.equal(u.searchParams.get('timezone'), 'UTC');
    assert.equal(u.searchParams.get('past_days'), '1');
    assert.equal(u.searchParams.get('forecast_days'), String(FORECAST_DAYS + 1));
    assert.equal(u.searchParams.get('latitude'), '-33.87');
  }
  const weather = requested.find((u) => !u.host.startsWith('air'));
  assert.deepEqual(weather.searchParams.get('hourly').split(','), ['cloud_cover', 'surface_pressure', 'snow_depth']);
});

test('merges both APIs by timestamp and parses times as UTC', async () => {
  const data = await fetchHourly(-33.87, 151.21);
  assert.equal(data.elevationM, 58);
  assert.equal(data.hours.length, 2);
  const [h0, h1] = data.hours;
  assert.equal(h0.time.toISOString(), '2026-10-07T00:00:00.000Z');
  assert.deepEqual(
    { cloudCover: h0.cloudCover, uvIndex: h0.uvIndex, aod: h0.aod },
    { cloudCover: 10, uvIndex: 2, aod: 0.1 }
  );
  assert.deepEqual(
    { cloudCover: h1.cloudCover, uvIndex: h1.uvIndex, aod: h1.aod, pressure: h1.pressure, snowDepth: h1.snowDepth },
    { cloudCover: 20, uvIndex: 4, aod: 0.2, pressure: 1011, snowDepth: 0.12 }
  );
});

test('a failed request rejects with the status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(fetchHourly(0, 0), /429/);
});

test('mergeHourly tolerates a missing block', () => {
  const hours = mergeHourly({ time: ['2026-10-07T00:00'], cloud_cover: [5] }, undefined);
  assert.equal(hours.length, 1);
  assert.equal(hours[0].uvIndex, undefined);
});
