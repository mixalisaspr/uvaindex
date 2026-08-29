#!/usr/bin/env python3
"""Generate the Knowledge Base (learn/*.html), sitemap.xml and sw.js from
content/learn/*.html + content/site.json.

Usage:
  python3 scripts/build_kb.py            # regenerate and write files
  python3 scripts/build_kb.py --check    # regenerate in-memory, diff against
                                          # what's committed, exit 1 on drift

Content files are plain HTML with a leading JSON metadata block:

  <!--meta
  { "slug": "...", "title": "...", ... }
  -->
  <h1>...</h1>
  ...

No third-party dependencies — standard library only, to match this repo's
"no dependencies, no frameworks" policy for the shipped site. Only the
*authoring* step gains tooling; learn/*.html, sitemap.xml and sw.js remain
plain static files served as-is.
"""
from __future__ import annotations

import difflib
import hashlib
import html.parser
import json
import re
import sys
from datetime import date
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "content"
LEARN_CONTENT_DIR = CONTENT_DIR / "learn"
TEMPLATES_DIR = ROOT / "templates"
LEARN_DIR = ROOT / "learn"
TAGS_DIR = LEARN_DIR / "tags"

META_RE = re.compile(r"\A<!--meta\s*\n(?P<json>.*?)\n-->\s*\n?", re.DOTALL)

REQUIRED_FIELDS = ["slug", "title", "headline", "description", "date_published"]
VALID_SCHEMA_TYPES = {"Article", "TechArticle"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
            "keywords": meta.get("keywords", []),
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


def validate_links(articles: list[dict], errors: list[str]):
    slugs = {a["slug"] for a in articles}
    known_static = {"../", "../about.html", "./", "#omitted"}
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


def render_related_block(related: list[dict]) -> str:
    if not related:
        return ""
    item_tmpl = load_template("_related_item.tmpl.html")
    items = "\n          ".join(
        item_tmpl.substitute(HREF=esc(r["href"]), LABEL=esc(r["label"])) for r in related
    )
    aside_tmpl = load_template("_related_aside.tmpl.html")
    return "\n" + aside_tmpl.substitute(ITEMS=items)


def render_jsonld_block(data: dict) -> str:
    body = json.dumps(data, indent=2, ensure_ascii=False)
    indented = "\n".join(("      " + line if line else line) for line in body.split("\n"))
    return f'    <script type="application/ld+json">\n{indented}\n    </script>'


def article_jsonld(article: dict, canonical: str) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": article["schema_type"],
        "headline": article["headline"],
        "description": article["jsonld_description"],
        "author": {"@type": "Organization", "name": article["author"]},
        "publisher": {"@type": "Organization", "name": article["author"]},
        "datePublished": article["date_published"],
        "dateModified": article["date_modified"],
        "mainEntityOfPage": canonical,
    }


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


def render_breadcrumb_nav(crumbs: list[tuple]) -> str:
    parts = []
    for label, href in crumbs[:-1]:
        parts.append(f'<a href="{esc(href)}">{esc(label)}</a><span class="sep">›</span>')
    parts.append(esc(crumbs[-1][0]))
    nav_tmpl = load_template("_breadcrumb.tmpl.html")
    return nav_tmpl.substitute(CRUMBS="".join(parts)).rstrip("\n")


def render_head(site: dict, *, title, description, keywords, author, canonical, rel,
                 og_type, og_title, og_description, og_image, jsonld_blocks) -> str:
    keywords_meta = ""
    if keywords:
        keywords_meta = f'\n    <meta name="keywords" content="{esc(", ".join(keywords))}" />'
    head_tmpl = load_template("_head.tmpl.html")
    return head_tmpl.substitute(
        GA_ID=site["ga_id"],
        TITLE=esc(title),
        DESCRIPTION=esc(description),
        KEYWORDS_META=keywords_meta,
        AUTHOR=esc(author),
        CANONICAL=esc(canonical),
        REL=rel,
        SITE_NAME=esc(site["site_name"]),
        OG_TYPE=og_type,
        OG_TITLE=esc(og_title),
        OG_DESCRIPTION=esc(og_description),
        OG_URL=esc(canonical),
        OG_IMAGE=esc(og_image or site["default_og_image"]),
        OG_IMAGE_WIDTH=site["og_image_width"],
        OG_IMAGE_HEIGHT=site["og_image_height"],
        JSONLD_BLOCKS="\n\n".join(jsonld_blocks),
    )


