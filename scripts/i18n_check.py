#!/usr/bin/env python3
"""Check translated content against its English source.

Usage:
  python3 scripts/i18n_check.py                 # every translation
  python3 scripts/i18n_check.py es              # one language
  python3 scripts/i18n_check.py es uva-vs-uvb   # one article

A translation must keep the structure of the English text it was made from:
the same links (in the same order), the same [[cite:...]] markers, the same
HTML elements and classes, and the same number of FAQ entries. Only the words
change. Shell pages (<lang>/index.html, about.html, widget.html) are compared
the same way against the root pages, ignoring the regions the build
generates.

Standard library only. Exit status 1 when any problem is found.
"""
from __future__ import annotations

import html.parser
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEARN_CONTENT_DIR = ROOT / "content" / "learn"
I18N_DIR = ROOT / "content" / "i18n"

META_RE = re.compile(r"\A<!--meta\s*\n(?P<json>.*?)\n-->\s*\n?", re.DOTALL)
CITE_RE = re.compile(r"\[\[cite:([a-z0-9_,\- ]+)\]\]")
GENERATED_RE = re.compile(
    r"<!-- (site-nav|hreflang):start.*?<!-- \1:end -->", re.DOTALL
)

# Meta keys a translation must carry (when the English file has them), and
# keys it must NOT carry because they are shared with the English article.
TRANSLATED_KEYS = [
    "title", "headline", "description", "og_title", "og_description",
    "jsonld_description", "faq", "cta_text", "breadcrumb_label",
]
SHARED_KEYS = [
    "schema_type", "date_published", "date_modified", "tags", "order",
    "related_exclude", "cta_href", "draft", "og_image", "author",
]
SHELL_PAGES = ["index.html", "about.html", "widget.html"]


def languages() -> list[str]:
    return sorted(p.stem for p in I18N_DIR.glob("*.json") if p.stem != "en")


