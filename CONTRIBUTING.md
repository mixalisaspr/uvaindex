# Contributing to UVA Index

Thanks for your interest in improving **[uvaindex.org](https://uvaindex.org)**!
It's a small, dependency-free static site, so getting started is quick and
contributions of all sizes are welcome — from fixing a typo to refining the
physical model.

## Ways to contribute

- **Report a bug or suggest a feature** — open an
  [issue](https://github.com/mixalisaspr/uvaindex/issues) describing what you
  saw and what you expected.
- **Improve the model** — the UVA estimation lives in `js/uva.js`, with every
  tunable coefficient in the `MODEL` block. If you can calibrate it against
  reference data or measurements, please share your sources in the PR.
- **Improve the content** — the Knowledge Base under `learn/` explains UVA in
  plain English. Corrections and clarifications backed by reputable sources are
  very welcome. See [Adding a Knowledge Base article](#adding-a-knowledge-base-article) below.
- **Fix bugs, polish the UI, improve accessibility or SEO.**

## Development setup

There is no build step. Clone the repo and serve the files with any static
server:

```bash
git clone https://github.com/mixalisaspr/uvaindex.git
cd uvaindex
python3 -m http.server 8000
# then open http://localhost:8000
```

The JavaScript modules in `js/` are intentionally framework-free and use mostly
pure functions, so they're easy to read and test by hand. See the
[README](README.md) for a file-by-file overview and how the hybrid model works.

## Adding a Knowledge Base article

The Knowledge Base is generated from `content/learn/*.html` by
`scripts/build_kb.py` — a small, dependency-free (stdlib-only Python) script.
You author one structured content file; the script regenerates every
`learn/*.html` page, `learn/index.html`, `learn/tags/*`, `sitemap.xml` and
`sw.js` from it. `learn/*.html`, `sitemap.xml` and `sw.js` are generated
output — don't hand-edit them, your changes will be overwritten. The same
applies to the primary `<nav>` in `index.html` and `about.html`: it is
generated from `templates/_site_nav.tmpl.html` into the region marked by
`<!-- site-nav:start -->` / `<!-- site-nav:end -->`, so change the nav there
and re-run the script.

To add an article:

1. `cp content/learn/_template.html content/learn/<slug>.html`.
2. Fill in the JSON metadata block at the top (title, description, tags,
   etc.) and write the body HTML below it, using the same markup already used
   throughout the Knowledge Base (`<table class="data-table">`,
   `<div class="callout">`, internal links as `<a href="other-slug.html">`).
   Set `"draft": false` when it's ready to publish.
3. Run `python3 scripts/build_kb.py` and review the diff — it updates every
   generated file for you, including the sitemap and service-worker cache.
4. Commit both the `content/` file and the regenerated output together. CI
   (`.github/workflows/kb-build-check.yml`) fails the PR if they ever drift
   apart.

The script validates as it goes (duplicate slugs, broken internal links,
missing required fields, bad dates) and fails loudly with a full error list
rather than generating broken output.

## Pull request guidelines

1. Fork the repo and create a topic branch off `main`.
2. Keep changes focused — one logical change per PR.
3. Match the existing style: no dependencies, no frameworks, no build tooling
   for the *shipped* site. `scripts/build_kb.py` is the one exception — a
   stdlib-only authoring tool that generates static output, not a runtime
   dependency.
4. If you change the model or its coefficients, explain the reasoning and cite
   any data sources.
5. Test in a browser before submitting (the
   [sanity checks](README.md#sanity-checks) in the README are a good start).
6. If you add, remove or rename a Knowledge Base article, run
   `python3 scripts/build_kb.py` and commit the regenerated output alongside
   your `content/` change.

## Code of conduct

Please be respectful and constructive. We want this to be a welcoming project
for contributors of every experience level.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
