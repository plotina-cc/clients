#!/usr/bin/env python3
"""Rewrite the stock Element Web /app into the Plotina brand.

The Dockerfile used to carry every brand edit as a chain of fragile `sed -i`
invocations. This module keeps them in one place so they can be tested without
a container:

    COPY branding.py /tmp/branding.py
    RUN  python3 /tmp/branding.py --app /app

Scope (and nothing else):

  * index.html — <title>, apple-mobile-web-app-title, application-name,
    theme-color, og:image, the icon/ apple-touch-icon link set, the
    noscript sentence, the <style> block that keeps the
    device-verification dialog (mx_CompleteSecurityBody, shown right after
    the first login) inside the viewport on short screens. Upstream caps
    its Glass frame with .mx_Dialog_border{max-height:calc(100% - 48px)},
    which resolves against the AuthPage flex chain and cuts off the button
    row ("Sign out") without giving anything a scrollbar; the injected
    block replaces that cap with a viewport-relative one and makes the
    card scroll internally. See THEME-FIX.md at the repository root.
    It also carries the <script src="/plotina-theme.js"> bootstrap tag,
    inserted directly before the bundles/<hash>/bundle.js loader so it
    runs first: it seeds mx_local_settings.theme with the Plotina custom
    theme matching prefers-color-scheme for fresh visitors only. The file
    itself is COPYed into /app by the Dockerfile (checked here).
  * bundles/*/theme-light-custom.css and theme-dark-custom.css —
    --timeline-text-color gains a var(--cpd-color-text-primary) fallback
    at all 133 uses per sheet. Upstream references that dead legacy
    variable WITHOUT a fallback, so `color` goes invalid-at-computed-value
    -time and inherits the @media (prefers-color-scheme) tokens from
    <html>: dark-OS visitors on the light custom theme get light-on-white
    text. See THEMES.md at the repository root.
  * i18n/ru.*.json — the "after new login" verification strings that are
    still missing from upstream Russian (added only where absent, so a
    future upstream translation wins).
  * bundles/*/error-view.js — the Element app logo path and its alt text.
  * config.json — branding.welcome_background_url (created when the baked
    image config has no branding block yet).
  * themes/element/img/logos — element-logo.svg is replaced by the Plotina
    icon, opengraph.png is deleted.

Explicitly out of scope:

  * The noise overlay. The two <script> tags for /noise/ are inserted by the
    Dockerfile *before* this script runs and are left byte-identical here.
  * Other bundle chunks. The built-in Element Call widget keeps its name in
    the shipped JS; only the two error-view strings are rewritten. (The
    theme-*-custom.css sheets are the one non-error-view bundle area the
    brand pass edits, for the contrast fix above.)
  * /app/mobile_guide, /app/plotina-bg.png and the element-app-logo.png
    overwrite: pure file placements, owned by Dockerfile COPY/RM lines.

The four web fixes (custom-theme contrast fallback, plotina-modal-a11y
style, plotina-theme.js bootstrap, ru locale fills) live in the shared
module webapp_fixes.py; element-desktop/branding.py consumes the same
code, and element-desktop/tests/test_webapp_fixes.py proves the parity
— see the PARITY RULE comment at the top of that file.

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

# webapp_fixes.py sits next to this file in the repo and is COPYed to /tmp
# alongside it in the Dockerfile; anchor the import to this file's directory
# so both entry paths (script, importlib) resolve it.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
import webapp_fixes
from webapp_fixes import (
    BUNDLE_LOADER_RE,
    LOCALE_OVERRIDES,
    MODAL_BLOCK,
    MODAL_CSS,
    MODAL_STYLE_ID,
    NOISE_TAGS,
    REQUIRED_CUSTOM_SHEETS,
    DM_ALIASES_FILE,
    THEME_INIT_FILE,
    TIMELINE_TEXT,
    TIMELINE_TEXT_FIXED,
    TIMELINE_TEXT_MIN_USES,
    BrandingError,
    add_missing as _add_missing,
    apply_locales as rebrand_locales,
    apply_theme_css,
    dm_aliases_tag,
    inject_dm_aliases_tag,
    inject_modal_style,
    inject_theme_boot_tag,
    patch_theme_css as rebrand_theme_custom,
    theme_boot_tag,
)

BRAND = "Plotina Web"
THEME_COLOR = "#17795A"
OG_IMAGE = "https://chat.plotina.cc/plotina-512.png"
ICON_SVG = "/plotina-icon.svg"
ICON_192 = "/plotina-icon-192.png"
ERROR_LOGO = "/plotina-512.png"
WELCOME_BG = "/plotina-bg.png"

ICON_LINK = f'<link rel="icon" type="image/svg+xml" href="{ICON_SVG}">'
TOUCH_LINK = f'<link rel="apple-touch-icon" sizes="192x192" href="{ICON_192}">'

# The bootstrap tag the web uses: /app is served from the site root, so the
# src is absolute. (MODAL_*, TIMELINE_*, NOISE_TAGS, BUNDLE_LOADER_RE and
# LOCALE_OVERRIDES come unchanged from webapp_fixes.py; see there for the
# THEME-FIX.md / THEMES.md background of each fix.)
THEME_INIT_TAG = theme_boot_tag(relative=False)
# Same for the DM alias overlay: /app is the site root on the web image.
DM_ALIASES_TAG = dm_aliases_tag(relative=False)


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

    # Modal a11y style and the theme bootstrap tag come from webapp_fixes
    # (shared with element-desktop/branding.py): both are dropped-and-
    # reinserted at fixed anchors, so a re-run on an already-branded tree is
    # byte-stable; the assertions below still pin the end state.
    html = inject_modal_style(html)
    html = inject_theme_boot_tag(html, relative=False)
    html = inject_dm_aliases_tag(html, relative=False)

    for expected in (
        f"<title>{BRAND}</title>",
        f'<meta name="apple-mobile-web-app-title" content="{BRAND}">',
        f'<meta name="application-name" content="{BRAND}">',
        f'<meta name="theme-color" content="{THEME_COLOR}">',
        f'content="{OG_IMAGE}"',
        ICON_LINK,
        TOUCH_LINK,
        f"{BRAND} requires JavaScript to be enabled.",
        MODAL_BLOCK,
        THEME_INIT_TAG,
        DM_ALIASES_TAG,
    ):
        if expected not in html:
            raise BrandingError(f"index.html: {expected!r} missing after rebrand")
    if html.count(MODAL_BLOCK) != 1:
        raise BrandingError("index.html: the modal a11y style is not present "
                            "exactly once")
    if html.count(THEME_INIT_TAG) != 1:
        raise BrandingError("index.html: the theme bootstrap tag is not present "
                            "exactly once")
    if html.count(DM_ALIASES_TAG) != 1:
        raise BrandingError("index.html: the DM alias overlay tag is not present "
                            "exactly once")
    for forbidden in (
        "<title>Element</title>",
        'content="Element"',
        'rel="icon" type="image/png"',
        "vector-icons/",
        "app.element.io",
        "Element requires JavaScript",
        'src="plotina-dm-aliases.js"',
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

    init_js = app / THEME_INIT_FILE
    if not init_js.is_file():
        raise BrandingError(f"{init_js} missing; the Dockerfile COPYs it first")
    aliases_js = app / DM_ALIASES_FILE
    if not aliases_js.is_file():
        raise BrandingError(f"{aliases_js} missing; the Dockerfile COPYs it first")

    before = index.read_text(encoding="utf-8")
    noise_tag = NOISE_TAGS
    index.write_text(rebrand_index(before), encoding="utf-8")
    if noise_tag in before and noise_tag not in index.read_text(encoding="utf-8"):
        raise BrandingError("index.html: the noise overlay tags vanished")
    actions.append("index.html rebranded (title, metas, icons, og:image, "
                   "noscript, modal a11y style, theme bootstrap tag)")

    error_views = sorted((app / "bundles").glob("*/error-view.js"))
    if not error_views:
        raise BrandingError("no bundles/*/error-view.js found; upstream layout moved")
    for chunk in error_views:
        chunk.write_text(rebrand_error_view(chunk.read_text(encoding="utf-8",
                                                            errors="replace")),
                         encoding="utf-8")
    actions.append(f"{len(error_views)} error-view chunk(s) rebranded")

    actions.extend(apply_theme_css(app))

    actions.extend(rebrand_locales(app / "i18n"))

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
