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
> reaches roughly **66 W/m²** for an overhead sun. No common free API exposes
> pure UVA, so this app **derives** it from solar geometry plus live atmospheric
> data.

## How it works (hybrid model)

1. **Solar zenith angle** is computed in-browser from latitude/longitude and the
   chosen instant (NOAA solar position algorithm — `js/solar.js`).
2. A **clear-sky UVA baseline** is scaled by `cos(zenith)^k` from a ~66 W/m²
   overhead-sun maximum (`js/uva.js`).
3. **Atmospheric corrections** are applied from live, free
   [Open-Meteo](https://open-meteo.com/) data:
   - **Altitude** — UVA rises ~6% per km.
   - **Aerosol optical depth** — Beer–Lambert attenuation with air mass.
   - **Cloud cover** — empirical transmission factor.
   - **Surface albedo** — small enhancement for snow/sand.
   - Total-column ozone has only a weak effect on UVA and is omitted (Open-Meteo
     exposes surface ozone in µg/m³, not the Dobson Units the term needs); it is
     shown for information only.
4. The result is cross-checked against the API's UV Index, which should rise and
   fall together with UVA.

All tunable coefficients live in the `MODEL` block of `js/uva.js` so they can be
calibrated against reference data. The full method — every formula, coefficient
and the factors deliberately left out — is written up for end users at
`learn/how-uva-index-is-calculated.html`.

## Data sources (all free, no API key)

| Need | Source |
|------|--------|
| Place search / coordinates | Open-Meteo Geocoding API |
| Cloud cover, surface pressure, elevation | Open-Meteo Forecast API |
| UV Index, aerosol optical depth, ozone, dust | Open-Meteo Air-Quality API |
| Auto location | Browser Geolocation API |

## Files

```
index.html     # UI: location controls, date/time, result + breakdown + chart
about.html     # About page: why a UVA Index, why it isn't official, how to use it
styles.css     # responsive dark styling (calculator + knowledge base)
js/solar.js    # solar zenith angle (NOAA algorithm), pure functions
js/uva.js      # hybrid UVA model + qualitative bands, pure functions
js/api.js      # Open-Meteo fetch helpers (point value + full-day hourly series)
js/chart.js    # inline SVG chart of the UVA Index through the day, pure functions
js/app.js      # orchestration: wire UI, fetch, compute, render
learn/         # Knowledge Base: GENERATED educational articles about UVA (see below)
content/       # Knowledge Base source content + site config (see below)
templates/     # HTML/JS templates used to generate learn/, sitemap.xml, sw.js
scripts/       # build_kb.py — the Knowledge Base generator
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

`learn/*.html`, `learn/index.html`, `learn/tags/*`, `sitemap.xml` and `sw.js`
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

The result view also plots the **UVA Index through the day**: the same model is
evaluated at every available hour using that hour's cloud and aerosol data, so
you can see when UVA peaks and how it tracks the sun. To regenerate `og-image.png`
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

## Sanity checks

- Clear midday sun → ~45–66 W/m², i.e. a UVA Index of ~7.5–11 ("High" to "Extreme").
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