def render_article(article: dict, all_articles: list[dict], site: dict) -> str:
    site_url = site["site_url"].rstrip("/")
    canonical = f"{site_url}/learn/{article['slug']}.html"
    crumbs = [("UVA Index", "../"), ("Knowledge Base", "./"), (article["breadcrumb_label"], None)]
    jsonld_crumbs = [
        ("UVA Index", f"{site_url}/"),
        ("Knowledge Base", f"{site_url}/learn/"),
        (article["breadcrumb_label"], canonical),
    ]

    jsonld = [render_jsonld_block(article_jsonld(article, canonical))]
    if article["faq"]:
        jsonld.append(render_jsonld_block(faq_jsonld(article["faq"])))
    jsonld.append(render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs)))

    head = render_head(
        site,
        title=article["title"],
        description=article["description"],
        keywords=article["keywords"],
        author=article["author"],
        canonical=canonical,
        rel="../",
        og_type="article",
        og_title=article["og_title"],
        og_description=article["og_description"],
        og_image=article["og_image"],
        jsonld_blocks=jsonld,
    )

    related = compute_related(article, all_articles, site)
    body_indented = "\n".join(
        ("        " + line if line else line) for line in article["_body"].rstrip("\n").split("\n")
    )
    tmpl = load_template("article.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        BREADCRUMB_NAV=render_breadcrumb_nav(crumbs),
        BODY=body_indented,
        CTA_HREF=esc(article["cta_href"] or site["default_cta_href"]),
        CTA_TEXT=esc(article["cta_text"] or site["default_cta_text"]),
        RELATED_BLOCK=render_related_block(related),
        DISCLAIMER=site["disclaimer"],
        REL="../",
    )


NAV_START = "      <!-- site-nav:start (generated by scripts/build_kb.py — do not edit) -->\n"
NAV_END = "      <!-- site-nav:end -->\n"
NAV_RE = re.compile(
    re.escape(NAV_START) + r".*?" + re.escape(NAV_END), re.DOTALL
)

# The three pages carrying the primary nav (index.html, about.html and the
# generated Knowledge Base hub) used to keep three hand-copied versions of it,
# which is how they drifted apart. The nav now has exactly one source —
# templates/_site_nav.tmpl.html — rendered per page from here.
def render_site_nav(rel: str, active: str) -> str:
    """rel: path prefix back to the site root ('./' or '../').
    active: which link is the current page ('calc', 'learn' or 'about')."""
    if active not in {"calc", "learn", "about"}:
        raise BuildError(f"render_site_nav: unknown active page '{active}'")
    tmpl = load_template("_site_nav.tmpl.html")
    return tmpl.substitute(
        REL=rel,
        CALC_ACTIVE=' class="active"' if active == "calc" else "",
        LEARN_ACTIVE=' class="active"' if active == "learn" else "",
        ABOUT_ACTIVE=' class="active"' if active == "about" else "",
    ).rstrip("\n")


def patch_static_nav(path: Path, active: str, errors: list[str]) -> str | None:
    """Return `path`'s content with its marked nav region regenerated."""
    if not path.exists():
        errors.append(f"{path.name}: expected to exist so its nav can be generated")
        return None
    text = path.read_text(encoding="utf-8")
    if not NAV_RE.search(text):
        errors.append(
            f"{path.name}: missing the site-nav:start/site-nav:end markers "
            f"that scripts/build_kb.py needs in order to generate the nav"
        )
        return None
    block = NAV_START + "      " + render_site_nav("./", active) + "\n" + NAV_END
    return NAV_RE.sub(lambda _m: block, text, count=1)


