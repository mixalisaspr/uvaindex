// widget.js — the "Get the widget" builder on widget.html: pick a place and a
// style, see the live widget, copy the snippet.

import { geocode } from './api.js';
import { embedSnippet, embedUrl, LAYOUTS, escapeHtml } from './widget-config.js';
import { pageLang, translator } from './i18n.js';

const $ = (id) => document.getElementById(id);
const LANG = pageLang();
const t = translator(LANG);

// Start with a sunny, recognisable example; the owner searches their own.
const state = {
  lat: 38.7223,
  lon: -9.1393,
  name: t('builderDefaultPlace'),
  tz: 'Europe/Lisbon',
  layout: 'card',
  theme: 'light',
  surface: 'auto',
  // The widget speaks the language of the page it was built on.
  lang: LANG,
};

// --- preview + code ---------------------------------------------------------

function update() {
  // The snippet always points at the live site; the preview loads the copy
  // served alongside this page, so it also works on a local checkout.
  $('embed-code').value = embedSnippet(state);
  const size = LAYOUTS[state.layout];
  const frame = $('preview-frame');
  const src = embedUrl(state, location.origin);
  if (frame.getAttribute('src') !== src) frame.src = src;
  frame.style.height = `${size.height}px`;
  frame.title = t('builderPreview', { name: state.name });
  $('preview').style.maxWidth = `${size.width}px`;
  $('preview-place').textContent = state.name;
  $('copy-status').textContent = '';
}

async function copyCode() {
  const code = $('embed-code').value;
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    // Older browsers / blocked clipboard: select it for a manual copy.
    $('embed-code').select();
    document.execCommand?.('copy');
  }
  $('copy-status').textContent = t('builderCopied');
}

// --- place search (same feel as the calculator's) ---------------------------

let results = [];
let active = -1;
let timer = null;

function label(r) {
  return [r.name, r.admin1, r.country].filter(Boolean).join(', ');
}

function hide() {
  results = [];
  active = -1;
  $('w-suggestions').hidden = true;
  $('w-suggestions').innerHTML = '';
  $('w-search').setAttribute('aria-expanded', 'false');
  $('w-search').removeAttribute('aria-activedescendant');
}

function show() {
  if (!results.length) return hide();
  active = -1;
  $('w-suggestions').innerHTML = results
    .map(
      (r, i) =>
        `<li class="suggestion" role="option" id="w-suggestion-${i}" aria-selected="false" data-i="${i}">` +
        `<span class="s-name">${escapeHtml(r.name)}</span>` +
        `<span class="s-meta">${escapeHtml([r.admin1, r.country].filter(Boolean).join(', '))}</span></li>`
    )
    .join('');
  $('w-suggestions').hidden = false;
  $('w-search').setAttribute('aria-expanded', 'true');
}

function choose(r) {
  if (!r) return;
  // A short label reads better in a small widget: "Byron Bay, Australia".
  Object.assign(state, {
    lat: r.latitude,
    lon: r.longitude,
    name: [r.name, r.country].filter(Boolean).join(', '),
    tz: r.timezone || null,
  });
  $('w-search').value = label(r);
  hide();
  update();
}

function onInput() {
  const q = $('w-search').value.trim();
  clearTimeout(timer);
  if (q.length < 2) return hide();
  timer = setTimeout(async () => {
    try {
      const found = await geocode(q, 8, LANG);
      if ($('w-search').value.trim() !== q) return;
      results = found;
      show();
    } catch {
      hide();
    }
  }, 220);
}

function move(delta) {
  if (!results.length) return;
  active = (active + delta + results.length) % results.length;
  $('w-suggestions')
    .querySelectorAll('.suggestion')
    .forEach((el, i) => {
      el.classList.toggle('active', i === active);
      el.setAttribute('aria-selected', String(i === active));
    });
  $('w-search').setAttribute('aria-activedescendant', `w-suggestion-${active}`);
}

async function onKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Escape') {
    hide();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (results.length) return choose(results[active >= 0 ? active : 0]);
    const q = $('w-search').value.trim();
    if (q) choose((await geocode(q, 1, LANG).catch(() => []))[0]);
  }
}

// --- wire up ----------------------------------------------------------------

function init() {
  $('w-search').addEventListener('input', onInput);
  $('w-search').addEventListener('keydown', onKeydown);
  $('w-search').addEventListener('blur', () => setTimeout(hide, 150));
  $('w-suggestions').addEventListener('mousedown', (e) => {
    const item = e.target.closest('.suggestion');
    if (item) choose(results[Number(item.dataset.i)]);
  });

  for (const key of ['layout', 'theme', 'surface']) {
    document.querySelectorAll(`[name="w-${key}"]`).forEach((el) =>
      el.addEventListener('change', () => {
        state[key] = el.value;
        update();
      })
    );
  }
  $('copy-code').addEventListener('click', copyCode);
  $('embed-code').addEventListener('focus', (e) => e.target.select());
  update();
}

document.addEventListener('DOMContentLoaded', init);
