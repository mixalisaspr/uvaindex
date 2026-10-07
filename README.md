# UVA Index

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live site](https://img.shields.io/badge/live-uvaindex.org-0f1724.svg)](https://uvaindex.org)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](#run-it)

A simple, dependency-free website that estimates **surface UVA irradiance**
(≈315–400 nm, in W/m²) for a location, date/time and live weather conditions.
It's **free, ad-free and open source** — live at
**[uvaindex.org](https://uvaindex.org)**.

> **UVA is not the UV Index.** Every mainstream weather API serves the
> *erythemally-weighted UV Index*, which is dominated by UVB (~83% UVB / ~17%
> UVA at solar noon). True UVA is the unweighted irradiance over ~315–400 nm and
> reaches roughly **64–66 W/m²** for an overhead sun. No common free API exposes
> pure UVA, so this app **derives** it from radiative-transfer physics plus live
> atmospheric data.

## How it works (hybrid model)

1. **Solar position** — zenith angle and Earth–Sun distance are computed
   in-browser from latitude/longitude and the instant (NOAA solar position
   algorithm — `js/solar.js`).
2. **Clear sky** comes from a **radiative-transfer lookup table**
   (`js/lut.js`): global horizontal UVA (315–400 nm) computed with the DISORT
   multiple-scattering solver for every combination of sun angle, aerosol
   optical depth and surface pressure, interpolated in the browser
   (`js/uva.js`). It accounts for Rayleigh scattering, ozone (300 DU),
   aerosol scattering/absorption and a spherical-Earth air mass from first
   principles — no hand-tuned curve. About 64.5 W/m² for an overhead sun in
   clean air at sea level.
3. **Live factors** from free [Open-Meteo](https://open-meteo.com/) data:
   - **Altitude** — surface pressure feeds the table (~+3%/km in clean air).
   - **Aerosol** — CAMS aerosol optical depth feeds the table.
   - **Surroundings** — reflection off the area around you via the table's
     spherical albedo, `1 / (1 − r·s)`; "Auto" switches to snow from the
     forecast snow depth.
   - **Earth–Sun distance** — `1 / r²`, ±3.3% over the year.
   - **Cloud** — the live UV Index ÷ clear-sky UV Index ratio (fallback: a
     cloud-cover curve).
4. The result is cross-checked against the API's UV Index, which should rise and
   fall together with UVA.

The remaining tunable coefficients live in the `MODEL` block of `js/uva.js`.
The full method — every formula, assumption and the factors deliberately left
out — is written up for end users at `learn/how-uva-index-is-calculated.html`.

### Regenerating the lookup table

`scripts/build_lut.py` builds `js/lut.js` (~2 minutes). It needs a few
dev-only Python packages; the website itself stays dependency-free:

```bash
pip install -r scripts/requirements-lut.txt
python3 scripts/build_lut.py --compare   # rebuild + cross-check vs NREL SPECTRL2
python3 scripts/build_kb.py              # then refresh the service-worker cache
```

The cross-check against SPECTRL2 (an independent, simpler spectral model)
agrees on the direct beam to within 1%; SPECTRL2's approximate diffuse sky
runs lower, as expected.

### Validating against reference data

`scripts/validate.mjs` replays archived Open-Meteo inputs for past dates
through the site's own model code and compares hour by hour with independent
UVA data — NASA POWER's satellite-derived `ALLSKY_SFC_UVA`, or a CSV of ground
measurements (`time,uva`) — reporting bias/RMSE by sun angle and cloudiness,
a clear-sky-only check of the table, and a fit of the cloud coefficients:

```bash
node scripts/validate.mjs --sites scripts/validation-sites.json \
     --start 2025-06-01 --end 2025-06-30
node scripts/validate.mjs --lat 52.1 --lon 5.18 --csv measured.csv \
     --window instant --start 2025-05-01 --end 2025-05-31
```

## Data sources (all free, no API key)

| Need | Source |
|------|--------|
| Place search / coordinates | Open-Meteo Geocoding API |
| Cloud cover, surface pressure, snow depth, elevation | Open-Meteo Forecast API |
| UV Index, aerosol optical depth, ozone | Open-Meteo Air-Quality API |
| Auto location | Browser Geolocation API |
| Place name for GPS coordinates | BigDataCloud reverse geocoding (client API) |

## Files

```
index.html     # UI: location controls, date/time, result + breakdown + chart
about.html     # About page: why a UVA Index, why it isn't official, how to use it
styles.css     # responsive dark styling (calculator + knowledge base)
js/solar.js    # solar zenith angle + Earth–Sun distance (NOAA algorithm), pure
js/uva.js      # hybrid UVA model + qualitative bands, pure functions
js/lut.js      # GENERATED clear-sky radiative-transfer table (scripts/build_lut.py)
js/tz.js       # IANA timezone helpers (local midnight, DST-length days), pure
js/api.js      # Open-Meteo fetch helpers (multi-day hourly window, merged)
js/forecast.js # model over time: "now", 15-min daily curves, peak + protection window
js/chart.js    # inline SVG chart of one local day of the UVA Index, pure functions
js/app.js      # orchestration: wire UI, fetch, compute, render
js/consent.js  # analytics consent banner (EU/EEA, UK, CH) + Google Analytics loader
tests/         # unit tests (node --test, no dependencies)
learn/         # Knowledge Base: GENERATED educational articles about UVA (see below)
content/       # Knowledge Base source content + site config (see below)
templates/     # HTML/JS templates used to generate learn/, sitemap.xml, sw.js
scripts/       # build_kb.py (Knowledge Base), build_lut.py (clear-sky table),
               # validate.mjs (model vs reference data)
favicon.svg    # site icon
og-image.svg   # source for the social share image
og-image.png   # 1200x630 Open Graph / Twitter card image (rasterized from the SVG)
robots.txt     # crawler directives + sitemap pointer
sitemap.xml    # GENERATED sitemap (calculator + knowledge-base pages) for search engines
```

## Knowledge Base

`learn/` is a static, dependency-free content section that explains UVA in
plain English and supports the calculator's premise. It reuses `styles.css` and
the root service worker (so the articles also work offline).

`learn/*.html`, `learn/index.html`, `learn/tags/*`, `sitemap.xml`, `sw.js` and
the primary `<nav>` inside `index.html` and `about.html`
are **generated** by `scripts/build_kb.py` (standard-library Python only, no
new dependency) from source content in `content/learn/*.html` — one file per
article, a small JSON metadata header followed by the article body. This
keeps the shipped site 100% static HTML/CSS/vanilla JS while removing the
manual, error-prone work of keeping the hub listing, sitemap and
service-worker cache in sync as articles are added:

```
content/site.json          # site-wide constants (URL, GA id, tag vocabulary, related-count, ...)
content/learn/_template.html # starting point for a new article
content/learn/<slug>.html    # one file per article: JSON meta header + body HTML
scripts/build_kb.py          # generator: content/ -> learn/, sitemap.xml, sw.js
```

The three pages carrying the primary navigation — `index.html`, `about.html`
and the generated Knowledge Base hub — share a single source for it,
`templates/_site_nav.tmpl.html`. In the two hand-maintained pages the nav sits
between `<!-- site-nav:start -->` and `<!-- site-nav:end -->` markers that the
generator rewrites; edit the template, not the pages.

Each article's metadata controls its `<head>` (title, description, OG/Twitter
tags), its `Article`/`TechArticle` and `BreadcrumbList` JSON-LD (and
`FAQPage` JSON-LD when `faq` entries are set), which tag pages it appears on
under `learn/tags/`, and its "Keep reading" related links — either
hand-pinned (`related_pins`) or auto-suggested by shared tags.

To add an article, see [Adding a Knowledge Base article](CONTRIBUTING.md#adding-a-knowledge-base-article)
in CONTRIBUTING.md. In short: copy `content/learn/_template.html`, fill it in,
run `python3 scripts/build_kb.py`, and commit the regenerated output —
`.github/workflows/kb-build-check.yml` fails CI if it ever drifts from what
`content/` would produce.

The result view also shows a **five-day UVA forecast** for the location's own
calendar days: the same model is evaluated every 15 minutes (exact sun
position, hourly cloud and aerosol data interpolated between hours), giving
each day's peak, the span when the UVA Index is Moderate (3) or higher, and a
chart of the selected day. To regenerate `og-image.png`
after editing the SVG: `npx sharp-cli -i og-image.svg -o og-image.png resize 1200 630`.

## Run it

It's a static site — no build step.

```bash
# from the repo root, any static server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly also works in most browsers; a local server
avoids any module/CORS quirks. Deployable as-is to GitHub Pages.

## Tests

The model, timezone, forecast, API and chart modules are pure functions with
unit tests under `tests/`, run by Node's built-in test runner (Node 22+, no
dependencies to install):

```bash
npm test
```

CI runs them on every pull request alongside the Knowledge Base build check.

## Sanity checks

- Clear midday sun → ~45–66 W/m², i.e. a UVA Index of ~7.5–11 ("High" to "Very High"/"Extreme").
- Night → 0 W/m².
- Heavy overcast → sharp drop.
- Higher altitude → higher UVA for the same sun angle.

## Contributing

Contributions are welcome — bug reports, model improvements, content fixes and
UI polish alike. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.
Found a problem? Open an
[issue](https://github.com/mixalisaspr/uvaindex/issues).

## License

Released under the [MIT License](LICENSE). You're free to use, modify and
redistribute it, including for commercial purposes, provided the copyright
notice and license text are retained.

## Disclaimer

Estimated/derived values for informational use only — not medical advice. UVA
has no official index; the qualitative bands here are pragmatic, not standard.
