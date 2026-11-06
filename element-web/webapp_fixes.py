#!/usr/bin/env python3
"""Plotina webapp fixes shared by the two Element clients.

PARITY RULE (operator): every fix we ship in the Element Web image must
also ship in Element Desktop. This file is the single source of truth
for those fixes. element-web/branding.py (run on /app inside the
Dockerfile) and element-desktop/branding.py (run on the unpacked
release webapp) both consume these helpers, and
element-desktop/tests/test_webapp_fixes.py feeds identical CSS/HTML
through both entry points and asserts byte-identical output. When you
add a fix here, wire it into both branding scripts and extend that
parity test — never fork a fix into one client.

Everything here is pure string/path work; the one deliberate
desktop-vs-web difference is the tag form: the web image serves /app
from the site root, so its tags use absolute srcs, while the desktop
shell serves the webapp from vector://vector/webapp/, where
root-absolute paths 404 and every tag must be relative (same rule as
the noise tags in element-desktop/apply-noise.py). That difference is
an argument (`relative: bool`), never a second copy of the logic.

Each helper returns human-readable actions or raises BrandingError, so
a build that lost a marker fails loudly instead of quietly shipping
stock behaviour. Background: THEMES.md (contrast fix) and THEME-FIX.md
(modal block) at the repository root.

Contents:

  * patch_theme_css / apply_theme_css — every use of the dead legacy
    --timeline-text-color in bundles/*/theme-{light,dark}-custom.css
    gains a var(--cpd-color-text-primary) fallback (133 uses per sheet
    at v1.12.32). A missing sheet or a dropped count aborts the build:
    without the fallback, dark-OS visitors on the light custom theme
    get light-on-white text.
  * inject_modal_style — the `plotina-modal-a11y` <style> block that
    keeps the device-verification dialog inside the viewport. Present
    exactly once, injected after the bundle.css/theme links. It
    deliberately carries NO .mx_AuthPage_modal margin rule: the stock
    `margin:100px auto auto` auto bottom margin is what pins the auth
    footer gradient to the viewport bottom.
  * theme_boot_tag / inject_theme_boot_tag / ensure_theme_boot —
    plotina-theme.js seeds mx_local_settings.theme for first-visit
    visitors before the app boots, so its tag must sit directly in
    front of the bundles/<hash>/bundle.js loader. The desktop copies
    the payload into the webapp root and references it RELATIVELY;
    the web loads it with an absolute src.
  * add_missing / apply_locales — fill the ru i18n keys upstream still
    lacks, and only where absent, so a future upstream translation
    wins.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


class BrandingError(RuntimeError):
    """A fix did not happen; the build must stop."""


# --------------------------------------------------------------------------
# 1. Custom-theme contrast fix (THEMES.md): theme-{light,dark}-custom.css
# use the dead legacy --timeline-text-color at 133 selectors per sheet,
# always WITHOUT a fallback, so `color` becomes invalid-at-computed-value-
# time and inherits the @media (prefers-color-scheme) tokens from <html>.
# The sibling --timeline-background-color always carries a fallback, which
# is why only the text is broken. Adding --cpd-color-text-primary (which
# resolves through the body's cpd-theme-* class, i.e. the *chosen* theme)
# restores contrast without changing any behaviour. If the variable ever
# becomes defined again, it wins as usual.
# --------------------------------------------------------------------------
TIMELINE_TEXT = "var(--timeline-text-color)"
TIMELINE_TEXT_FIXED = "var(--timeline-text-color,var(--cpd-color-text-primary))"
TIMELINE_TEXT_MIN_USES = 133  # per sheet at element-web v1.12.32
REQUIRED_CUSTOM_SHEETS = frozenset({"theme-light-custom.css",
                                    "theme-dark-custom.css"})


def patch_theme_css(css: str) -> str:
    """Restore body text contrast in one Element custom-theme sheet.

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


