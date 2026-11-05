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

# The two noise <script> tags the Dockerfile inserts before this script runs;
# rebrand_index() anchors the modal style right in front of them when they are
# there (and before </head> otherwise) so the tag pair itself stays byte-identical.
NOISE_TAGS = ('<script src="/noise/logic.js"></script>'
              '<script src="/noise/boot.js" defer></script>')

# Device-verification dialog fix, validated against the live chat.plotina.cc
# bundle 81bff4fd060173d686ec (element-web v1.12.32), see THEME-FIX.md:
#   * do NOT override .mx_AuthPage_modal margins: stock `margin:100px auto auto`
#     keeps the auto bottom margin that pins .mx_AuthFooter (the dark gradient
#     behind the footer links) to the viewport bottom; any explicit
#     margin-bottom glues that gradient to the card instead of the screen edge,
#   * replace the percentage max-height that resolves through the AuthPage
#     flex chain (upstream assumes a fixed-position .mx_Dialog_wrapper parent)
#     with a viewport-relative one, scoped to the CompleteSecurity Glass so
#     ordinary dialogs keep their own geometry,
#   * scroll the white card internally so the button row ("Use recovery key",
#     "Sign out") always stays reachable on ~1366x768 laptops.
MODAL_STYLE_ID = "plotina-modal-a11y"
MODAL_CSS = (
    ".mx_AuthPage_modalContent>.mx_Dialog_border{max-height:calc(100vh - 150px)}"
    ".mx_CompleteSecurityBody{overflow-y:auto}"
)
MODAL_BLOCK = f'<style id="{MODAL_STYLE_ID}">{MODAL_CSS}</style>'

# Custom-theme contrast fix, see THEMES.md: theme-{light,dark}-custom.css
# use the dead legacy --timeline-text-color at 133 selectors per sheet,
# always WITHOUT a fallback, so text colour falls through to inheritance
# from <html> — whose tokens flip with prefers-color-scheme. The sibling
# --timeline-background-color always carries a fallback; this restores the
# same pattern for the text.
TIMELINE_TEXT = "var(--timeline-text-color)"
TIMELINE_TEXT_FIXED = "var(--timeline-text-color,var(--cpd-color-text-primary))"
TIMELINE_TEXT_MIN_USES = 133  # per sheet at element-web v1.12.32
REQUIRED_CUSTOM_SHEETS = frozenset({"theme-light-custom.css",
                                    "theme-dark-custom.css"})

# First-visit theme bootstrap (part 2 of the fix): the script file is
# COPYed into /app by the Dockerfile; branding.py injects its tag directly
# in front of the bundle loader and refuses to run without the payload.
THEME_INIT_FILE = "plotina-theme.js"
THEME_INIT_TAG = f'<script src="/{THEME_INIT_FILE}"></script>'
BUNDLE_LOADER_RE = re.compile(r'<script src="bundles/[^"]+/bundle\.js"></script>')

# Russian strings the upstream ru locale still lacks for the
# after-new-login verification dialog (keys per element-web's hierarchical
# i18n JSON). Inserted only where absent: once upstream ships its own
# translation, rebrand_locales() stops touching it.
LOCALE_OVERRIDES: dict[str, dict] = {
    "ru": {
        "action": {
            "sign_out_before_verify": "Выйти",
        },
        "encryption": {
            "verification": {
                "no_other_devices":
                    "Этот параметр недоступен, потому что у вас нет других устройств",
                "no_recovery_key":
                    "Этот параметр недоступен, потому что вы ещё не настроили "
                    "ключ восстановления",
            },
        },
    },
}


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

    # Modal a11y style: drop a previously injected block first so re-running
    # on an already-branded tree is a no-op, then insert exactly one, directly
    # in front of the noise tags (which must stay byte-identical) or before
    # </head> on a stock tree. After bundle.css/theme-*.css in every case, so
    # the brand rules win the cascade at equal specificity.
    html = re.sub(r'<style id="' + re.escape(MODAL_STYLE_ID)
                  + r'">.*?</style>', "", html, flags=re.S)
    if NOISE_TAGS in html:
        html = html.replace(NOISE_TAGS, MODAL_BLOCK + NOISE_TAGS, 1)
    else:
        html = html.replace("</head>", MODAL_BLOCK + "</head>", 1)

    # Theme bootstrap: /plotina-theme.js must run before the bundle loader,
    # so its tag goes directly in front of that <script>. Drop a previously
    # injected tag first, then re-insert: a second run is byte-identical.
    # Anchoring on the loader (not </head>) leaves the noise pair and the
    # modal style above it exactly as they are.
    html = html.replace(THEME_INIT_TAG, "")
    html, loader_hits = BUNDLE_LOADER_RE.subn(
        lambda m: THEME_INIT_TAG + m.group(0), html, 1)
    if loader_hits != 1:
        raise BrandingError("index.html: the bundles/<hash>/bundle.js loader "
                            "<script> is not there to anchor the theme "
                            "bootstrap tag; upstream index layout moved")

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
    ):
        if expected not in html:
            raise BrandingError(f"index.html: {expected!r} missing after rebrand")
    if html.count(MODAL_BLOCK) != 1:
        raise BrandingError("index.html: the modal a11y style is not present "
                            "exactly once")
    if html.count(THEME_INIT_TAG) != 1:
        raise BrandingError("index.html: the theme bootstrap tag is not present "
                            "exactly once")
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