def render_hub(articles: list[dict], site: dict) -> str:
    site_url = site["site_url"].rstrip("/")
    canonical = f"{site_url}/learn/"
    live = [a for a in articles if not a["draft"]]
    live_sorted = sorted(live, key=hub_sort_key)

    card_tmpl = load_template("_kb_card.tmpl.html")
    cards = "\n".join(
        card_tmpl.substitute(HREF=f"{a['slug']}.html", TITLE=esc(a["headline"]), EXCERPT=esc(a["description"]))
        for a in live_sorted
    )

    collection = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "UVA Knowledge Base",
        "url": canonical,
        "description": "Plain-English guides to UVA radiation, how it differs from UVB, its health risks, and why a dedicated UVA Index is useful alongside the standard UV Index.",
        "hasPart": [
            {"@type": a["schema_type"], "name": a["headline"], "url": f"{site_url}/learn/{a['slug']}.html"}
            for a in live_sorted
        ],
    }

    head = render_head(
        site,
        title="UVA Knowledge Base — Understanding UVA Radiation & the UV Index",
        description="Plain-English guides to UVA radiation: what UVA is, how UVA differs from UVB, the health dangers of UVA, and why the standard UV Index isn't enough — making the case for a dedicated UVA Index.",
        keywords=["UVA radiation", "UVA vs UVB", "UVA dangers", "UV index explained", "UVA index", "what is UVA", "surface UVA"],
        author=site["org_name"],
        canonical=canonical,
        rel="../",
        og_type="website",
        og_title="UVA Knowledge Base — Understanding UVA Radiation & the UV Index",
        og_description="Plain-English guides to UVA radiation, how it differs from UVB, its health risks, and why we need a dedicated UVA Index.",
        og_image=None,
        jsonld_blocks=[render_jsonld_block(collection)],
    )

    tmpl = load_template("hub.tmpl.html")
    return tmpl.substitute(
        HEAD=head,
        SITE_NAV=render_site_nav("../", "learn"),
        CARDS=cards,
        DISCLAIMER=site["disclaimer"],
    )


def render_tag_page(tag: str, tag_label: str, articles: list[dict], site: dict) -> str:
    site_url = site["site_url"].rstrip("/")
    canonical = f"{site_url}/learn/tags/{tag}.html"
    crumbs = [("UVA Index", "../../"), ("Knowledge Base", "../"), ("Topics", "./"), (tag_label, None)]
    jsonld_crumbs = [
        ("UVA Index", f"{site_url}/"),
        ("Knowledge Base", f"{site_url}/learn/"),
        ("Topics", f"{site_url}/learn/tags/"),
        (tag_label, canonical),
    ]

    live_sorted = sorted(articles, key=hub_sort_key)
    card_tmpl = load_template("_kb_card.tmpl.html")
    cards = "\n".join(
        card_tmpl.substitute(HREF=f"../{a['slug']}.html", TITLE=esc(a["headline"]), EXCERPT=esc(a["description"]))
        for a in live_sorted
    )

    jsonld = [render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs))]
    head = render_head(
        site,
        title=f"{tag_label} — UVA Knowledge Base",
        description=f"Knowledge Base articles about {tag_label.lower()}.",
        keywords=[],
        author=site["org_name"],
        canonical=canonical,
        rel="../../",
        og_type="website",
        og_title=f"{tag_label} — UVA Knowledge Base",
        og_description=f"Knowledge Base articles about {tag_label.lower()}.",
        og_image=None,
        jsonld_blocks=jsonld,
    )

    tmpl = load_template("tag.tmpl.html")
    return tmpl.substitute(HEAD=head, BREADCRUMB_NAV=render_breadcrumb_nav(crumbs), TAG_LABEL=esc(tag_label), CARDS=cards, DISCLAIMER=site["disclaimer"])


