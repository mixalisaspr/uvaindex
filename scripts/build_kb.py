#!/usr/bin/env python3
"""Generate the Knowledge Base (learn/*.html and <lang>/learn/*.html), the
generated regions of the hand-written pages, sitemap.xml and sw.js from
content/ + templates/.

Usage:
  python3 scripts/build_kb.py            # regenerate and write files
  python3 scripts/build_kb.py --check    # regenerate in-memory, diff against
                                          # what's committed, exit 1 on drift
  python3 scripts/build_kb.py --partial  # while translations are in progress:
                                          # report translation problems as
                                          # warnings instead of errors

Content files are plain HTML with a leading JSON metadata block:

  <!--meta
  { "slug": "...", "title": "...", ... }
  -->
  <h1>...</h1>
  ...

English articles live in content/learn/<slug>.html. A translation lives in
content/learn/<lang>/<slug>.html and carries only the translatable metadata
(title, description, FAQ...) plus the translated body; everything structural
(dates, tags, order, related links) comes from the English article, so the
languages cannot drift apart. scripts/i18n_check.py verifies that each
translation keeps the English article's links, citations and markup, and the
build refuses translations that do not.

Languages are listed in content/site.json ("languages"); each has its
interface strings in content/i18n/<lang>.json. English is served from the site
root, every other language from /<lang>/ with the same file names.

No third-party dependencies — standard library only, to match this repo's
"no dependencies, no frameworks" policy for the shipped site. Only the
*authoring* step gains tooling; the generated pages, sitemap.xml and sw.js
remain plain static files served as-is.
"""
from __future__ import annotations

import difflib
import hashlib
import html.parser
import json
import posixpath
import re
import sys
from datetime import date
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "content"
LEARN_CONTENT_DIR = CONTENT_DIR / "learn"
I18N_DIR = CONTENT_DIR / "i18n"
TEMPLATES_DIR = ROOT / "templates"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import i18n_check  # noqa: E402  (sibling script: translation parity checks)

META_RE = re.compile(r"\A<!--meta\s*\n(?P<json>.*?)\n-->\s*\n?", re.DOTALL)