def apply_theme_css(root: Path) -> list[str]:
    """Patch both custom sheets under root/bundles/*/ in place."""
    custom_sheets = sorted((root / "bundles").glob("*/theme-*-custom.css"))
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
        sheet.write_text(patch_theme_css(
            sheet.read_text(encoding="utf-8", errors="replace")),
            encoding="utf-8")
    return [f"{len(custom_sheets)} custom-theme sheet(s): "
            "--timeline-text-color fallback added"]


# --------------------------------------------------------------------------
# 2. Device-verification dialog fix (THEME-FIX.md), validated against the
# live chat.plotina.cc bundle 81bff4fd060173d686ec (element-web v1.12.32):
# upstream caps the Glass frame with .mx_Dialog_border{max-height:calc(
# 100% - 48px)}, which resolves through the AuthPage flex chain and cuts
# off the button row ("Sign out") without giving anything a scrollbar.
# The block replaces that cap with a viewport-relative one, scoped to the
# CompleteSecurity Glass so ordinary dialogs keep their own geometry, and
# scrolls the white card internally. See the margin warning in the module
# docstring before "fixing" anything else here.
# --------------------------------------------------------------------------
MODAL_STYLE_ID = "plotina-modal-a11y"
MODAL_CSS = (
    ".mx_AuthPage_modalContent>.mx_Dialog_border{max-height:calc(100vh - 150px)}"
    ".mx_CompleteSecurityBody{overflow-y:auto}"
    # Upstream's home-page quick actions hard-code white text/icons on the
    # accent background. Our dark accent is a light mint, so white-on-mint is
    # ~1.6:1 and unreadable; the on-solid token resolves to the canvas colour
    # (dark on mint in the dark theme, white on the darker light-theme accent).
    ".mx_HomePage_default_buttons .mx_AccessibleButton{color:var(--cpd-color-text-on-solid-primary)}"
    ".mx_HomePage_default_buttons .mx_AccessibleButton svg{color:var(--cpd-color-text-on-solid-primary)}"
)
MODAL_BLOCK = f'<style id="{MODAL_STYLE_ID}">{MODAL_CSS}</style>'
MODAL_BLOCK_RE = re.compile(r'<style id="' + re.escape(MODAL_STYLE_ID)
                            + r'">.*?</style>', re.S)

# The two noise <script> tags as each client inserts them before the brand
# pass runs: absolute on the web image (Dockerfile sed), relative on the
# desktop shell (apply-noise.py). The modal style anchors right in front
# of whichever pair is present so the tag pair stays byte-identical and
# the style lands after bundle.css/theme-*.css (the brand rules win the
# cascade at equal specificity); a stock tree falls back to </head>.
NOISE_TAGS = ('<script src="/noise/logic.js"></script>'
              '<script src="/noise/boot.js" defer></script>')
NOISE_TAGS_RELATIVE = ('<script src="noise/logic.js"></script>'
                       '<script src="noise/boot.js" defer></script>')


def modal_block() -> str:
    """The exact <style> element both clients must ship, byte for byte."""
    return MODAL_BLOCK


def inject_modal_style(html: str) -> str:
    """Put the modal a11y block into an index.html exactly once.

    Idempotent: a previously injected block is dropped and re-inserted at
    the same anchor, so re-running on a branded tree is byte-stable.
    """
    html = MODAL_BLOCK_RE.sub("", html)
    for anchor in (NOISE_TAGS, NOISE_TAGS_RELATIVE):
        if anchor in html:
            return html.replace(anchor, MODAL_BLOCK + anchor, 1)
    if "</head>" not in html:
        raise BrandingError("index.html: neither the noise tag pair nor a "
                            "</head> exists to anchor the modal a11y style; "
                            "upstream layout moved")
    return html.replace("</head>", MODAL_BLOCK + "</head>", 1)


