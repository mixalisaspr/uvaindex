import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartSvg } from '../js/chart.js';
import { buildForecast } from '../js/forecast.js';
import { syntheticHours } from './helpers.js';

const tz = 'Australia/Sydney';
const now = new Date('2026-10-07T21:00:00Z'); // 08:00 AEDT
const { days } = buildForecast(
  { elevationM: 0, hours: syntheticHours('2026-10-06T00:00:00Z', 8) },
  { lat: -33.87, lon: 151.21, surface: 'grass', timeZone: tz, now, dayCount: 2 }
);

test('draws at the given pixel width with local-time hour labels', () => {
  const svg = chartSvg({ day: days[0], timeZone: tz, width: 340, now, label: 'x' });
  assert.match(svg, /^<svg viewBox="0 0 340 220" width="340"/);
  for (const h of ['06:00', '12:00', '18:00']) assert.ok(svg.includes(`>${h}<`), h);
  assert.ok(!svg.includes('>03:00<'), 'narrow charts label every 6 h');
  assert.match(svg, /AEDT|GMT\+11/);
});

test('wide charts label every 3 hours', () => {
  const svg = chartSvg({ day: days[0], timeZone: tz, width: 700 });
  assert.ok(svg.includes('>03:00<'));
});

test('marks "now" only on the day that contains it', () => {
  assert.match(chartSvg({ day: days[0], timeZone: tz, width: 400, now }), /class="marker"/);
  assert.doesNotMatch(chartSvg({ day: days[1], timeZone: tz, width: 400, now }), /class="marker"/);
});

test('escapes the accessible label', () => {
  const svg = chartSvg({ day: days[0], timeZone: tz, width: 400, label: 'a "b" <c>' });
  assert.ok(svg.includes('aria-label="a &quot;b&quot; &lt;c&gt;"'));
});

test('too little data renders a message instead of a chart', () => {
  const html = chartSvg({ day: { ...days[0], points: [] }, timeZone: tz, width: 400 });
  assert.match(html, /chart-empty/);
});