def rebrand_theme_custom(css: str) -> str:
    """Restore body text contrast in Element's custom-theme sheets.

    Upstream theme-{light,dark}-custom.css reference the dead legacy variable
    --timeline-text-color WITHOUT a fallback (133 uses, 0 definitions in the
    whole distro), so `color` becomes invalid-at-computed-value-time and
    inherits the @media (prefers-color-scheme) tokens from <html>: dark-OS
    visitors see light-on-white text. The sibling --timeline-background-color
    always carries a fallback, which is why only the text is broken. Adding
    --cpd-color-text-primary (which resolves through the body's cpd-theme-*
    class, i.e. the *chosen* theme) restores contrast without changing any
    behaviour. If the variable ever becomes defined again, it wins as usual.
    See THEMES.md.

    Idempotent: patched sheets pass through unchanged. Sheets that do not
    carry the expected 133 uses fail loudly — a moved upstream layout must
    abort the build, not ship half-fixed CSS.
    """
    if TIMELINE_TEXT not in css and TIMELINE_TEXT_FIXED in css:
        return css  # already patched; re-run is a no-op
    out = css.replace(TIMELINE_TEXT, TIMELINE_TEXT_FIXED)
    if TIMELINE_TEXT in out:
        raise BrandingError("custom theme CSS: --timeline-text-color survived")
    if out.count(TIMELINE_TEXT_FIXED) < TIMELINE_TEXT_MIN_USES:
        raise BrandingError(f"custom theme CSS: expected >={TIMELINE_TEXT_MIN_USES} "
                            f"fallback additions, got {out.count(TIMELINE_TEXT_FIXED)}")
    return out


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


def _add_missing(dst: dict, src: dict, path: str = "") -> list[str]:
    """Recursively copy leaf strings from *src* into *dst* where absent.

    Returns the dotted keys that were added. Existing upstream translations
    are never overwritten, so this stays a no-op once Crowdin catches up.
    """
    added: list[str] = []
    for key, value in src.items():
        here = f"{path}|{key}" if path else key
        if isinstance(value, dict):
            target = dst.get(key)
            if not isinstance(target, dict):
                target = {}
                dst[key] = target
            added.extend(_add_missing(target, value, here))
        elif key not in dst:
            dst[key] = value
            added.append(here)
    return added


def rebrand_locales(i18n: Path) -> list[str]:
    """Fill the known-missing Russian verification strings in /app/i18n.

    i18n/languages.json maps a language to its hashed filename (e.g.
    "ru.a625131.json"); the JSON itself is served with no-cache + ETag, so
    the content is patched in place under the existing name.
    """
    manifest_file = i18n / "languages.json"
    if not manifest_file.is_file():
        raise BrandingError(f"i18n/languages.json: {manifest_file} does not "
                            "exist; upstream i18n layout moved")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BrandingError(f"i18n/languages.json: cannot parse: {exc}") from exc
    actions: list[str] = []
    for lang, overrides in LOCALE_OVERRIDES.items():
        name = manifest.get(lang)
        if not name:
            raise BrandingError(f"i18n/languages.json: no entry for {lang!r}")
        path = i18n / name
        if not path.is_file():
            raise BrandingError(f"i18n: {lang} file {name} is missing from {i18n}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BrandingError(f"i18n/{name}: cannot parse: {exc}") from exc
        if not isinstance(data, dict):
            raise BrandingError(f"i18n/{name}: top level is not an object")
        added = _add_missing(data, overrides)
        if added:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n",
                            encoding="utf-8")
            for dotted in added:
                actions.append(f"i18n/{name}: added {dotted.split('|')[-1]!r}")
    return actions


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

    custom_sheets = sorted((app / "bundles").glob("*/theme-*-custom.css"))
    if not custom_sheets:
        raise BrandingError("no bundles/*/theme-*-custom.css found; upstream "
                            "layout moved")
    by_dir: dict[Path, set[str]] = {}
    for sheet in custom_sheets:
        by_dir.setdefault(sheet.parent, set()).add(sheet.name)
    for bdir, found in sorted(by_dir.items()):
        missing = REQUIRED_CUSTOM_SHEETS - found
        if missing:
            raise BrandingError(f"{bdir} is missing {' and '.join(sorted(missing))}; "
                                "expected both bundles/*/theme-*-custom.css sheets")
    for sheet in custom_sheets:
        sheet.write_text(rebrand_theme_custom(
            sheet.read_text(encoding="utf-8", errors="replace")),
            encoding="utf-8")
    actions.append(f"{len(custom_sheets)} custom-theme sheet(s): "
                   "--timeline-text-color fallback added")

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