# --------------------------------------------------------------------------
# 3. First-visit theme bootstrap (THEMES.md part 2). plotina-theme.js seeds
# mx_local_settings.theme with the Plotina custom theme matching
# prefers-color-scheme for fresh visitors only; it must run before
# bundles/<hash>/bundle.js, so its tag is anchored directly in front of
# that loader. The payload file lives in element-web/ for BOTH clients:
# the Dockerfile COPYs it into /app; element-desktop/branding.py copies it
# from ../element-web into the webapp root (vector:// serves only paths
# below /webapp/, hence the relative src there).
# --------------------------------------------------------------------------
THEME_INIT_FILE = "plotina-theme.js"
BUNDLE_LOADER_RE = re.compile(r'<script src="bundles/[^"]+/bundle\.js"></script>')


def theme_boot_tag(relative: bool) -> str:
    """The <script> tag for the bootstrap: absolute on web, relative here."""
    src = THEME_INIT_FILE if relative else f"/{THEME_INIT_FILE}"
    return f'<script src="{src}"></script>'


def inject_theme_boot_tag(html: str, relative: bool) -> str:
    """Anchor the bootstrap tag before the bundle loader, exactly once.

    Idempotent: both tag forms are stripped first and the chosen one is
    re-inserted, so a second run is byte-identical and a client flip
    (absolute -> relative) converges. Anchoring on the loader (not
    </head>) leaves the noise pair and the modal style above it alone.
    """
    for tag in (theme_boot_tag(True), theme_boot_tag(False)):
        html = html.replace(tag, "")
    tag = theme_boot_tag(relative)
    html, hits = BUNDLE_LOADER_RE.subn(lambda m: tag + m.group(0), html, 1)
    if hits != 1:
        raise BrandingError("index.html: the bundles/<hash>/bundle.js loader "
                            "<script> is not there to anchor the theme "
                            "bootstrap tag; upstream index layout moved")
    return html


def ensure_theme_boot(root: Path, relative: bool) -> list[str]:
    """root/plotina-theme.js exists and index.html loads it before the bundle.

    Placing the payload is the caller's job (web: Dockerfile COPY, desktop:
    branding.py copying it from ../element-web); this verifies it landed
    and wires the tag, so a missing file never turns into a 404 at runtime.
    """
    payload = root / THEME_INIT_FILE
    if not payload.is_file():
        raise BrandingError(f"{payload} missing; the theme bootstrap payload "
                            "must be placed at the webapp root before this "
                            "runs (web: the Dockerfile COPYs it, desktop: "
                            "branding.py copies it from ../element-web)")
    index = root / "index.html"
    if not index.is_file():
        raise BrandingError(f"{index} missing; {root} is not an Element webapp root")
    html = index.read_text(encoding="utf-8")
    patched = inject_theme_boot_tag(html, relative=relative)
    if patched != html:
        index.write_text(patched, encoding="utf-8")
    return [f"index.html: {THEME_INIT_FILE} loads before bundles/*/bundle.js "
            f"({'relative' if relative else 'absolute'} src)"]


# --------------------------------------------------------------------------
# 4. Russian strings the upstream ru locale still lacks for the
# after-new-login verification dialog (keys per element-web's hierarchical
# i18n JSON). Inserted only where absent: once Crowdin ships its own
# translation, apply_locales() stops touching it.
# --------------------------------------------------------------------------
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


def add_missing(dst: dict, src: dict, path: str = "") -> list[str]:
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
            added.extend(add_missing(target, value, here))
        elif key not in dst:
            dst[key] = value
            added.append(here)
    return added


def apply_locales(i18n: Path) -> list[str]:
    """Fill the known-missing Russian verification strings in an i18n tree.

    i18n/languages.json maps a language to its hashed filename (e.g.
    "ru.a625131.json"); the JSON is served with no-cache + ETag on the web
    and unpacked read-only from the asar on desktop, so the content is
    patched in place under the existing name.
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
        added = add_missing(data, overrides)
        if added:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n",
                            encoding="utf-8")
            for dotted in added:
                actions.append(f"i18n/{name}: added {dotted.split('|')[-1]!r}")
    return actions