REQUIRED_FIELDS = ["slug", "title", "headline", "description", "date_published"]
VALID_SCHEMA_TYPES = {"Article", "TechArticle"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Inline citation marker used in article bodies: [[cite:id]] or [[cite:a,b]].
# Ids refer to entries in content/sources.json.
CITE_RE = re.compile(r"\[\[cite:([a-z0-9_,\- ]+)\]\]")
ISSUES_URL = "https://github.com/mixalisaspr/uvaindex/issues"

# The hand-written pages every language has, and which nav link they light up.
SHELL_PAGES = (("index.html", "calc"), ("about.html", "about"), ("widget.html", "widget"))
SHELL_KEY_LOC = {"calc": "/", "about": "/about.html", "widget": "/widget.html"}


class BuildError(Exception):
    pass


def esc(text: str) -> str:
    """Escape text for use inside a double-quoted HTML attribute / text node,
    without touching apostrophes (keeps generated markup close to the
    hand-written style already used across learn/*.html)."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def fill(template: str, **values) -> str:
    """Substitute {name} placeholders in a translated string."""
    return re.sub(r"\{(\w+)\}", lambda m: str(values.get(m.group(1), m.group(0))), template)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_template(name: str) -> Template:
    return Template((TEMPLATES_DIR / name).read_text(encoding="utf-8"))


def parse_content_file(path: Path):
    text = path.read_text(encoding="utf-8")
    m = META_RE.match(text)
    if not m:
        raise BuildError(f"{path.relative_to(ROOT)}: missing leading <!--meta ...--> block")
    try:
        meta = json.loads(m.group("json"))
    except json.JSONDecodeError as e:
        raise BuildError(f"{path.relative_to(ROOT)}: invalid JSON in meta block: {e}")
    body = text[m.end():].rstrip("\n") + "\n"
    return meta, body


class LinkExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value:
                    self.hrefs.append(value)


def extract_hrefs(body_html: str) -> list[str]:
    parser = LinkExtractor()
    parser.feed(body_html)
    return parser.hrefs


# --- languages ----------------------------------------------------------------

LANG_REQUIRED = [
    "code", "path", "html_lang", "hreflang", "native_name", "nav", "crumbs", "hub",
    "tag_page", "tags_index", "card_more", "related_heading", "sources_heading",
    "source_aria", "reviewed_html", "months", "date_format", "disclaimer_html",
    "cookie_settings", "default_cta_text", "tags",
]


def load_languages(site: dict, errors: list[str]) -> dict[str, dict]:
    """Interface strings per language, in the order site.json lists them
    (English first)."""
    langs: dict[str, dict] = {}
    codes = site.get("languages", ["en"])
    if not codes or codes[0] != "en":
        errors.append("content/site.json: 'languages' must start with \"en\"")
    for code in codes:
        path = I18N_DIR / f"{code}.json"
        if not path.exists():
            errors.append(f"content/site.json: language '{code}' has no {path.relative_to(ROOT)}")
            continue
        S = load_json(path)
        for field in LANG_REQUIRED:
            if field not in S:
                errors.append(f"{path.relative_to(ROOT)}: missing '{field}'")
        if S.get("code") != code:
            errors.append(f"{path.relative_to(ROOT)}: 'code' must be '{code}'")
        expected_path = "" if code == "en" else f"{code}/"
        if S.get("path") != expected_path:
            errors.append(f"{path.relative_to(ROOT)}: 'path' must be '{expected_path}'")
        if len(S.get("months", [])) != 12:
            errors.append(f"{path.relative_to(ROOT)}: 'months' needs 12 entries")
        langs[code] = S
    if "en" in langs:
        for code, S in langs.items():
            missing = set(langs["en"].get("tags", {})) - set(S.get("tags", {}))
            if missing:
                errors.append(f"content/i18n/{code}.json: tags missing labels for {sorted(missing)}")
    return langs


# --- articles -----------------------------------------------------------------

def load_articles(errors: list[str]) -> list[dict]:
    articles = []
    seen_slugs: dict[str, Path] = {}
    for path in sorted(LEARN_CONTENT_DIR.glob("*.html")):
        if path.name.startswith("_"):
            continue
        try:
            meta, body = parse_content_file(path)
        except BuildError as e:
            errors.append(str(e))
            continue

        rel = path.relative_to(ROOT)
        for field in REQUIRED_FIELDS:
            if not meta.get(field):
                errors.append(f"{rel}: missing required field '{field}'")

        slug = meta.get("slug", path.stem)
        if slug != path.stem:
            errors.append(f"{rel}: slug '{slug}' does not match filename '{path.stem}'")
        if slug in seen_slugs:
            errors.append(f"{rel}: duplicate slug '{slug}' (also used by {seen_slugs[slug]})")
        else:
            seen_slugs[slug] = rel

        schema_type = meta.get("schema_type", "Article")
        if schema_type not in VALID_SCHEMA_TYPES:
            errors.append(f"{rel}: invalid schema_type '{schema_type}' (expected Article or TechArticle)")

        date_published = meta.get("date_published", "")
        date_modified = meta.get("date_modified", date_published)
        if date_published and not DATE_RE.match(date_published):
            errors.append(f"{rel}: date_published '{date_published}' is not YYYY-MM-DD")
        if date_modified and not DATE_RE.match(date_modified):
            errors.append(f"{rel}: date_modified '{date_modified}' is not YYYY-MM-DD")

        faq = meta.get("faq", [])
        for i, qa in enumerate(faq):
            if not qa.get("question") or not qa.get("answer"):
                errors.append(f"{rel}: faq[{i}] has an empty question or answer")

        articles.append({
            "slug": slug,
            "title": meta.get("title", ""),
            "headline": meta.get("headline", ""),
            "description": meta.get("description", ""),
            "author": meta.get("author", "uvaindex.org"),
            "schema_type": schema_type,
            "date_published": date_published,
            "date_modified": date_modified,
            "tags": meta.get("tags", []),
            "order": meta.get("order"),
            "og_image": meta.get("og_image"),
            "og_title": meta.get("og_title") or meta.get("title", ""),
            "og_description": meta.get("og_description") or meta.get("description", ""),
            "jsonld_description": meta.get("jsonld_description") or meta.get("description", ""),
            "faq": faq,
            "related_pins": meta.get("related_pins", []),
            "related_exclude": meta.get("related_exclude", []),
            "cta_text": meta.get("cta_text"),
            "cta_href": meta.get("cta_href"),
            "breadcrumb_label": meta.get("breadcrumb_label") or meta.get("headline", ""),
            "draft": bool(meta.get("draft", False)),
            "_path": rel,
            "_body": body,
        })
    return articles


def load_translations(code: str, english: list[dict], problems: list[str], warnings: list[str]) -> list[dict]:
    """The translated articles of one language: each one is its English
    article with the translated wording swapped in.

    A translation made from an older version of its English article (its
    translated_from is not the English date_modified) is still published
    while it matches the English structure, with a warning; once it no longer
    matches, it is held back and readers get the English article until it is
    updated. Editing an English article therefore never breaks the build.
    A translation that fails the checks against the version it claims to be
    from is an error."""
    folder = LEARN_CONTENT_DIR / code
    if not folder.exists():
        return []
    by_slug = {a["slug"]: a for a in english}
    out = []
    for path in sorted(folder.glob("*.html")):
        rel = path.relative_to(ROOT)
        en = by_slug.get(path.stem)
        if en is None:
            problems.append(f"{rel}: there is no English article '{path.stem}' to translate")
            continue
        if en["draft"]:
            continue
        found: list[str] = []
        stale: list[str] = []
        i18n_check.check_article(code, path.stem, found, stale)
        if stale:
            if found:
                warnings.append(f"{rel}: held back (English is shown) — the English article changed and the translation no longer matches it: {found[0]}")
                continue
            warnings.append(stale[0])
        elif found:
            problems += found
            continue  # not published until it matches its English source
        meta, body = parse_content_file(path)
        a = dict(en)
        a.update({
            "title": meta["title"],
            "headline": meta["headline"],
            "description": meta["description"],
            "og_title": meta.get("og_title") or meta["title"],
            "og_description": meta.get("og_description") or meta["description"],
            "jsonld_description": meta.get("jsonld_description") or meta["description"],
            "faq": meta.get("faq", []),
            "related_pins": meta.get("related_pins", en["related_pins"]),
            "cta_text": meta.get("cta_text"),
            "breadcrumb_label": meta.get("breadcrumb_label") or meta["headline"],
            "_path": rel,
            "_body": body,
        })
        out.append(a)
    return out


def validate_links(articles: list[dict], errors: list[str], lang: str = "en", fallback_slugs=frozenset()):
    """Internal links must point at a known page. For a translation,
    fallback_slugs are the English articles it may link to before they are
    translated (see link_untranslated)."""
    slugs = {a["slug"] for a in articles} | set(fallback_slugs)
    known_static = {"../", "../about.html", "../widget.html", "./", "#omitted"}
    for a in articles:
        for href in extract_hrefs(a["_body"]):
            if href.startswith(("http://", "https://", "mailto:", "#")):
                continue
            if href in known_static:
                continue
            m = re.match(r"^([a-z0-9-]+)\.html(#.*)?$", href)
            if m:
                if m.group(1) not in slugs:
                    errors.append(f"{a['_path']}: body links to unknown article '{href}'")
                continue
            errors.append(f"{a['_path']}: body has an unrecognized internal link '{href}'")


ARTICLE_LINK_RE = re.compile(r'<a href="([a-z0-9-]+)\.html(#[^"]*)?"')


def link_untranslated(body: str, have: set, english_slugs: set) -> str:
    """In a translated article (served from /<lang>/learn/), point links to
    articles that have no translation in that language at the English
    article, labelled as English."""
    def repl(m):
        slug = m.group(1)
        if slug in have or slug not in english_slugs:
            return m.group(0)
        return f'<a href="../../learn/{slug}.html{m.group(2) or ""}" hreflang="en"'
    return ARTICLE_LINK_RE.sub(repl, body)


def validate_pins(articles: list[dict], errors: list[str]):
    slugs = {a["slug"]: a for a in articles}
    for a in articles:
        for pin in a["related_pins"]:
            if isinstance(pin, dict) and pin.get("href"):
                continue  # raw external/static link pin, not a slug reference
            slug = pin if isinstance(pin, str) else pin.get("slug")
            if slug is None:
                errors.append(f"{a['_path']}: related_pins entry has neither 'slug' nor 'href'")
                continue
            if slug not in slugs:
                errors.append(f"{a['_path']}: related_pins references unknown slug '{slug}'")
            elif slugs[slug]["draft"]:
                errors.append(f"{a['_path']}: related_pins references draft article '{slug}'")
        for slug in a["related_exclude"]:
            if slug not in slugs:
                errors.append(f"{a['_path']}: related_exclude references unknown slug '{slug}'")


def compute_related(article: dict, all_articles: list[dict], site: dict) -> list[dict]:
    n = site.get("related_count", 3)
    by_slug = {a["slug"]: a for a in all_articles if not a["draft"]}
    exclude = set(article["related_exclude"]) | {article["slug"]}
    result: list[dict] = []
    used_slugs: set[str] = set()

    # Manual pins are an explicit editorial choice and are never truncated by
    # related_count — only the tag-based auto-fill below respects that cap.
    for pin in article["related_pins"]:
        if isinstance(pin, dict) and pin.get("href"):
            result.append({"href": pin["href"], "label": pin["label"]})
            continue
        slug = pin if isinstance(pin, str) else pin.get("slug")
        label_override = pin.get("label") if isinstance(pin, dict) else None
        if slug and slug in by_slug and slug not in exclude and slug not in used_slugs:
            used_slugs.add(slug)
            result.append({"href": f"{slug}.html", "label": label_override or by_slug[slug]["headline"]})

    remaining = [a for a in all_articles if not a["draft"] and a["slug"] not in exclude and a["slug"] not in used_slugs]

    def score(a):
        return len(set(a["tags"]) & set(article["tags"]))

    # Stable multi-key sort: slug asc, then date_published desc, then score desc (primary).
    remaining.sort(key=lambda a: a["slug"])
    remaining.sort(key=lambda a: a["date_published"], reverse=True)
    remaining.sort(key=lambda a: score(a), reverse=True)
    for a in remaining:
        if len(result) >= n:
            break
        if score(a) > 0:
            used_slugs.add(a["slug"])
            result.append({"href": f"{a['slug']}.html", "label": a["headline"]})

    return result


def hub_sort_key(article: dict):
    """Explicitly ordered articles (order set) come first, in ascending order —
    this preserves a hand-curated reading sequence (e.g. basics before
    methodology). Everything else follows, newest first, so new content added
    without an explicit order still surfaces near the top of that group."""
    if article["order"] is not None:
        return (0, article["order"], article["slug"])
    return (1, -date.fromisoformat(article["date_published"]).toordinal(), article["slug"])


def human_date(iso: str, S: dict) -> str:
    y, m, d = (int(x) for x in iso.split("-"))
    return fill(S["date_format"], d=d, month=S["months"][m - 1], y=y)


# --- citations ----------------------------------------------------------------

def load_sources(errors: list[str]) -> dict:
    path = CONTENT_DIR / "sources.json"
    if not path.exists():
        return {}
    sources = load_json(path)
    for sid, src in sources.items():
        if not re.match(r"^[a-z0-9_-]+$", sid):
            errors.append(f"content/sources.json: invalid source id '{sid}'")
        for field in ("title", "publisher"):
            if not src.get(field):
                errors.append(f"content/sources.json: '{sid}' is missing '{field}'")
        url = src.get("url", "")
        if url and not url.startswith("https://"):
            errors.append(f"content/sources.json: '{sid}' url must start with https://")
    return sources


def resolve_citations(articles: list[dict], sources: dict, errors: list[str], S: dict, *, check_unused: bool):
    """Number each article's [[cite:id]] markers in order of first appearance,
    replace them with superscript links, and record the ordered source list
    on the article as article['_sources']."""
    used = set()
    for a in articles:
        order: list[str] = []

        def repl(m, a=a, order=order):
            out = []
            for sid in (x.strip() for x in m.group(1).split(",")):
                if sid not in sources:
                    errors.append(f"{a['_path']}: cites unknown source '{sid}'")
                    continue
                if sid not in order:
                    order.append(sid)
                n = order.index(sid) + 1
                out.append(f'<a href="#src-{n}" aria-label="{esc(fill(S["source_aria"], n=n))}">[{n}]</a>')
            return f'<sup class="cite">{"".join(out)}</sup>' if out else ""

        a["_body"] = CITE_RE.sub(repl, a["_body"])
        a["_sources"] = [sources[sid] for sid in order if sid in sources]
        used.update(order)
    if check_unused:
        for sid in sources:
            if sid not in used:
                errors.append(f"content/sources.json: source '{sid}' is not cited by any article")


def format_source(src: dict) -> str:
    """One reference as HTML: Authors (Year). Title. Publisher."""
    lead = ""
    if src.get("authors"):
        lead = esc(src["authors"])
        if src.get("year"):
            lead += f" ({esc(src['year'])})"
        lead += ". "
    title = esc(src["title"])
    if src.get("url"):
        title = f'<a href="{esc(src["url"])}" rel="noopener">{title}</a>'
    tail = f"<em>{esc(src['publisher'])}</em>"
    if not src.get("authors") and src.get("year"):
        tail += f", {esc(src['year'])}"
    return f"{lead}{title}. {tail}."


def render_sources_block(article: dict, S: dict) -> str:
    """The numbered reference list plus the 'last reviewed' line, appended to
    the article body. References keep their original titles."""
    lines = []
    if article["_sources"]:
        lines.append('<section class="sources" id="sources">')
        lines.append(f"  <h2>{esc(S['sources_heading'])}</h2>")
        lines.append("  <ol>")
        for n, src in enumerate(article["_sources"], start=1):
            lines.append(f'    <li id="src-{n}">{format_source(src)}</li>')
        lines.append("  </ol>")
        lines.append("</section>")
    reviewed = fill(S["reviewed_html"], date=human_date(article["date_modified"], S), issues=ISSUES_URL)
    lines.append(f'<p class="reviewed">{reviewed}</p>')
    return "\n".join(lines)


# --- pages, paths and languages -------------------------------------------------
#
# A page is identified by a key that is the same in every language:
# ("calc",) ("about",) ("widget",) ("hub",) ("article", slug) ("tags",)
# ("tag", tag). page_path() turns it into a site-relative path for one
# language ("es/learn/uva-vs-uvb.html"); directory pages end in "/".

def page_path(S: dict, key: tuple) -> str:
    p = S["path"]
    kind = key[0]
    if kind == "calc":
        return p
    if kind == "about":
        return p + "about.html"
    if kind == "widget":
        return p + "widget.html"
    if kind == "hub":
        return p + "learn/"
    if kind == "article":
        return p + f"learn/{key[1]}.html"
    if kind == "tags":
        return p + "learn/tags/"
    if kind == "tag":
        return p + f"learn/tags/{key[1]}.html"
    raise BuildError(f"unknown page key {key}")


def output_file(path: str) -> Path:
    return ROOT / (path + "index.html" if path == "" or path.endswith("/") else path)


def rel_href(from_path: str, to_path: str) -> str:
    """Relative link from the page at from_path to the page at to_path."""
    from_dir = from_path if from_path == "" or from_path.endswith("/") else posixpath.dirname(from_path)
    base = from_dir.rstrip("/") or "."
    target = to_path.rstrip("/") or "."
    rel = posixpath.relpath(target, base)
    if to_path == "" or to_path.endswith("/"):
        return "./" if rel == "." else rel + "/"
    return rel


class Site:
    """Everything the renderers need: config, languages and which page exists
    in which language."""

    def __init__(self, site: dict, langs: dict[str, dict]):
        self.site = site
        self.url = site["site_url"].rstrip("/")
        self.langs = langs
        self.available: dict[str, set] = {code: set() for code in langs}

    def abs_url(self, code: str, key: tuple) -> str:
        return f"{self.url}/{page_path(self.langs[code], key)}"

    def has(self, code: str, key: tuple) -> bool:
        return key in self.available[code]

    def hreflang_lines(self, key: tuple, indent: str = "    ") -> str:
        lines = [
            f'{indent}<link rel="alternate" hreflang="{S["hreflang"]}" href="{esc(self.abs_url(code, key))}" />'
            for code, S in self.langs.items()
            if self.has(code, key)
        ]
        if self.has("en", key):
            lines.append(f'{indent}<link rel="alternate" hreflang="x-default" href="{esc(self.abs_url("en", key))}" />')
        return "\n".join(lines)

    def lang_switch(self, code: str, key: tuple) -> str:
        """The language menu: the same page in every language (or that
        language's Knowledge Base / home page when the page isn't translated)."""
        here = page_path(self.langs[code], key)
        item_tmpl = load_template("_lang_item.tmpl.html")
        items = []
        for other, S in self.langs.items():
            target = key
            if not self.has(other, target):
                target = ("hub",) if key[0] in ("article", "tag", "tags") and self.has(other, ("hub",)) else ("calc",)
            items.append(item_tmpl.substitute(
                HREF=esc(rel_href(here, page_path(S, target))),
                HREFLANG=S["hreflang"],
                HTML_LANG=S["html_lang"],
                CURRENT_ATTR=' aria-current="true"' if other == code else "",
                NAME=esc(S["native_name"]),
            ))
        S = self.langs[code]
        return load_template("_lang_switch.tmpl.html").substitute(
            LABEL=esc(S["nav"]["language"]),
            CURRENT=esc(S["native_name"]),
            ITEMS="\n".join(items),
        ).rstrip("\n")


def render_related_block(related: list[dict], S: dict) -> str:
    if not related:
        return ""
    item_tmpl = load_template("_related_item.tmpl.html")
    items = "\n          ".join(
        item_tmpl.substitute(HREF=esc(r["href"]), LABEL=esc(r["label"])) for r in related
    )
    aside_tmpl = load_template("_related_aside.tmpl.html")
    return "\n" + aside_tmpl.substitute(HEADING=esc(S["related_heading"]), ITEMS=items)


def render_jsonld_block(data: dict) -> str:
    body = json.dumps(data, indent=2, ensure_ascii=False)
    indented = "\n".join(("      " + line if line else line) for line in body.split("\n"))
    return f'    <script type="application/ld+json">\n{indented}\n    </script>'


def article_jsonld(article: dict, canonical: str, S: dict) -> dict:
    data = {
        "@context": "https://schema.org",
        "@type": article["schema_type"],
        "headline": article["headline"],
        "description": article["jsonld_description"],
        "inLanguage": S["html_lang"],
        "author": {"@type": "Organization", "name": article["author"]},
        "publisher": {"@type": "Organization", "name": article["author"]},
        "datePublished": article["date_published"],
        "dateModified": article["date_modified"],
        "mainEntityOfPage": canonical,
    }
    if article.get("_sources"):
        data["citation"] = [
            {k: v for k, v in (
                ("@type", "CreativeWork"),
                ("name", src["title"]),
                ("author", src.get("authors")),
                ("publisher", src["publisher"]),
                ("datePublished", src.get("year")),
                ("url", src.get("url")),
            ) if v}
            for src in article["_sources"]
        ]
    return data


def faq_jsonld(faq: list[dict]) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": qa["question"],
                "acceptedAnswer": {"@type": "Answer", "text": qa["answer"]},
            }
            for qa in faq
        ],
    }


def breadcrumb_jsonld(crumbs: list[tuple]) -> dict:
    """crumbs: list of (label, absolute_url)."""
    items = [
        {"@type": "ListItem", "position": i, "name": label, "item": url}
        for i, (label, url) in enumerate(crumbs, start=1)
    ]
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items}


def render_breadcrumb_nav(crumbs: list[tuple], S: dict, lang_switch: str) -> str:
    parts = []
    for label, href in crumbs[:-1]:
        parts.append(f'<a href="{esc(href)}">{esc(label)}</a><span class="sep">›</span>')
    parts.append(esc(crumbs[-1][0]))
    nav_tmpl = load_template("_breadcrumb.tmpl.html")
    return nav_tmpl.substitute(
        ARIA=esc(S["crumbs"]["aria"]), CRUMBS="".join(parts), LANG_SWITCH=lang_switch
    ).rstrip("\n")


def render_head(ctx: Site, code: str, key: tuple, *, title, description, author,
                og_type, og_title, og_description, og_image, jsonld_blocks) -> str:
    site = ctx.site
    S = ctx.langs[code]
    path = page_path(S, key)
    canonical = ctx.abs_url(code, key)
    head_tmpl = load_template("_head.tmpl.html")
    return head_tmpl.substitute(
        GA_ID=site["ga_id"],
        TITLE=esc(title),
        DESCRIPTION=esc(description),
        AUTHOR=esc(author),
        CANONICAL=esc(canonical),
        HREFLANG=ctx.hreflang_lines(key),
        ASSET_REL=rel_href(path, ""),
        SITE_NAME=esc(S["crumbs"]["home"]),
        OG_TYPE=og_type,
        OG_TITLE=esc(og_title),
        OG_DESCRIPTION=esc(og_description),
        OG_URL=esc(canonical),
        OG_IMAGE=esc(og_image or site["default_og_image"]),
        OG_IMAGE_WIDTH=site["og_image_width"],
        OG_IMAGE_HEIGHT=site["og_image_height"],
        JSONLD_BLOCKS="\n\n".join(jsonld_blocks),
    )


def page_common(ctx: Site, code: str, key: tuple) -> dict:
    """Template values every generated page shares."""
    S = ctx.langs[code]
    return {
        "HTML_LANG": S["html_lang"],
        "ASSET_REL": rel_href(page_path(S, key), ""),
        "DISCLAIMER": S["disclaimer_html"],
        "COOKIE_SETTINGS": esc(S["cookie_settings"]),
    }


def render_article(ctx: Site, code: str, article: dict, all_articles: list[dict]) -> str:
    S = ctx.langs[code]
    key = ("article", article["slug"])
    canonical = ctx.abs_url(code, key)
    crumbs = [(S["crumbs"]["home"], "../"), (S["crumbs"]["kb"], "./"), (article["breadcrumb_label"], None)]
    jsonld_crumbs = [
        (S["crumbs"]["home"], ctx.abs_url(code, ("calc",))),
        (S["crumbs"]["kb"], ctx.abs_url(code, ("hub",))),
        (article["breadcrumb_label"], canonical),
    ]

    jsonld = [render_jsonld_block(article_jsonld(article, canonical, S))]
    if article["faq"]:
        jsonld.append(render_jsonld_block(faq_jsonld(article["faq"])))
    jsonld.append(render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs)))

    head = render_head(
        ctx, code, key,
        title=article["title"],
        description=article["description"],
        author=article["author"],
        og_type="article",
        og_title=article["og_title"],
        og_description=article["og_description"],
        og_image=article["og_image"],
        jsonld_blocks=jsonld,
    )

    related = compute_related(article, all_articles, ctx.site)
    body_indented = "\n".join(
        ("        " + line if line else line)
        for line in (article["_body"].rstrip("\n") + "\n\n" + render_sources_block(article, S)).split("\n")
    )
    tmpl = load_template("article.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        BREADCRUMB_NAV=render_breadcrumb_nav(crumbs, S, ctx.lang_switch(code, key)),
        BODY=body_indented,
        CTA_HREF=esc(article["cta_href"] or ctx.site["default_cta_href"]),
        CTA_TEXT=esc(article["cta_text"] or S["default_cta_text"]),
        RELATED_BLOCK=render_related_block(related, S),
        **page_common(ctx, code, key),
    )


NAV_START = "      <!-- site-nav:start (generated by scripts/build_kb.py — do not edit) -->\n"
NAV_END = "      <!-- site-nav:end -->\n"
NAV_RE = re.compile(re.escape(NAV_START) + r".*?" + re.escape(NAV_END), re.DOTALL)

HREFLANG_START = "    <!-- hreflang:start (generated by scripts/build_kb.py — do not edit) -->\n"
HREFLANG_END = "    <!-- hreflang:end -->\n"
HREFLANG_RE = re.compile(re.escape(HREFLANG_START) + r".*?" + re.escape(HREFLANG_END), re.DOTALL)


# The pages carrying the primary nav (index.html, about.html, widget.html and the
# generated Knowledge Base hub, in every language) used to keep hand-copied
# versions of it, which is how they drifted apart. The nav now has exactly one
# source — templates/_site_nav.tmpl.html — rendered per page from here.
def render_site_nav(ctx: Site, code: str, key: tuple, active: str) -> str:
    """active: which link is the current page ('calc', 'learn', 'widget' or 'about')."""
    if active not in {"calc", "learn", "widget", "about"}:
        raise BuildError(f"render_site_nav: unknown active page '{active}'")
    S = ctx.langs[code]
    nav = S["nav"]
    tmpl = load_template("_site_nav.tmpl.html")
    return tmpl.substitute(
        REL=rel_href(page_path(S, key), S["path"]),
        NAV_ARIA=esc(nav["aria"]),
        NAV_CALC=esc(nav["calc"]),
        NAV_LEARN=esc(nav["learn"]),
        NAV_WIDGET=esc(nav["widget"]),
        NAV_ABOUT=esc(nav["about"]),
        CALC_ACTIVE=' class="active"' if active == "calc" else "",
        LEARN_ACTIVE=' class="active"' if active == "learn" else "",
        WIDGET_ACTIVE=' class="active"' if active == "widget" else "",
        ABOUT_ACTIVE=' class="active"' if active == "about" else "",
        LANG_SWITCH=ctx.lang_switch(code, key),
    ).rstrip("\n")


def patch_shell_page(ctx: Site, code: str, key: tuple, active: str, errors: list[str]) -> str | None:
    """Return a hand-written page's content with its marked nav and hreflang
    regions regenerated."""
    path = output_file(page_path(ctx.langs[code], key))
    rel = path.relative_to(ROOT)
    text = path.read_text(encoding="utf-8")
    if not NAV_RE.search(text):
        errors.append(f"{rel}: missing the site-nav:start/site-nav:end markers that scripts/build_kb.py needs")
        return None
    if not HREFLANG_RE.search(text):
        errors.append(f"{rel}: missing the hreflang:start/hreflang:end markers that scripts/build_kb.py needs")
        return None
    nav = NAV_START + "      " + render_site_nav(ctx, code, key, active) + "\n" + NAV_END
    links = HREFLANG_START + ctx.hreflang_lines(key) + "\n" + HREFLANG_END
    text = NAV_RE.sub(lambda _m: nav, text, count=1)
    return HREFLANG_RE.sub(lambda _m: links, text, count=1)


def card(href: str, title: str, excerpt: str, S: dict) -> str:
    return load_template("_kb_card.tmpl.html").substitute(
        HREF=href, TITLE=esc(title), EXCERPT=esc(excerpt), MORE=esc(S["card_more"])
    )


def render_hub(ctx: Site, code: str, articles: list[dict]) -> str:
    S = ctx.langs[code]
    H = S["hub"]
    key = ("hub",)
    canonical = ctx.abs_url(code, key)
    live_sorted = sorted((a for a in articles if not a["draft"]), key=hub_sort_key)
    cards = "\n".join(card(f"{a['slug']}.html", a["headline"], a["description"], S) for a in live_sorted)

    collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": H["collection_name"],
        "url": canonical,
        "inLanguage": S["html_lang"],
        "description": H["collection_description"],
        "hasPart": [
            {"@type": a["schema_type"], "name": a["headline"], "url": ctx.abs_url(code, ("article", a["slug"]))}
            for a in live_sorted
        ],
    }

    head = render_head(
        ctx, code, key,
        title=H["title"],
        description=H["description"],
        author=ctx.site["org_name"],
        og_type="website",
        og_title=H["og_title"],
        og_description=H["og_description"],
        og_image=None,
        jsonld_blocks=[render_jsonld_block(collection)],
    )

    tmpl = load_template("hub.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        SITE_NAV=render_site_nav(ctx, code, key, "learn"),
        H1=esc(H["h1"]),
        SUBTITLE=H["subtitle_html"],
        CARDS=cards,
        CTA=esc(H["cta"]),
        OPEN_SOURCE=H["open_source_html"],
        **page_common(ctx, code, key),
    )


def render_tag_page(ctx: Site, code: str, tag: str, tag_label: str, articles: list[dict]) -> str:
    S = ctx.langs[code]
    T = S["tag_page"]
    key = ("tag", tag)
    canonical = ctx.abs_url(code, key)
    crumbs = [(S["crumbs"]["home"], "../../"), (S["crumbs"]["kb"], "../"), (S["crumbs"]["topics"], "./"), (tag_label, None)]
    jsonld_crumbs = [
        (S["crumbs"]["home"], ctx.abs_url(code, ("calc",))),
        (S["crumbs"]["kb"], ctx.abs_url(code, ("hub",))),
        (S["crumbs"]["topics"], ctx.abs_url(code, ("tags",))),
        (tag_label, canonical),
    ]

    live_sorted = sorted(articles, key=hub_sort_key)
    cards = "\n".join(card(f"../{a['slug']}.html", a["headline"], a["description"], S) for a in live_sorted)

    title = fill(T["title"], label=tag_label)
    description = fill(T["description"], label=tag_label, label_lower=tag_label.lower())
    head = render_head(
        ctx, code, key,
        title=title,
        description=description,
        author=ctx.site["org_name"],
        og_type="website",
        og_title=title,
        og_description=description,
        og_image=None,
        jsonld_blocks=[render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs))],
    )

    tmpl = load_template("tag.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        BREADCRUMB_NAV=render_breadcrumb_nav(crumbs, S, ctx.lang_switch(code, key)),
        TAG_LABEL=esc(tag_label),
        SUBTITLE=fill(T["subtitle_html"], label=esc(tag_label)),
        CTA=esc(T["cta"]),
        CARDS=cards,
        **page_common(ctx, code, key),
    )


def render_tags_index(ctx: Site, code: str, tag_counts: list[tuple]) -> str:
    S = ctx.langs[code]
    T = S["tags_index"]
    key = ("tags",)
    canonical = ctx.abs_url(code, key)
    crumbs = [(S["crumbs"]["home"], "../../"), (S["crumbs"]["kb"], "../"), (S["crumbs"]["topics"], None)]
    jsonld_crumbs = [
        (S["crumbs"]["home"], ctx.abs_url(code, ("calc",))),
        (S["crumbs"]["kb"], ctx.abs_url(code, ("hub",))),
        (S["crumbs"]["topics"], canonical),
    ]

    cards = "\n".join(
        card(f"{tag}.html", label, fill(T["count_one" if count == 1 else "count_other"], n=count), S)
        for tag, label, count in tag_counts
    )

    head = render_head(
        ctx, code, key,
        title=T["title"],
        description=T["description"],
        author=ctx.site["org_name"],
        og_type="website",
        og_title=T["title"],
        og_description=T["description"],
        og_image=None,
        jsonld_blocks=[render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs))],
    )

    tmpl = load_template("tags_index.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        BREADCRUMB_NAV=render_breadcrumb_nav(crumbs, S, ctx.lang_switch(code, key)),
        H1=esc(T["h1"]),
        SUBTITLE=esc(T["subtitle"]),
        CARDS=cards,
        **page_common(ctx, code, key),
    )


# --- sitemap + service worker -------------------------------------------------------

def render_sitemap(ctx: Site, pages: list[tuple]) -> str:
    """pages: (code, key, lastmod, changefreq, priority) for every published
    page. Each URL lists its translations as xhtml:link alternates."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
        ' xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]
    for code, key, lastmod, changefreq, priority in pages:
        lines.append("  <url>")
        lines.append(f"    <loc>{esc(ctx.abs_url(code, key))}</loc>")
        lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <changefreq>{changefreq}</changefreq>")
        lines.append(f"    <priority>{priority}</priority>")
        alternates = [(c, S) for c, S in ctx.langs.items() if ctx.has(c, key)]
        if len(alternates) > 1:
            for c, S in alternates:
                lines.append(f'    <xhtml:link rel="alternate" hreflang="{S["hreflang"]}" href="{esc(ctx.abs_url(c, key))}" />')
            lines.append(f'    <xhtml:link rel="alternate" hreflang="x-default" href="{esc(ctx.abs_url("en", key))}" />')
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def compute_shell(ctx: Site, english: list[dict], tag_counts: list[tuple]) -> list[str]:
    """What the service worker precaches: the app (every language's three
    hand-written pages) plus the English Knowledge Base. Translated articles
    are fetched from the network when visited, which keeps the first install
    small."""
    site = ctx.site
    shell = list(site["sw_shell_prefix"])
    for code, S in ctx.langs.items():
        if code == "en":
            continue
        if ctx.has(code, ("calc",)):
            shell += [f"./{S['path']}", f"./{S['path']}index.html"]
        for name, key in (("about.html", ("about",)), ("widget.html", ("widget",))):
            if ctx.has(code, key):
                shell.append(f"./{S['path']}{name}")
    shell += ["./learn/", "./learn/index.html"]
    for a in sorted((a for a in english if not a["draft"]), key=lambda a: a["slug"]):
        shell.append(f"./learn/{a['slug']}.html")
    if site.get("tag_pages_enabled") and tag_counts:
        shell.append("./learn/tags/")
        shell.append("./learn/tags/index.html")
        for tag, _label, _count in sorted(tag_counts):
            shell.append(f"./learn/tags/{tag}.html")
    return shell


def shell_content_hash(shell: list[str], rendered: dict[Path, str]) -> str:
    """Hash the shell's paths AND the bytes behind them.

    Any edit to a cached file (app JS, CSS, a regenerated article...) changes
    the cache name, so returning visitors' service workers fetch the new shell
    instead of serving stale files. Generated files are hashed as they are
    about to be written; everything else is read from disk.
    """
    h = hashlib.sha256()
    for shell_path in shell:
        h.update(shell_path.encode("utf-8") + b"\0")
        if shell_path.endswith("/"):
            continue  # directory entries are served by their index.html
        path = ROOT / shell_path[2:]
        if path in rendered:
            h.update(rendered[path].encode("utf-8"))
        elif path.exists():
            h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:10]


