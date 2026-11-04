#!/usr/bin/env python3
"""Rewrite the stock Element Web /app into the Plotina brand.

The Dockerfile used to carry every brand edit as a chain of fragile `sed -i`
invocations. This module keeps them in one place so they can be tested without
a container:

    COPY branding.py /tmp/branding.py
    RUN  python3 /tmp/branding.py --app /app

Scope (and nothing else):

  * index.html — <title>, apple-mobile-web-app-title, application-name,
    theme-color, og:image, the icon/ apple-touch-icon link set, and the
    noscript sentence.
  * bundles/*/error-view.js — the Element app logo path and its alt text.
  * config.json — branding.welcome_background_url (created when the baked
    image config has no branding block yet).
  * themes/element/img/logos — element-logo.svg is replaced by the Plotina
    icon, opengraph.png is deleted.

Explicitly out of scope:

  * The noise overlay. The two <script> tags for /noise/ are inserted by the
    Dockerfile *before* this script runs and are left byte-identical here.
  * Other bundle chunks. The built-in Element Call widget keeps its name in
    the shipped JS; only the two error-view strings are rewritten.
  * /app/mobile_guide, /app/plotina-bg.png and the element-app-logo.png
    overwrite: pure file placements, owned by Dockerfile COPY/RM lines.

Every replacement is followed by an assertion on the end state, so an upstream
change that moves a marker fails the build loudly instead of quietly serving
the Element brand again. Re-running on an already-branded tree is a no-op.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import NoReturn

BRAND = "Plotina Web"
THEME_COLOR = "#17795A"
OG_IMAGE = "https://chat.plotina.cc/plotina-512.png"
ICON_SVG = "/plotina-icon.svg"
ICON_192 = "/plotina-icon-192.png"
ERROR_LOGO = "/plotina-512.png"
WELCOME_BG = "/plotina-bg.png"

ICON_LINK = f'<link rel="icon" type="image/svg+xml" href="{ICON_SVG}">'
TOUCH_LINK = f'<link rel="apple-touch-icon" sizes="192x192" href="{ICON_192}">'


class BrandingError(RuntimeError):
    """A brand replacement did not happen; the build must stop."""


def fail(message: str) -> NoReturn:
    print(f"branding: {message}", file=sys.stderr)
    raise SystemExit(1)


def _rewrite_meta(html: str, selector: str, value: str) -> str:
    """Set the content= of the <meta> that *selector* picks, any attribute order."""
    pattern = re.compile(
        r'(<meta\b(?=[^>]*' + re.escape(selector) + r')[^>]*?content=")[^"]*(")')
    out, count = pattern.subn(lambda m: m.group(1) + value + m.group(2), html)
    if count != 1:
        raise BrandingError(f"index.html: expected exactly one meta for {selector!r}, "
                            f"patched {count}")
    return out


def rebrand_index(html: str) -> str:
    """Pure string pass over /app/index.html."""
    html = html.replace("<title>Element</title>", f"<title>{BRAND}</title>")

    # The stock favicon/icon set points at vector-icons/*.png; drop every
    # rel="icon"/rel="apple-touch-icon" link, then add the Plotina pair right
    # after the <title>. Anchoring on the title (not </head>) keeps the output
    # byte-stable across re-runs — a second run removes and re-adds exactly
    # these lines — and it does not care what the noise overlay appended to
    # the end of the head first. Stylesheet and manifest links use other rel
    # values and survive.
    html = re.sub(r'[ \t]*<link\b[^>]*\brel="(?:icon|apple-touch-icon)"[^>]*>[ \t]*\n?',
                  "", html)
    title_tag = f"<title>{BRAND}</title>"
    html = html.replace(title_tag,
                        f"{title_tag}\n    {ICON_LINK}\n    {TOUCH_LINK}", 1)

    html = _rewrite_meta(html, 'name="apple-mobile-web-app-title"', BRAND)
    html = _rewrite_meta(html, 'name="application-name"', BRAND)
    html = _rewrite_meta(html, 'name="theme-color"', THEME_COLOR)
    html = _rewrite_meta(html, 'property="og:image"', OG_IMAGE)

    html = html.replace("Sorry, Element requires JavaScript to be enabled.",
                        f"{BRAND} requires JavaScript to be enabled.")

    for expected in (
        f"<title>{BRAND}</title>",
        f'<meta name="apple-mobile-web-app-title" content="{BRAND}">',
        f'<meta name="application-name" content="{BRAND}">',
        f'<meta name="theme-color" content="{THEME_COLOR}">',
        f'content="{OG_IMAGE}"',
        ICON_LINK,
        TOUCH_LINK,
        f"{BRAND} requires JavaScript to be enabled.",
    ):
        if expected not in html:
            raise BrandingError(f"index.html: {expected!r} missing after rebrand")
    for forbidden in (
        "<title>Element</title>",
        'content="Element"',
        'rel="icon" type="image/png"',
        "vector-icons/",
        "app.element.io",
        "Element requires JavaScript",
    ):
        if forbidden in html:
            raise BrandingError(f"index.html: {forbidden!r} survived the rebrand")
    return html


def rebrand_error_view(js: str) -> str:
    """Pure string pass over a bundles/*/error-view.js chunk."""
    js = js.replace("themes/element/img/logos/element-app-logo.png", ERROR_LOGO)
    js = re.sub(r'alt([:=])("|\x27)Element\2', rf"alt\1\2Plotina\2", js)
    if "element-app-logo" in js:
        raise BrandingError("error-view.js: element-app-logo reference survived")
    if 'alt:"Element"' in js or "alt:'Element'" in js or 'alt="Element"' in js:
        raise BrandingError('error-view.js: alt:"Element" survived')
    if 'src:"/plotina-512.png"' not in js:
        raise BrandingError("error-view.js: branded logo src missing after rebrand")
    return js


def rebrand_config(config: Path) -> bool:
    """Point the welcome screen at the Plotina background. Absent is fine:
    deployments mount their own config.json over /app/config.json."""
    if not config.is_file():
        return False
    try:
        cfg = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BrandingError(f"config.json: cannot parse: {exc}") from exc
    if not isinstance(cfg, dict):
        raise BrandingError("config.json: top level is not an object")
    branding = cfg.get("branding")
    if not isinstance(branding, dict):
        branding = {}
        cfg["branding"] = branding
    branding["welcome_background_url"] = WELCOME_BG
    config.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n",
                      encoding="utf-8")
    return True


def apply(app: Path) -> list[str]:
    """Brand the given webapp directory; return human-readable actions."""
    index = app / "index.html"
    if not index.is_file():
        raise BrandingError(f"index.html: {index} does not exist; is --app the "
                            "Element Web root (/app)?")
    actions: list[str] = []

    before = index.read_text(encoding="utf-8")
    noise_tag = ('<script src="/noise/logic.js"></script>'
                 '<script src="/noise/boot.js" defer></script>')
    index.write_text(rebrand_index(before), encoding="utf-8")
    if noise_tag in before and noise_tag not in index.read_text(encoding="utf-8"):
        raise BrandingError("index.html: the noise overlay tags vanished")
    actions.append("index.html rebranded (title, metas, icons, og:image, noscript)")

    error_views = sorted((app / "bundles").glob("*/error-view.js"))
    if not error_views:
        raise BrandingError("no bundles/*/error-view.js found; upstream layout moved")
    for chunk in error_views:
        chunk.write_text(rebrand_error_view(chunk.read_text(encoding="utf-8",
                                                            errors="replace")),
                         encoding="utf-8")
    actions.append(f"{len(error_views)} error-view chunk(s) rebranded")

    if rebrand_config(app / "config.json"):
        actions.append("config.json: branding.welcome_background_url set")
    else:
        actions.append("config.json absent (mounted at runtime), skipped")

    logos = app / "themes" / "element" / "img" / "logos"
    icon_src = app / "plotina-icon.svg"
    if not icon_src.is_file():
        raise BrandingError(f"{icon_src} missing; the Dockerfile COPYs it first")
    if not logos.is_dir():
        raise BrandingError(f"{logos} missing; upstream theme layout moved")
    shutil.copyfile(icon_src, logos / "element-logo.svg")
    (logos / "element-logo.svg").chmod(0o644)
    actions.append("themes/element/img/logos/element-logo.svg := plotina-icon.svg")

    opengraph = logos / "opengraph.png"
    if opengraph.exists():
        opengraph.unlink()
        actions.append("themes/element/img/logos/opengraph.png deleted")
    return actions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rewrite a stock Element Web /app into the Plotina brand.")
    parser.add_argument("--app", required=True, type=Path,
                        help="webapp root to brand (the /app directory)")
    args = parser.parse_args(argv)
    app: Path = args.app
    if not app.is_dir():
        fail(f"{app} is not a directory")
    try:
        actions = apply(app)
    except BrandingError as exc:
        fail(str(exc))
    for action in actions:
        print(f"branding: {action}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
