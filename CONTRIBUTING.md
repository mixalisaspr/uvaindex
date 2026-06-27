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
  very welcome.
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

## Pull request guidelines

1. Fork the repo and create a topic branch off `main`.
2. Keep changes focused — one logical change per PR.
3. Match the existing style: no dependencies, no frameworks, no build tooling.
4. If you change the model or its coefficients, explain the reasoning and cite
   any data sources.
5. Test in a browser before submitting (the
   [sanity checks](README.md#sanity-checks) in the README are a good start).
6. If you add or rename a page, remember to update `sitemap.xml` and the
   `SHELL` precache list in `sw.js` (bump the `CACHE` version).

## Code of conduct

Please be respectful and constructive. We want this to be a welcoming project
for contributors of every experience level.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
