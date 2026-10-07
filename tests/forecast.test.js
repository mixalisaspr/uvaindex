import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atmosphereAt,
  buildForecast,
  cloudTransmission,
  resolveSurface,
  summarizeDay,
  withCloudTransmission,
  STEP_MINUTES,
} from '../js/forecast.js';
import { zonedParts } from '../js/tz.js';
import { syntheticHours } from './helpers.js';

const SYDNEY = { lat: -33.87, lon: 151.21, timeZone: 'Australia/Sydney', surface: 'grass' };
const LA = { lat: 34.05, lon: -118.24, timeZone: 'America/Los_Angeles', surface: 'grass' };

function forecastAt(site, nowIso, hours) {
  return buildForecast(
    { elevationM: 0, hours: hours ?? syntheticHours('2026-10-06T00:00:00Z', 8) },
    { ...site, now: new Date(nowIso), dayCount: 5 }
  );
}

function localHour(date, tz) {
  const p = zonedParts(date, tz);
  return p.hour + p.minute / 60;
}

// Regression: the chart used to plot one *UTC* day, so at 08:00 in Sydney it
// showed yesterday afternoon + this morning and missed today's peak.
test('today is the location’s local day (Sydney morning)', () => {
  const f = forecastAt(SYDNEY, '2026-10-07T21:00:00Z'); // 08:00 AEDT, 8 Oct
  const today = f.days[0];
  assert.equal(today.start.toISOString(), '2026-10-07T13:00:00.000Z');
  assert.equal(today.points[0].time.getTime(), today.start.getTime());
  assert.equal(today.points.at(-1).time.getTime(), today.end.getTime());
  const peakHour = localHour(today.summary.peak.time, SYDNEY.timeZone);
  assert.ok(peakHour > 12 && peakHour < 13.5, `peak at local ${peakHour}`);
});

test('today is the location’s local day (Los Angeles evening)', () => {
  const f = forecastAt(LA, '2026-10-08T01:00:00Z'); // 18:00 PDT, 7 Oct
  const today = f.days[0];
  assert.equal(today.start.toISOString(), '2026-10-07T07:00:00.000Z');
  const peakHour = localHour(today.summary.peak.time, LA.timeZone);
  assert.ok(peakHour > 12 && peakHour < 13.5, `peak at local ${peakHour}`);
});

test('five consecutive days at 15-minute resolution', () => {
  const f = forecastAt(SYDNEY, '2026-10-07T21:00:00Z');
  assert.equal(f.days.length, 5);
  for (let i = 1; i < 5; i++) assert.equal(f.days[i].start.getTime(), f.days[i - 1].end.getTime());
  const day = f.days[1];
  assert.equal(day.points.length, (day.end - day.start) / (STEP_MINUTES * 60000) + 1);
});

test('"now" matches the curve at the same instant', () => {
  const f = forecastAt(SYDNEY, '2026-10-08T02:00:00Z'); // 13:00 AEDT
  const p = f.days[0].points.find((q) => q.time.getTime() === f.now.time.getTime());
  assert.ok(p);
  assert.ok(Math.abs(p.index - f.now.index) < 1e-9);
  assert.ok(f.now.index > 6, `midday October Sydney, clear sky: ${f.now.index}`);
});

test('days without data are dropped, partial cloud data still computes', () => {
  // Only three UTC days of data: later local days disappear.
  const short = forecastAt(SYDNEY, '2026-10-07T21:00:00Z', syntheticHours('2026-10-06T00:00:00Z', 3));
  assert.ok(short.days.length < 5);
  // Air-quality fields missing (beyond the CAMS horizon): cloud cover alone.
  const hours = syntheticHours('2026-10-06T00:00:00Z', 8, () => ({
    uvIndex: null, uvIndexClearSky: null, aod: null, cloudCover: 100,
  }));
  const f = forecastAt(SYDNEY, '2026-10-07T21:00:00Z', hours);
  assert.equal(f.days.length, 5);
  assert.ok(f.days[0].summary.peak.index > 0);
});

test('cloudTransmission is the live/clear-sky UV ratio, undefined when unreliable', () => {
  assert.equal(cloudTransmission(3, 6), 0.5);
  assert.equal(cloudTransmission(0, 0.05), undefined); // sun too low
  assert.equal(cloudTransmission(null, 5), undefined);
});

test('atmosphereAt interpolates, and falls back to the nearest sample', () => {
  const hours = withCloudTransmission([
    { time: new Date('2026-10-07T00:00:00Z'), cloudCover: 0, aod: 0.1, uvIndex: 2, uvIndexClearSky: 4 },
    { time: new Date('2026-10-07T01:00:00Z'), cloudCover: 100, aod: null, uvIndex: 4, uvIndexClearSky: 4 },
  ]);
  const mid = atmosphereAt(hours, new Date('2026-10-07T00:30:00Z'));
  assert.equal(mid.cloudCover, 50);
  assert.equal(mid.uvCloud, 0.75);
  assert.equal(atmosphereAt(hours, new Date('2026-10-07T00:15:00Z')).aod, 0.1);
  assert.equal(atmosphereAt(hours, new Date('2026-10-07T00:45:00Z')).aod, 0.1);
  assert.equal(atmosphereAt(hours, new Date('2026-10-07T02:00:00Z')), null);
});

const at = (h, index) => ({ time: new Date(Date.UTC(2026, 9, 7, h)), index });

test('summarizeDay: peak and the Moderate-or-higher window', () => {
  const s = summarizeDay([at(8, 0), at(10, 4), at(12, 8), at(14, 4), at(16, 0)]);
  assert.equal(s.peak.index, 8);
  assert.equal(s.peak.band.label, 'Very High');
  assert.equal(s.peak.time.toISOString(), '2026-10-07T12:00:00.000Z');
  // Crosses 3 at 3/4 of the way from 08:00 to 10:00, and back down symmetrically.
  assert.equal(s.protect.start.toISOString(), '2026-10-07T09:30:00.000Z');
  assert.equal(s.protect.end.toISOString(), '2026-10-07T14:30:00.000Z');
});

test('summarizeDay: a low day has no protection window', () => {
  const s = summarizeDay([at(8, 0), at(12, 2.5), at(16, 0)]);
  assert.equal(s.protect, null);
  assert.equal(s.peak.band.label, 'Low');
});

test('summarizeDay: a cloud dip reports the full span', () => {
  const s = summarizeDay([at(8, 0), at(10, 5), at(11, 2), at(12, 6), at(14, 0)]);
  assert.ok(s.protect.start < at(10, 0).time);
  assert.ok(s.protect.end > at(12, 0).time);
});

test('summarizeDay: empty input', () => {
  assert.deepEqual(summarizeDay([]), { peak: null, protect: null });
});

test('Auto surroundings switch to snow when the forecast has snow cover', () => {
  assert.equal(resolveSurface('auto', 0.2), 'snow');
  assert.equal(resolveSurface('auto', 0.01), 'grass');
  assert.equal(resolveSurface('auto', undefined), 'grass');
  assert.equal(resolveSurface('sand', 0.5), 'sand', 'an explicit choice wins');
  const hours = syntheticHours('2026-10-06T00:00:00Z', 8, () => ({ snowDepth: 0.3, pressure: 700 }));
  const f = forecastAt({ ...SYDNEY, surface: 'auto' }, '2026-10-08T02:00:00Z', hours);
  assert.equal(f.now.surface, 'snow');
  assert.equal(f.now.pressureHpa, 700);
});