def render_sw(shell: list[str], ctx: Site, rendered: dict[Path, str]) -> str:
    cache_hash = shell_content_hash(shell, rendered)
    cache = f"uvaindex-shell-{cache_hash}"
    shell_json = json.dumps(shell, indent=2)
    # re-indent the JS array literal to match the template's 2-space body
    shell_json = "\n".join(("  " + line if i else line) for i, line in enumerate(shell_json.split("\n")))
    langs = json.dumps([S["path"].rstrip("/") for c, S in ctx.langs.items() if c != "en"])

    tmpl = load_template("sw.tmpl.js")
    return tmpl.substitute(CACHE=cache, SHELL_JSON=shell_json, LANG_DIRS=langs)


def write_if_changed(path: Path, content: str, results: dict):
    existing = path.read_text(encoding="utf-8") if path.exists() else None
    if existing == content:
        results["unchanged"].append(path)
    else:
        results["changed"].append(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


# --- build ----------------------------------------------------------------------

def report(errors: list[str]) -> int:
    print(f"Found {len(errors)} error(s):", file=sys.stderr)
    for e in errors:
        print(f"  - {e}", file=sys.stderr)
    return 1


def build(check: bool, partial: bool = False) -> int:
    errors: list[str] = []
    site = load_json(CONTENT_DIR / "site.json")
    langs = load_languages(site, errors)
    english = load_articles(errors)
    sources = load_sources(errors)
    if errors:
        return report(errors)

    ctx = Site(site, langs)
    resolve_citations(english, sources, errors, langs["en"], check_unused=True)
    validate_pins(english, errors)
    validate_links(english, errors)

    for a in english:
        if a["og_image"]:
            img_path = ROOT / a["og_image"].lstrip("/")
            if not img_path.exists():
                errors.append(f"{a['_path']}: og_image '{a['og_image']}' not found")

    # Translations. With --partial, problems in them are warnings and the
    # affected pages are simply left out; otherwise they fail the build.
    translation_problems: list[str] = []
    translation_warnings: list[str] = []
    articles_by_lang: dict[str, list[dict]] = {"en": [a for a in english if not a["draft"]]}
    english_slugs = {a["slug"] for a in articles_by_lang["en"]}
    for code in langs:
        if code == "en":
            continue
        translated = load_translations(code, english, translation_problems, translation_warnings)
        resolve_citations(translated, sources, errors, langs[code], check_unused=False)
        articles_by_lang[code] = translated

    warnings = list(translation_warnings)
    for a in english:
        if not a["tags"]:
            warnings.append(f"{a['_path']}: no tags set")
        if a["faq"] and len(a["faq"]) < 2:
            warnings.append(f"{a['_path']}: fewer than 2 FAQ entries")

    # Which page exists in which language.
    for code, S in langs.items():
        for name, kind in SHELL_PAGES:
            if (ROOT / S["path"] / name).exists():
                ctx.available[code].add((kind,))
                if code != "en":
                    i18n_check.check_shell(code, name, translation_problems)
            elif code == "en":
                errors.append(f"{name}: expected to exist so its nav can be generated")
        live = articles_by_lang[code]
        if live:
            ctx.available[code].add(("hub",))
            ctx.available[code].update(("article", a["slug"]) for a in live)
        if code != "en" and not ctx.has(code, ("calc",)) and live:
            translation_problems.append(f"{S['path']}index.html: '{code}' has articles but no translated calculator page")
    for code in langs:
        if code == "en":
            continue
        # Translations are published as they are finished: a link to an
        # article this language doesn't have yet goes to the English one.
        validate_links(articles_by_lang[code], errors, code, english_slugs)
        have = {a["slug"] for a in articles_by_lang[code]}
        for a in articles_by_lang[code]:
            a["_body"] = link_untranslated(a["_body"], have, english_slugs)

    # Tags per language (labels translated, slugs shared).
    tag_counts_by_lang: dict[str, list[tuple]] = {}
    for code, S in langs.items():
        counts: dict[str, int] = {}
        for a in articles_by_lang[code]:
            for t in a["tags"]:
                counts[t] = counts.get(t, 0) + 1
        tag_counts = [(t, S["tags"].get(t, t.replace("-", " ").title()), c) for t, c in sorted(counts.items())]
        tag_counts_by_lang[code] = tag_counts if site.get("tag_pages_enabled") else []
        if tag_counts_by_lang[code]:
            ctx.available[code].add(("tags",))
            ctx.available[code].update(("tag", t) for t, _l, _c in tag_counts)

    if translation_problems:
        if partial:
            warnings += [f"(translation, skipped) {p}" for p in translation_problems]
        else:
            errors += translation_problems
            errors.append("translation problems found — fix them, or build with --partial to publish only the finished translations")
    if errors:
        return report(errors)

    rendered: dict[Path, str] = {}
    sitemap_pages: list[tuple] = []
    static_meta = {p["loc"]: p for p in site["static_pages"]}
    for code, S in langs.items():
        live = articles_by_lang[code]
        for name, kind in SHELL_PAGES:
            key = (kind,)
            if not ctx.has(code, key):
                continue
            patched = patch_shell_page(ctx, code, key, kind, errors)
            if patched is not None:
                rendered[output_file(page_path(S, key))] = patched
            m = static_meta[SHELL_KEY_LOC[kind]]
            sitemap_pages.append((code, key, m["lastmod"], m["changefreq"], m["priority"]))
        if not live:
            continue

        newest = max(a["date_modified"] for a in live)
        sitemap_pages.append((code, ("hub",), newest, "monthly", "0.8"))
        rendered[output_file(page_path(S, ("hub",)))] = render_hub(ctx, code, live)
        for a in live:
            if code == "en" and not compute_related(a, live, site):
                warnings.append(f"{a['_path']}: no related articles resolved")
            rendered[output_file(page_path(S, ("article", a["slug"])))] = render_article(ctx, code, a, live)
        for a in sorted(live, key=lambda a: a["slug"]):
            sitemap_pages.append((code, ("article", a["slug"]), a["date_modified"], "monthly", "0.7"))

        tag_counts = tag_counts_by_lang[code]
        if tag_counts:
            rendered[output_file(page_path(S, ("tags",)))] = render_tags_index(ctx, code, tag_counts)
            sitemap_pages.append((code, ("tags",), newest, "monthly", "0.5"))
            for tag, label, _count in tag_counts:
                tagged = [a for a in live if tag in a["tags"]]
                rendered[output_file(page_path(S, ("tag", tag)))] = render_tag_page(ctx, code, tag, label, tagged)
            for tag, _label, _count in sorted(tag_counts):
                lastmod = max(a["date_modified"] for a in live if tag in a["tags"])
                sitemap_pages.append((code, ("tag", tag), lastmod, "monthly", "0.5"))

    rendered[ROOT / "sitemap.xml"] = render_sitemap(ctx, sitemap_pages)

    # Last: the cache name hashes every other shell file's final content.
    shell = compute_shell(ctx, english, tag_counts_by_lang["en"])
    rendered[ROOT / "sw.js"] = render_sw(shell, ctx, rendered)

    # SW shell paths must exist on disk (or be one of the files we're about to write).
    for shell_path in shell:
        if shell_path.endswith("/"):
            continue  # directory-style shell entries aren't real files on disk
        candidate = ROOT / shell_path[2:]
        if candidate not in rendered and not candidate.exists():
            errors.append(f"sw.js SHELL references '{shell_path}' which does not exist and is not generated")

    if errors:
        return report(errors)

    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)

    # Generated Knowledge Base pages that the build no longer produces (an
    # article or translation removed, or held back by --partial).
    stale = []
    for S in langs.values():
        folder = ROOT / S["path"] / "learn"
        if folder.exists():
            stale += [p for p in sorted(folder.rglob("*.html")) if p not in rendered]

    if check:
        drift = []
        for path in stale:
            drift.append(path)
            print(f"stale generated file: {path.relative_to(ROOT)}")
        for path, content in rendered.items():
            existing = path.read_text(encoding="utf-8") if path.exists() else ""
            if existing != content:
                drift.append(path)
                diff = difflib.unified_diff(
                    existing.splitlines(keepends=True),
                    content.splitlines(keepends=True),
                    fromfile=f"a/{path.relative_to(ROOT)}",
                    tofile=f"b/{path.relative_to(ROOT)}",
                )
                sys.stdout.writelines(diff)
        if drift:
            print(f"\n{len(drift)} file(s) out of date. Run `python3 scripts/build_kb.py` and commit the result.", file=sys.stderr)
            return 1
        print("Generated pages, sitemap.xml and sw.js are up to date.")
        return 0

    results = {"changed": [], "unchanged": []}
    for path, content in rendered.items():
        write_if_changed(path, content, results)
    for path in stale:
        path.unlink()
        print(f"  removed stale: {path.relative_to(ROOT)}")

    print(f"Wrote {len(results['changed'])} file(s), {len(results['unchanged'])} unchanged.")
    for path in results["changed"]:
        print(f"  updated: {path.relative_to(ROOT)}")
    return 0


def main():
    args = sys.argv[1:]
    sys.exit(build(check="--check" in args, partial="--partial" in args))


if __name__ == "__main__":
    main()