def render_tags_index(tag_counts: list[tuple], site: dict) -> str:
    site_url = site["site_url"].rstrip("/")
    canonical = f"{site_url}/learn/tags/"
    crumbs = [("UVA Index", "../../"), ("Knowledge Base", "../"), ("Topics", None)]
    jsonld_crumbs = [
        ("UVA Index", f"{site_url}/"),
        ("Knowledge Base", f"{site_url}/learn/"),
        ("Topics", canonical),
    ]

    card_tmpl = load_template("_kb_card.tmpl.html")
    cards = "\n".join(
        card_tmpl.substitute(HREF=f"{tag}.html", TITLE=esc(label), EXCERPT=esc(f"{count} article{'s' if count != 1 else ''}"))
        for tag, label, count in tag_counts
    )

    jsonld = [render_jsonld_block(breadcrumb_jsonld(jsonld_crumbs))]
    head = render_head(
        site,
        title="Browse by Topic — UVA Knowledge Base",
        description="Browse UVA Knowledge Base articles by topic.",
        keywords=[],
        author=site["org_name"],
        canonical=canonical,
        rel="../../",
        og_type="website",
        og_title="Browse by Topic — UVA Knowledge Base",
        og_description="Browse UVA Knowledge Base articles by topic.",
        og_image=None,
        jsonld_blocks=jsonld,
    )

    tmpl = load_template("tags_index.tmpl.html")
    return tmpl.substitute(HEAD=head, BREADCRUMB_NAV=render_breadcrumb_nav(crumbs), CARDS=cards, DISCLAIMER=site["disclaimer"])


