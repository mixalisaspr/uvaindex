# UVA Calculator

A simple, dependency-free website that estimates **surface UVA irradiance**
(≈315–400 nm, in W/m²) for a location, date/time and live weather conditions.

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
learn/         # Knowledge Base: educational articles about UVA (see below)
favicon.svg    # site icon
og-image.svg   # source for the social share image
og-image.png   # 1200x630 Open Graph / Twitter card image (rasterized from the SVG)
robots.txt     # crawler directives + sitemap pointer
sitemap.xml    # sitemap (calculator + knowledge-base pages) for search engines
```

## Knowledge Base

`learn/` is a static, dependency-free content section that explains UVA in
plain English and supports the calculator's premise. It reuses `styles.css` and
the root service worker (so the articles also work offline), and every page is
listed in `sitemap.xml`.

```
learn/index.html                       # hub page linking the articles
learn/what-is-uva-radiation.html       # what UVA is and how it behaves
learn/uva-vs-uvb.html                  # side-by-side comparison of the two bands
learn/dangers-of-uva.html              # health effects + how to reduce exposure
learn/uv-index-vs-uva-index.html       # why the erythemal UV Index under-counts UVA
learn/how-uva-index-is-calculated.html # the model, parameters, formulas + omissions
```

The Knowledge Base is linked from the top nav and footer on the home page. To
add an article: create `learn/<slug>.html` (copy an existing one as a template),
link it from `learn/index.html`, then add it to `sitemap.xml` and the `SHELL`
precache list in `sw.js` (bump the `CACHE` version).

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

- Clear midday sun → ~45–66 W/m² ("Very High"/"Extreme").
- Night → 0 W/m².
- Heavy overcast → sharp drop.
- Higher altitude → higher UVA for the same sun angle.

## Disclaimer

Estimated/derived values for informational use only — not medical advice. UVA
has no official index; the qualitative bands here are pragmatic, not standard.
