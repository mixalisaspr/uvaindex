// widget-config.js — the embeddable UVA Index widget's options: parsing them
// from the embed URL, building that URL back, and writing the copy-and-paste
// snippet a site owner puts on their page. Pure functions, shared by the
// widget itself (js/embed.js) and the builder page (js/widget.js).

export const SITE_URL = 'https://uvaindex.org';

// Layouts and the iframe size each one is designed for. The widget's own CSS
// keeps everything inside these heights at any width down to MIN_WIDTH, so the
// snippet can give the iframe a fixed height and a fluid width.
export const LAYOUTS = {
  card: { width: 340, height: 196 },
  badge: { width: 340, height: 64 },
};
export const MIN_WIDTH = 240;

export const THEMES = ['light', 'dark', 'auto'];
export const SURFACES = ['auto', 'grass', 'water', 'sand', 'snow'];

export const DEFAULTS = { layout: 'card', theme: 'light', surface: 'auto' };

const clampCoord = (v, limit) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

// Four decimals is ~10 m — plenty for weather data, and keeps URLs short.
const roundCoord = (v) => Math.round(v * 1e4) / 1e4;

// A place label is shown as text only, but keep it short and printable.
function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

// An IANA zone name we can actually use; anything else is dropped so the
// widget looks the zone up itself.
function cleanTimeZone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// Options from an embed URL's query string (or URLSearchParams). Unknown or
// malformed values fall back to the defaults; `lat`/`lon` are null when
// missing or out of range, which the widget reports instead of guessing.
export function parseWidgetParams(search) {
  const p = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  return {
    lat: clampCoord(p.get('lat'), 90),
    lon: clampCoord(p.get('lon'), 180),
    name: cleanName(p.get('name')),
    tz: cleanTimeZone(p.get('tz')),
    layout: pick(p.get('layout'), Object.keys(LAYOUTS), DEFAULTS.layout),
    theme: pick(p.get('theme'), THEMES, DEFAULTS.theme),
    surface: pick(p.get('surface'), SURFACES, DEFAULTS.surface),
  };
}

// Query string for a set of options, leaving out values that equal the
// defaults so the snippet stays tidy.
export function widgetQuery(opts) {
  const p = new URLSearchParams();
  p.set('lat', String(roundCoord(opts.lat)));
  p.set('lon', String(roundCoord(opts.lon)));
  const name = cleanName(opts.name);
  if (name) p.set('name', name);
  const tz = cleanTimeZone(opts.tz);
  if (tz) p.set('tz', tz);
  for (const key of ['layout', 'theme', 'surface']) {
    if (opts[key] && opts[key] !== DEFAULTS[key]) p.set(key, opts[key]);
  }
  return p.toString();
}

// The widget page itself (what the iframe loads).
export function embedUrl(opts, base = SITE_URL) {
  return `${base}/embed.html?${widgetQuery(opts)}`;
}

// The full calculator for the same place — where a click on the widget goes.
export function calculatorUrl(opts, base = SITE_URL) {
  const p = new URLSearchParams();
  p.set('lat', String(roundCoord(opts.lat)));
  p.set('lon', String(roundCoord(opts.lon)));
  const name = cleanName(opts.name);
  if (name) p.set('name', name);
  const tz = cleanTimeZone(opts.tz);
  if (tz) p.set('tz', tz);
  if (opts.surface && opts.surface !== DEFAULTS.surface) p.set('surface', opts.surface);
  return `${base}/?${p}`;
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// The HTML a site owner pastes into their page: the iframe plus a plain,
// visible credit line. The credit sits *outside* the iframe on purpose — a
// link inside an iframe belongs to the framed page, not to the host page, so
// this line is what tells readers (and search engines) where the data comes
// from. It is short, branded and points at the calculator for that place.
export function embedSnippet(opts, base = SITE_URL) {
  const size = LAYOUTS[opts.layout] || LAYOUTS[DEFAULTS.layout];
  const name = cleanName(opts.name);
  const title = name ? `UVA Index for ${name}` : 'UVA Index';
  const src = escapeHtml(embedUrl(opts, base));
  const href = escapeHtml(calculatorUrl(opts, base));
  const place = name ? ` for ${escapeHtml(name)}` : '';
  return [
    `<div class="uvaindex-widget" style="max-width:${size.width}px">`,
    `  <iframe src="${src}" title="${escapeHtml(title)}" width="${size.width}" height="${size.height}" loading="lazy" style="display:block;width:100%;height:${size.height}px;border:0;border-radius:12px"></iframe>`,
    `  <p style="margin:6px 0 0;font:12px/1.4 system-ui,sans-serif">Live <a href="${href}">UVA Index</a>${place} by uvaindex.org</p>`,
    `</div>`,
  ].join('\n');
}