class Skeleton(html.parser.HTMLParser):
    """Records the structure of a fragment: opening tags with their
    class/id, closing tags, link targets and media sources, in document
    order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        sig = tag
        if a.get("class"):
            sig += "." + ".".join(sorted(a["class"].split()))
        if a.get("id"):
            sig += "#" + a["id"]
        self.tags.append(sig)
        for key in ("href", "src"):
            if a.get(key):
                self.links.append(f"{tag}[{key}]={a[key]}")

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        self.tags.append("/" + tag)


def skeleton(fragment: str) -> Skeleton:
    s = Skeleton()
    s.feed(fragment)
    s.close()
    return s


def compare_fragments(where: str, en: str, tr: str, problems: list[str], *, link_map=None):
    en_cites = CITE_RE.findall(en)
    tr_cites = CITE_RE.findall(tr)
    if en_cites != tr_cites:
        problems.append(f"{where}: citation markers differ (en {en_cites} vs {tr_cites})")

    se, st = skeleton(en), skeleton(tr)
    en_links = [link_map(x) if link_map else x for x in se.links]
    if en_links != st.links:
        missing = [x for x in en_links if x not in st.links]
        extra = [x for x in st.links if x not in en_links]
        detail = []
        if missing:
            detail.append(f"missing {missing[:5]}")
        if extra:
            detail.append(f"unexpected {extra[:5]}")
        if not detail:
            detail.append("same links in a different order")
        problems.append(f"{where}: links differ — " + "; ".join(detail))

    if se.tags != st.tags:
        from collections import Counter
        ce, ct = Counter(se.tags), Counter(st.tags)
        diff = {k: (ce[k], ct[k]) for k in set(ce) | set(ct) if ce[k] != ct[k]}
        if diff:
            shown = ", ".join(f"{k}: en {a} vs {b}" for k, (a, b) in sorted(diff.items())[:8])
            problems.append(f"{where}: HTML elements differ ({shown})")
        else:
            problems.append(f"{where}: HTML elements are in a different order")


def parse(path: Path):
    text = path.read_text(encoding="utf-8")
    m = META_RE.match(text)
    if not m:
        raise ValueError("missing leading <!--meta ... --> block")
    return json.loads(m.group("json")), text[m.end():]


def check_article(lang: str, slug: str, problems: list[str], stale: list[str] | None = None):
    """Append what is wrong with one translation to `problems`. When `stale`
    is given, "the English article changed since this was translated" goes
    there instead, so a caller can tell an outdated translation from a broken
    one."""
    en_path = LEARN_CONTENT_DIR / f"{slug}.html"
    tr_path = LEARN_CONTENT_DIR / lang / f"{slug}.html"
    where = str(tr_path.relative_to(ROOT))
    if not en_path.exists():
        problems.append(f"{where}: no English article '{slug}'")
        return
    try:
        en_meta, en_body = parse(en_path)
        tr_meta, tr_body = parse(tr_path)
    except (ValueError, json.JSONDecodeError) as e:
        problems.append(f"{where}: {e}")
        return

    if tr_meta.get("slug") != slug:
        problems.append(f"{where}: slug must be '{slug}'")
    if tr_meta.get("translated_from") != en_meta.get("date_modified"):
        (problems if stale is None else stale).append(
            f"{where}: translated_from is {tr_meta.get('translated_from')!r}, "
            f"English date_modified is {en_meta.get('date_modified')!r} (re-check the translation)"
        )
    for key in TRANSLATED_KEYS:
        if key in en_meta and not tr_meta.get(key):
            problems.append(f"{where}: meta is missing translated '{key}'")
    for key in SHARED_KEYS:
        if key in tr_meta:
            problems.append(f"{where}: meta must not set '{key}' (it comes from the English article)")
    if len(tr_meta.get("faq", [])) != len(en_meta.get("faq", [])):
        problems.append(f"{where}: faq has {len(tr_meta.get('faq', []))} entries, English has {len(en_meta.get('faq', []))}")
    for i, qa in enumerate(tr_meta.get("faq", [])):
        if not qa.get("question") or not qa.get("answer"):
            problems.append(f"{where}: faq[{i}] has an empty question or answer")

    en_pins = en_meta.get("related_pins", [])
    if "related_pins" in tr_meta:
        tr_pins = tr_meta["related_pins"]
        strip = lambda p: p if isinstance(p, str) else {k: v for k, v in p.items() if k != "label"}
        if [strip(p) for p in tr_pins] != [strip(p) for p in en_pins]:
            problems.append(f"{where}: related_pins must match the English list (only labels may change)")
    elif any(isinstance(p, dict) and p.get("label") for p in en_pins):
        problems.append(f"{where}: English related_pins carry labels — copy the list and translate the labels")

    compare_fragments(where, en_body, tr_body, problems)


def check_shell(lang: str, name: str, problems: list[str]):
    en_path = ROOT / name
    tr_path = ROOT / lang / name
    where = str(tr_path.relative_to(ROOT))
    en = GENERATED_RE.sub("", en_path.read_text(encoding="utf-8"))
    tr = GENERATED_RE.sub("", tr_path.read_text(encoding="utf-8"))

    def link_map(link: str) -> str:
        # Assets live at the site root, one level up; pages resolve inside
        # the language folder; absolute uvaindex.org page URLs gain /<lang>.
        tag, _, target = link.partition("=")
        if target.startswith("https://uvaindex.org/"):
            path = target[len("https://uvaindex.org/"):]
            if path == "" or path.endswith(".html") and "/" not in path:
                return f"{tag}=https://uvaindex.org/{lang}/{path}"
            return link
        if re.match(r"^(styles\.css|favicon\.svg|manifest\.webmanifest|icons/|js/)", target):
            return f"{tag}=../{target}"
        return link

    if f'<html lang="' not in tr:
        problems.append(f"{where}: missing <html lang>")
    compare_fragments(where, en, tr, problems, link_map=link_map)


def main(argv: list[str]) -> int:
    langs = [argv[0]] if argv else languages()
    only = argv[1] if len(argv) > 1 else None
    problems: list[str] = []
    checked = 0
    for lang in langs:
        folder = LEARN_CONTENT_DIR / lang
        for path in sorted(folder.glob("*.html")) if folder.exists() else []:
            if only and path.stem != only:
                continue
            check_article(lang, path.stem, problems)
            checked += 1
        if not only:
            for name in SHELL_PAGES:
                if (ROOT / lang / name).exists():
                    check_shell(lang, name, problems)
                    checked += 1
    for p in problems:
        print(p)
    print(f"Checked {checked} file(s): {len(problems)} problem(s).", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
