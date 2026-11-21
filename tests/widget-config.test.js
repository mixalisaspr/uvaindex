import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWidgetParams,
  widgetQuery,
  embedUrl,
  calculatorUrl,
  embedSnippet,
  LAYOUTS,
  DEFAULTS,
} from '../js/widget-config.js';

const lisbon = { lat: 38.72231, lon: -9.13934, name: 'Lisbon, Portugal', tz: 'Europe/Lisbon' };

test('parseWidgetParams reads a full embed URL', () => {
  const o = parseWidgetParams('?lat=38.7223&lon=-9.1393&name=Lisbon&tz=Europe%2FLisbon&layout=badge&theme=dark&surface=sand');
  assert.deepEqual(o, {
    lat: 38.7223,
    lon: -9.1393,
    name: 'Lisbon',
    tz: 'Europe/Lisbon',
    layout: 'badge',
    theme: 'dark',
    surface: 'sand',
  });
});

test('parseWidgetParams: missing or bad coordinates are null, not 0', () => {
  for (const q of ['', '?lat=&lon=', '?lat=abc&lon=1', '?lat=91&lon=0', '?lat=0&lon=181']) {
    const o = parseWidgetParams(q);
    assert.ok(o.lat === null || o.lon === null, q);
  }
  // 0, 0 is a real place and must survive.
  const o = parseWidgetParams('?lat=0&lon=0');
  assert.equal(o.lat, 0);
  assert.equal(o.lon, 0);
});

test('parseWidgetParams falls back to defaults for unknown options', () => {
  const o = parseWidgetParams('?lat=1&lon=2&layout=huge&theme=neon&surface=lava&tz=Not/AZone');
  assert.equal(o.layout, DEFAULTS.layout);
  assert.equal(o.theme, DEFAULTS.theme);
  assert.equal(o.surface, DEFAULTS.surface);
  assert.equal(o.tz, null);
});

test('parseWidgetParams strips control characters and caps the name', () => {
  const o = parseWidgetParams(`?lat=1&lon=2&name=${encodeURIComponent('A\u0000B\n' + 'x'.repeat(200))}`);
  assert.ok(!/[\u0000-\u001f]/.test(o.name));
  assert.ok(o.name.length <= 80);
});

test('widgetQuery round-trips through parseWidgetParams and omits defaults', () => {
  const q = widgetQuery({ ...lisbon, ...DEFAULTS });
  assert.ok(!q.includes('layout='));
  assert.ok(!q.includes('theme='));
  assert.ok(!q.includes('surface='));
  assert.ok(q.includes('lat=38.7223'), 'coordinates rounded to 4 decimals');
  const back = parseWidgetParams(q);
  assert.equal(back.name, lisbon.name);
  assert.equal(back.tz, lisbon.tz);

  const q2 = widgetQuery({ ...lisbon, layout: 'badge', theme: 'auto', surface: 'snow' });
  const back2 = parseWidgetParams(q2);
  assert.equal(back2.layout, 'badge');
  assert.equal(back2.theme, 'auto');
  assert.equal(back2.surface, 'snow');
});

test('embedUrl and calculatorUrl point at the site', () => {
  assert.match(embedUrl(lisbon), /^https:\/\/uvaindex\.org\/embed\.html\?lat=/);
  assert.match(embedUrl(lisbon, 'http://localhost:8000'), /^http:\/\/localhost:8000\/embed\.html\?/);
  const calc = new URL(calculatorUrl({ ...lisbon, surface: 'water', theme: 'dark' }));
  assert.equal(calc.pathname, '/');
  assert.equal(calc.searchParams.get('surface'), 'water');
  assert.equal(calc.searchParams.get('theme'), null, 'display-only options stay out');
});

test('embedSnippet: iframe sized for the layout plus a visible credit link outside it', () => {
  const html = embedSnippet({ ...lisbon, layout: 'badge', theme: 'light', surface: 'auto' });
  assert.ok(html.includes(`height="${LAYOUTS.badge.height}"`));
  assert.ok(html.includes('loading="lazy"'));
  assert.ok(html.includes('title="UVA Index for Lisbon, Portugal"'));
  const afterIframe = html.slice(html.indexOf('</iframe>'));
  assert.match(afterIframe, /<a href="https:\/\/uvaindex\.org\/\?lat=[^"]+">UVA Index<\/a>/);
  assert.ok(!/nofollow|display:\s*none/.test(html), 'credit must be a plain, visible link');
});

test('embedSnippet escapes the place name', () => {
  const html = embedSnippet({ lat: 1, lon: 2, name: '<b>"Tom & Jerry\'s"</b>', layout: 'card' });
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;'));
});