def render_sitemap(articles: list[dict], tag_counts: list[tuple], site: dict) -> str:
    site_url = site["site_url"].rstrip("/")
    urls = list(site["static_pages"])
    urls.append({"loc": "/learn/", "lastmod": max((a["date_modified"] for a in articles if not a["draft"]), default="2026-06-20"), "changefreq": "monthly", "priority": "0.8"})
    for a in sorted((a for a in articles if not a["draft"]), key=lambda a: a["slug"]):
        urls.append({"loc": f"/learn/{a['slug']}.html", "lastmod": a["date_modified"], "changefreq": "monthly", "priority": "0.7"})
    if site.get("tag_pages_enabled") and tag_counts:
        urls.append({"loc": "/learn/tags/", "lastmod": max((a["date_modified"] for a in articles if not a["draft"]), default="2026-06-20"), "changefreq": "monthly", "priority": "0.5"})
        for tag, _label, _count in sorted(tag_counts):
            urls.append({"loc": f"/learn/tags/{tag}.html", "lastmod": max((a["date_modified"] for a in articles if not a["draft"] and tag in a["tags"]), default="2026-06-20"), "changefreq": "monthly", "priority": "0.5"})

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{site_url}{u['loc']}</loc>")
        lines.append(f"    <lastmod>{u['lastmod']}</lastmod>")
        lines.append(f"    <changefreq>{u['changefreq']}</changefreq>")
        lines.append(f"    <priority>{u['priority']}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def compute_shell(articles: list[dict], tag_counts: list[tuple], site: dict) -> list[str]:
    shell = list(site["sw_shell_prefix"])
    shell += ["./learn/", "./learn/index.html"]
    for a in sorted((a for a in articles if not a["draft"]), key=lambda a: a["slug"]):
        shell.append(f"./learn/{a['slug']}.html")
    if site.get("tag_pages_enabled") and tag_counts:
        shell.append("./learn/tags/")
        shell.append("./learn/tags/index.html")
        for tag, _label, _count in sorted(tag_counts):
            shell.append(f"./learn/tags/{tag}.html")
    return shell


def render_sw(articles: list[dict], tag_counts: list[tuple], site: dict) -> str:
    shell = compute_shell(articles, tag_counts, site)
    cache_hash = hashlib.sha256(json.dumps(shell, sort_keys=False).encode("utf-8")).hexdigest()[:10]
    cache = f"uvaindex-shell-{cache_hash}"
    shell_json = json.dumps(shell, indent=2)
    # re-indent the JS array literal to match the template's 2-space body
    shell_json = "\n".join(("  " + line if i else line) for i, line in enumerate(shell_json.split("\n")))

    tmpl = load_template("sw.tmpl.js")
    return tmpl.substitute(CACHE=cache, SHELL_JSON=shell_json)


def write_if_changed(path: Path, content: str, results: dict):
    existing = path.read_text(encoding="utf-8") if path.exists() else None
    if existing == content:
        results["unchanged"].append(path)
    else:
        results["changed"].append(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def build(check: bool) -> int:
    errors: list[str] = []
    site = load_json(CONTENT_DIR / "site.json")
    articles = load_articles(errors)
    validate_pins(articles, errors)
    validate_links(articles, errors)

    for a in articles:
        if a["og_image"]:
            img_path = ROOT / a["og_image"].lstrip("/")
            if not img_path.exists():
                errors.append(f"{a['_path']}: og_image '{a['og_image']}' not found")

    if errors:
        print(f"Found {len(errors)} error(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    warnings = []
    for a in articles:
        if not a["tags"]:
            warnings.append(f"{a['_path']}: no tags set")
        if a["faq"] and len(a["faq"]) < 2:
            warnings.append(f"{a['_path']}: fewer than 2 FAQ entries")

    live_articles = [a for a in articles if not a["draft"]]

    tag_counts = []
    if site.get("tag_pages_enabled"):
        tag_names = site.get("tags", {})
        counts: dict[str, int] = {}
        for a in live_articles:
            for t in a["tags"]:
                counts[t] = counts.get(t, 0) + 1
        tag_counts = [(t, tag_names.get(t, t.replace("-", " ").title()), c) for t, c in sorted(counts.items())]

    rendered: dict[Path, str] = {}
    for a in live_articles:
        related = compute_related(a, live_articles, site)
        if not related:
            warnings.append(f"{a['_path']}: no related articles resolved")
        rendered[LEARN_DIR / f"{a['slug']}.html"] = render_article(a, live_articles, site)

    rendered[LEARN_DIR / "index.html"] = render_hub(live_articles, site)

    if site.get("tag_pages_enabled") and tag_counts:
        for tag, label, _count in tag_counts:
            tagged = [a for a in live_articles if tag in a["tags"]]
            rendered[TAGS_DIR / f"{tag}.html"] = render_tag_page(tag, label, tagged, site)
        rendered[TAGS_DIR / "index.html"] = render_tags_index(tag_counts, site)

    for name, active in (("index.html", "calc"), ("about.html", "about")):
        patched = patch_static_nav(ROOT / name, active, errors)
        if patched is not None:
            rendered[ROOT / name] = patched

    rendered[ROOT / "sitemap.xml"] = render_sitemap(articles, tag_counts, site)
    rendered[ROOT / "sw.js"] = render_sw(articles, tag_counts, site)

    # SW shell paths must exist on disk (or be one of the files we're about to write).
    shell = compute_shell(articles, tag_counts, site)
    for shell_path in shell:
        if shell_path == "./" or shell_path.endswith("/"):
            continue  # directory-style shell entries aren't real files on disk
        candidate = ROOT / shell_path[2:]
        if candidate not in rendered and not candidate.exists():
            errors.append(f"sw.js SHELL references '{shell_path}' which does not exist and is not generated")

    if errors:
        print(f"Found {len(errors)} error(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)

    if check:
        drift = []
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
        print("learn/, sitemap.xml and sw.js are up to date.")
        return 0

    results = {"changed": [], "unchanged": []}
    for path, content in rendered.items():
        write_if_changed(path, content, results)

    print(f"Wrote {len(results['changed'])} file(s), {len(results['unchanged'])} unchanged.")
    for path in results["changed"]:
        print(f"  updated: {path.relative_to(ROOT)}")
    return 0


def main():
    check = "--check" in sys.argv[1:]
    sys.exit(build(check))


if __name__ == "__main__":
    main()
