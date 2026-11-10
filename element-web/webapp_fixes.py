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

  * patch_theme_css / apply_theme_css — the legacy custom-theme tokens the
    Compound migration dropped (41 names used in each
    bundles/*/theme-{light,dark}-custom.css, none declared anywhere). Each one
    is either DEFINED from the stock sibling sheet's own CPD token,
    DROPPED in favour of the fallback every use already carries, or left
    undefined on purpose (per-element/config hooks). The pass ends with
    audit_webapp(), which fails the build on any custom property used without
    a fallback that nothing in the shipped CSS defines — including one a new
    upstream sheet introduces. A missing sheet or a bare use of a dropped
    token aborts the build.
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
# 1. Custom-theme legacy tokens (THEMES.md): theme-{light,dark}-custom.css
# were generated from the legacy Sass theme, so their rules still talk to
# custom properties the Compound migration dropped. 41 names are used in each
# sheet and declared NOWHERE (no CSS layer, no JS); 19 of them are used
# without a fallback, which makes the declaration invalid-at-computed-value-
# time (`color:var(--timeline-text-color)` -> inherit).
#
# Three answers, all decided per variable in the table below (the full
# evidence -- selector, property, stock counterpart, reason -- is in
# THEME-TOKENS.md):
#
#   LEGACY_TOKEN_VALUES          the token is still the right indirection and
#                                only lost its value -> define it here, in the
#                                sheet itself, so it only exists while the
#                                custom theme is active. Every value is derived
#                                from the stock sibling sheet: theme-<mode>.css
#                                contains the SAME selector and property with
#                                the CPD token the custom sheet was supposed to
#                                resolve to. Nothing is invented; the only hand
#                                work is choosing between the 1-2 places where
#                                stock itself is inconsistent (documented).
#   LEGACY_TOKEN_DROPPED         every use already carries the stock CPD
#                                expression as its own fallback, so the dead
#                                indirection is removed instead of redefined:
#                                `var(--x,FALLBACK)` -> `FALLBACK`. This keeps
#                                per-use fallbacks (the pill has a different
#                                one per :hover/:active state) that a single
#                                definition would flatten.
#
# Nothing is left undefined on purpose. The four non-colour hooks (font
# stacks, per-image reserved height, line clamp) are DEFINED with the very
# expression their uses already fall back to, copied out of the sheet, so the
# computed value cannot move; the inline style Element writes for a configured
# font or a measured image still wins. That keeps the invariant total -- after
# this pass no custom property of the sheet is used without being declared --
# instead of an allow-list that would grow with every upstream release.
#
# The block is appended to the END of each sheet, inside the already declared
# `@layer app-web`, as `body,[class*="cpd-theme-"]{...}`. body is the element
# Element puts the cpd-theme-* class on (never <html>), so referencing
# --cpd-color-* there resolves per selected theme, and every app rule inherits
# the computed value. Custom-property substitution happens at the element that
# declares the property, which is exactly why this cannot live on :root.
# --------------------------------------------------------------------------
THEME_TOKEN_START = "/* plotina-theme-tokens: legacy custom-theme tokens. */"
THEME_TOKEN_END = "/* end plotina-theme-tokens */"

# One value serves both sheets unless the stock sheets disagree; the handful of
# overrides live in LEGACY_TOKEN_VALUES_DARK. Format: --name: value;
LEGACY_TOKEN_VALUES: dict[str, str] = {
    # --- text ---------------------------------------------------------
    # stock: var(--cpd-color-text-primary) in 131/133 declarations (the other
    # two are the auth-body heading, where stock uses text-secondary).
    "--timeline-text-color": "var(--cpd-color-text-primary)",
    # stock: var(--cpd-color-gray-900) 19/29, text-secondary 4/29, #747474 5/29.
    # gray-900 is the raw step Element itself still uses for muted copy here.
    "--timeline-text-secondary-color": "var(--cpd-color-gray-900)",
    # 50%-transparent counterpart of the text token (poll "edited", typing
    # indicator); stock uses #9e9e9e(light)/#b9bec6(dark) -- see DARK.
    "--timeline-text-color-50pct": "var(--cpd-color-gray-700)",
    # stock: var(--cpd-color-text-secondary) 139/141.
    "--secondary-content": "var(--cpd-color-text-secondary)",
    # stock: var(--cpd-color-gray-800) 39/40.
    "--tertiary-content": "var(--cpd-color-gray-800)",
    # stock: var(--cpd-color-gray-600) 14/14.
    "--quaternary-content": "var(--cpd-color-gray-600)",
    # stock: var(--cpd-color-gray-400) 43/43 (icons and hairlines).
    "--quinary-content": "var(--cpd-color-gray-400)",
    # stock: var(--cpd-color-text-critical-primary) 39/39.
    "--alert": "var(--cpd-color-text-critical-primary)",
    # --- accent / links ------------------------------------------------
    # Element writes --accent-color/--primary-color as INLINE body styles from
    # config.json's custom_themes[].colors (theme.ts applyCustomTheme), which
    # always beat these declarations; the block only gives the static CSS a
    # brand value instead of nothing (and covers the loading window).
    "--accent-color": "var(--cpd-color-text-action-accent)",
    "--primary-color": "var(--cpd-color-text-action-accent)",
    # stock: var(--cpd-color-text-link-external) 7/7 -- Element's own link
    # colour, deliberately not the accent (external links read as links).
    "--links": "var(--cpd-color-text-link-external)",
    # The legacy accent ramp; stock maps them to the Compound green scale that
    # our compound overrides already re-tint.
    "--accent-color-300": "var(--cpd-color-green-300)",
    "--accent-color-400": "var(--cpd-color-green-400)",
    "--accent-color-1000": "var(--cpd-color-green-1000)",
    # --- surfaces ------------------------------------------------------
    # stock: var(--cpd-color-bg-subtle-secondary) 11/11.
    "--panels": "var(--cpd-color-bg-subtle-secondary)",
    # stock: bg-subtle-secondary 4/5 for the event-tile state backgrounds.
    "--timeline-highlights-color": "var(--cpd-color-bg-subtle-secondary)",
    # stock: var(--cpd-color-alpha-gray-300) 6/6 (selected space button).
    "--roomlist-highlights-color": "var(--cpd-color-alpha-gray-300)",
    # stock: bg-subtle-primary 7/14 light, bg-subtle-secondary 11/14 dark.
    "--roomlist-background-color": "var(--cpd-color-bg-subtle-primary)",
    # stock: bg-subtle-primary 15-17/18 light, bg-subtle-secondary dark.
    "--system": "var(--cpd-color-bg-subtle-primary)",
    # stock uses a bare literal (hsla(0,0%,91%,.77) light / rgba(38,39,43,.82)
    # dark): the space-panel surface at ~90% opacity. bg-subtle-primary is the
    # same ramp Element uses for panels -- dark matches the literal within 2/255.
    "--sidebar-color": "var(--cpd-color-bg-subtle-primary)",
    # stock: literal #030c1b4d / #00000080 (dialog scrim); no themeable token
    # exists, so keep Element's own values per sheet -- see DARK.
    "--sidebar-color-50pct": "#030c1b4d",
    # stock: literal #f5f8fa / #343a46 (selected menu row); per sheet.
    "--menu-selected-color": "#f5f8fa",
    # stock: bg-subtle-primary light / #343a46 dark; per sheet.
    "--focus-bg-color": "var(--cpd-color-bg-subtle-primary)",
    # The auth card's 90%-opaque canvas. Stock hard-codes hsla(0,0%,96%,.9) in
    # BOTH sheets, i.e. a near-white card in the dark theme as well (light text
    # on white); expressing the intent against the canvas token fixes the dark
    # theme and leaves light unchanged.
    "--timeline-background-color-50pct":
        "color-mix(in srgb,var(--cpd-color-bg-canvas-default) 90%,transparent)",
    # --- borders / hairlines --------------------------------------------
    # stock: bg-subtle-secondary 2/2.
    "--eventbubble-bg-hover": "var(--cpd-color-bg-subtle-secondary)",
    "--eventbubble-others-bg": "var(--cpd-color-gray-300)",
    "--eventbubble-self-bg": "var(--cpd-color-green-300)",
    # stock: var(--cpd-color-gray-300) 1/1 (inputs inside dialogs).
    "--secondary-hairline-color": "var(--cpd-color-gray-300)",
    # stock: border-interactive-primary (the same declaration's stock value).
    "--strong-input-border-color": "var(--cpd-color-border-interactive-primary)",
    # Separators. Stock resolves 11/15 of these to `transparent` -- modern
    # Element's composer/autocomplete deliberately have no hairlines -- and the
    # remaining 4 to gray-400 (outlined radio, bridge-list icons). Defining the
    # transparent majority keeps today's look (the IACVT rule draws no border
    # either); the 4 gray-400 hairline spots stay invisible, as in prod today.
    "--roomlist-separator-color": "transparent",
    # --- vendored markdown CSS (github-markdown-css) ---------------------
    # These four are Primer token names used only by .markdown-body rules, and
    # they are equally undefined in Element's own theme-light/theme-dark.css
    # (stock value is literally `var(--borderColor-muted)` again). Defining
    # them to the CPD semantic makes kbd borders and the markdown focus ring
    # work again in our themes without touching any Element rule.
    "--borderColor-muted": "var(--cpd-color-border-interactive-secondary)",
    "--borderColor-accent-emphasis": "var(--cpd-color-border-focused)",
    "--bgColor-danger-muted": "var(--cpd-color-bg-critical-subtle)",
    "--fgColor-danger": "var(--cpd-color-text-critical-primary)",
    # --- config / per-element hooks --------------------------------------
    # Not theme colours: Element writes these as INLINE styles -- the font
    # stacks from config.json custom_themes[].fonts (ThemeWatcher), the image
    # height from ImageBody, the clamp from .mx_lineClamp's consumer. Inline
    # beats this block, so the definition only replaces the fallback each use
    # already carries, and it is the identical expression copied out of the
    # sheet, so nothing can move. --font-family must NOT be defined from
    # --cpd-font-family-sans: that token is itself `var(--font-family,...)`,
    # which would be a cycle; the literal stack is the safe direction.
    "--font-family":
        '"Nunito",var(--emoji-font-family),"Apple Color Emoji",'
        '"Segoe UI Emoji","Arial","Helvetica",sans-serif,"Noto Color Emoji"',
    "--font-family-monospace":
        '"Fira Code",var(--emoji-font-family),"Apple Color Emoji",'
        '"Segoe UI Emoji","Courier",monospace,"Noto Color Emoji"',
    # `min-height:var(--mx-image-reserved-height,0)` keeps the reserved slot
    # collapsed until the image reports its height inline.
    "--mx-image-reserved-height": "0",
    # `-webkit-line-clamp:var(--mx-line-clamp,1)`: the default for the
    # non-clamped case, overridden inline where clamping applies.
    "--mx-line-clamp": "1",
}

# Values that differ between the two sheets (stock disagrees by theme).
LEGACY_TOKEN_VALUES_DARK: dict[str, str] = {
    "--timeline-text-color-50pct": "var(--cpd-color-gray-1200)",
    "--roomlist-background-color": "var(--cpd-color-bg-subtle-secondary)",
    "--system": "var(--cpd-color-bg-subtle-secondary)",
    "--sidebar-color-50pct": "#00000080",
    "--menu-selected-color": "#343a46",
    "--focus-bg-color": "var(--cpd-color-gray-500)",
}

# Dead indirections whose every use already ends in the stock CPD expression:
# drop the variable, keep the fallback. `var(--x,FALLBACK)` -> `FALLBACK`.
LEGACY_TOKEN_DROPPED: dict[str, str] = {
    "--timeline-background-color":
        "66/66 uses fall back to var(--cpd-color-bg-canvas-default), the exact "
        "value stock uses for the same declaration",
    "--icon-button-color":
        "13/13 uses fall back to var(--cpd-color-icon-tertiary), stock's value",
    "--other-user-pill-bg-color":
        "5/5 uses carry the stock CPD token, and it differs per state "
        "(rest/hovered/pressed) -- one definition would flatten them",
}

# Intentionally left undefined: nothing. Every legacy name is either defined
# from stock or rewritten to its own fallback (see LEGACY_TOKEN_DROPPED); the
# audit enforces that with no allow-list, so a new upstream token cannot slip
# through as "known undefined".

LEGACY_TOKENS = frozenset(LEGACY_TOKEN_VALUES) | frozenset(LEGACY_TOKEN_DROPPED)
REQUIRED_CUSTOM_SHEETS = frozenset({"theme-light-custom.css",
                                    "theme-dark-custom.css"})


def token_block(sheet_name: str) -> str:
    """The definition block for one custom sheet, marker-delimited."""
    values = dict(LEGACY_TOKEN_VALUES)
    if sheet_name == "theme-dark-custom.css":
        values.update(LEGACY_TOKEN_VALUES_DARK)
    decls = "".join(f"{name}:{value};" for name, value in values.items())
    return (f"{THEME_TOKEN_START}\n"
            f"@layer app-web{{body,[class*=\"cpd-theme-\"]{{{decls}}}}}\n"
            f"{THEME_TOKEN_END}")


def _var_uses(css: str):
    """Yield (start, end, name, fallback) for every var() in *css*.

    *fallback* is the raw text after the first top-level comma, or None.
    Balanced-paren aware, so nested var() fallbacks survive intact.
    """
    pos = 0
    while True:
        start = css.find("var(", pos)
        if start < 0:
            return
        depth, i = 1, start + 4
        while i < len(css) and depth:
            if css[i] == "(":
                depth += 1
            elif css[i] == ")":
                depth -= 1
            i += 1
        inner = css[start + 4:i - 1]
        name, sep, fallback = inner.partition(",")
        yield start, i, name.strip(), (fallback.strip() if sep else None)
        pos = i


def drop_indirection(css: str, name: str) -> tuple[str, int]:
    """Replace every `var(--name,FALLBACK)` with `FALLBACK` in *css*.

    A bare `var(--name)` cannot be rewritten (there is nothing to substitute)
    and means upstream changed the sheet shape: that aborts the build.
    """
    pieces: list[str] = []
    last = 0
    count = 0
    for start, end, used, fallback in _var_uses(css):
        if used != name:
            continue
        if fallback is None:
            raise BrandingError(
                f"custom theme CSS: bare var({name}) -- it has no fallback to "
                "keep and no definition on purpose; upstream changed the sheet")
        pieces.append(css[last:start])
        pieces.append(fallback)
        last = end
        count += 1
    pieces.append(css[last:])
    return "".join(pieces), count


def strip_token_block(css: str) -> str:
    """Remove a previously appended block (so a re-run is byte-stable)."""
    while True:
        start = css.find(THEME_TOKEN_START)
        if start < 0:
            return css
        end = css.find(THEME_TOKEN_END, start)
        if end < 0:
            raise BrandingError("custom theme CSS: unterminated "
                                "plotina-theme-tokens block")
        end += len(THEME_TOKEN_END)
        # Swallow exactly the newlines _insert_block() puts around the block.
        if start and css[start - 1] == "\n":
            start -= 1
        if end < len(css) and css[end] == "\n":
            end += 1
        css = css[:start] + css[end:]


def _insert_block(css: str, block: str) -> str:
    """Put *block* at the end of the sheet, before the sourceMappingURL note."""
    anchor = css.rfind("/*# sourceMappingURL=")
    if anchor < 0:
        return css.rstrip("\n") + "\n" + block + "\n"
    head, tail = css[:anchor].rstrip("\n"), css[anchor:]
    return head + "\n" + block + "\n" + tail


def patch_theme_css(css: str, sheet_name: str = "theme-light-custom.css") -> str:
    """Define/remove the legacy tokens of one Element custom-theme sheet.

    Idempotent by construction: the previous block is stripped before the new
    one is appended. Fails loudly when the sheet no longer looks like the one
    this table was derived from (no legacy token left at all, or a dropped
    variable used bare), so an upstream restructure never ships half-fixed CSS.
    """
    out = strip_token_block(css)
    present = {name for _, _, name, _ in _var_uses(out)}
    if not present & LEGACY_TOKENS:
        raise BrandingError(
            "custom theme CSS: none of the legacy custom-theme tokens is used; "
            "is this really theme-*-custom.css? upstream layout moved")

    dropped = 0
    for name in LEGACY_TOKEN_DROPPED:
        # A missing use is not an error: upstream may have dropped the token
        # from the sheet (then there is nothing to rewrite), and a use that
        # became bare is still caught by drop_indirection below.
        out, count = drop_indirection(out, name)
        dropped += count

    out = _insert_block(out, token_block(sheet_name))

    audit_sheet(out)
    return out


def _declared(css: str) -> set[str]:
    return set(re.findall(r"(--[A-Za-z0-9_-]+)\s*:", css))


def undefined_uses(css: str, defined: set[str] | None = None) -> list[str]:
    """Names used bare (no fallback) and not declared in *css* itself."""
    declared = _declared(css) if defined is None else defined
    out = []
    for _, _, name, fallback in _var_uses(css):
        if fallback is None and name not in declared:
            out.append(name)
    return sorted(set(out))


def audit_sheet(css: str) -> None:
    """One sheet: no legacy token may be used bare and undefined.

    Only the legacy names are checked here: the Compound tokens the block
    references are declared in bundle.css, i.e. outside this file, and the
    whole-app check in audit_webapp() covers those.
    """
    declared = _declared(css)
    bad = [name for name in undefined_uses(css, declared) if name in LEGACY_TOKENS]
    if bad:
        raise BrandingError("custom theme CSS: undefined custom propert"
                            f"{'ies' if len(bad) > 1 else 'y'} used without a "
                            f"fallback: {', '.join(bad)}")


def _require_sheet_pairs(custom_sheets: list[Path]) -> None:
    """Both custom sheets must exist side by side in every bundle directory.

    Shared by the patch pass and by the audit: the standalone CLI
    (scripts/check-theme-tokens.py) runs only the audit, and a tree that lost
    one sheet must fail there too, not just when the brand pass happens to run
    first.
    """
    by_dir: dict[Path, set[str]] = {}
    for sheet in custom_sheets:
        by_dir.setdefault(sheet.parent, set()).add(sheet.name)
    for bdir, found in sorted(by_dir.items()):
        missing = REQUIRED_CUSTOM_SHEETS - found
        if missing:
            raise BrandingError(f"{bdir} is missing {' and '.join(sorted(missing))}; "
                                "expected both bundles/*/theme-*-custom.css sheets")


def apply_theme_css(root: Path) -> list[str]:
    """Patch both custom sheets under root/bundles/*/ in place."""
    custom_sheets = sorted((root / "bundles").glob("*/theme-*-custom.css"))
    if not custom_sheets:
        raise BrandingError("no bundles/*/theme-*-custom.css found; upstream "
                            "layout moved")
    _require_sheet_pairs(custom_sheets)
    for sheet in custom_sheets:
        sheet.write_text(patch_theme_css(
            sheet.read_text(encoding="utf-8", errors="replace"), sheet.name),
            encoding="utf-8")
    # Whole-app regression guard: both clients get it for free because this is
    # the single entry point (web branding.py and desktop branding.py).
    audit_webapp(root)
    return [f"{len(custom_sheets)} custom-theme sheet(s): "
            f"{len(LEGACY_TOKEN_VALUES)} legacy token(s) defined, "
            f"{len(LEGACY_TOKEN_DROPPED)} dead indirection(s) removed"]


def audit_webapp(root: Path) -> list[str]:
    """Fail unless the built app defines every custom property it uses bare.

    This is the regression guard, not a byte-check of our own block: it walks
    every CSS the app ships (all bundles plus the <style> blocks in
    index.html), so a NEW upstream sheet that starts using an undefined
    variable without a fallback -- exactly the bug this module exists for --
    stops the build even though no file of ours mentions that name.

    Rules:
      * every `var(--x)` without a fallback must be declared somewhere in the
        app CSS (this module's block counts, because it is part of the sheet);
      * each LEGACY_TOKEN_VALUES name must be declared (the block is present);
      * no LEGACY_TOKEN_DROPPED name may be used or defined any more;
      * both custom sheets must carry the block markers.
    """
    index = root / "index.html"
    if not index.is_file():
        raise BrandingError(f"{index} missing; {root} is not an Element webapp root")
    sheets = sorted((root / "bundles").glob("*/theme-*-custom.css"))
    if not sheets:
        raise BrandingError("no bundles/*/theme-*-custom.css found; upstream "
                            "layout moved")
    _require_sheet_pairs(sheets)

    chunks: list[str] = [index.read_text(encoding="utf-8", errors="replace")]
    for css_file in sorted(root.glob("bundles/**/*.css")):
        chunks.append(css_file.read_text(encoding="utf-8", errors="replace"))
    everything = "\n".join(chunks)
    declared = _declared(everything)

    # Scope: the two custom sheets. Those are the sheets we patch, and the
    # only ones whose rules we are responsible for; the vendored chunks carry
    # their own upstream dead references (bundle.css/9512.css use
    # --cpd-color-body-primary, --cpd-color-text-placeholder, grid-* element
    # hooks ... with no definition) that are not ours to fix. A NEW undefined
    # variable in a custom sheet -- the regression this guards -- still fails.
    # No allow-list: every legacy name is defined or dropped, so a sheet that
    # needs an exception is a bug in this table, not something to wave through.
    bad: list[str] = []
    for sheet in sheets:
        text = sheet.read_text(encoding="utf-8", errors="replace")
        bad.extend(undefined_uses(text, declared))
        if THEME_TOKEN_START not in text or THEME_TOKEN_END not in text:
            raise BrandingError(f"{sheet}: plotina-theme-tokens block missing")
        # Each sheet is enabled on its own, so each must carry the definitions
        # itself -- a definition in the other theme's sheet does not help.
        missing = sorted(set(LEGACY_TOKEN_VALUES) - _declared(text))
        if missing:
            raise BrandingError(
                f"{sheet.name} does not define: " + ", ".join(missing))
    bad = sorted(set(bad))
    if bad:
        raise BrandingError(
            "custom theme sheets use custom propert"
            f"{'ies' if len(bad) > 1 else 'y'} that nothing defines and that "
            f"have no fallback: {', '.join(bad)}")

    resurrected = sorted(set(LEGACY_TOKEN_DROPPED) & (declared |
                                                      set(uses_named(everything))))
    if resurrected:
        raise BrandingError("dropped legacy tokens are back: "
                            + ", ".join(resurrected))
    return [f"theme token audit: {len(declared)} custom properties declared, "
            f"0 undefined bare uses in {len(sheets)} custom sheet(s)"]


def uses_named(css: str) -> list[str]:
    """Every custom-property name referenced through var(), with or without fallback."""
    return sorted({name for _, _, name, _ in _var_uses(css)})


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
# 3. Theme bootstrap (THEMES.md part 2). plotina-theme.js seeds
# mx_local_settings.theme with the Plotina custom theme matching
# prefers-color-scheme for fresh visitors, and rewrites a theme id saved
# before the Mint Light/Mint Dark rename; it must run before
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
# 3b. Personal room names (SPIKE-dm-aliases.md): plotina-dm-aliases.js keeps
# a room_id -> label map in account data cc.plotina.room_aliases and makes
# Room.calculateRoomName answer with it, so a DM can be renamed for one
# account without writing m.room.name into the room. The payload is inert
# until window.mxMatrixClientPeg appears, so its tag only has to be in the
# document; </head> is the anchor both clients can guarantee.
# --------------------------------------------------------------------------
DM_ALIASES_FILE = "plotina-dm-aliases.js"


def dm_aliases_tag(relative: bool) -> str:
    """The <script> tag for the alias overlay: absolute on web, relative here."""
    src = DM_ALIASES_FILE if relative else f"/{DM_ALIASES_FILE}"
    return f'<script src="{src}" defer></script>'


def inject_dm_aliases_tag(html: str, relative: bool) -> str:
    """Anchor the alias overlay tag directly before </head>, exactly once.

    Idempotent: both tag forms are stripped first and the chosen one is
    re-inserted, so a second run is byte-identical and a client flip
    (absolute -> relative) converges.
    """
    for tag in (dm_aliases_tag(True), dm_aliases_tag(False)):
        html = html.replace(tag, "")
    tag = dm_aliases_tag(relative)
    if "</head>" not in html:
        raise BrandingError("index.html: no </head> to anchor the "
                            f"{DM_ALIASES_FILE} tag; upstream layout moved")
    return html.replace("</head>", tag + "</head>", 1)


def ensure_dm_aliases(root: Path, relative: bool) -> list[str]:
    """root/plotina-dm-aliases.js exists and index.html loads it.

    Same contract as ensure_theme_boot: the caller places the payload (web:
    Dockerfile COPY, desktop: branding.py copying it from ../element-web),
    this verifies the file and wires the tag.
    """
    payload = root / DM_ALIASES_FILE
    if not payload.is_file():
        raise BrandingError(f"{payload} missing; the DM alias payload must be "
                            "placed at the webapp root before this runs (web: "
                            "the Dockerfile COPYs it, desktop: branding.py "
                            "copies it from ../element-web)")
    index = root / "index.html"
    if not index.is_file():
        raise BrandingError(f"{index} missing; {root} is not an Element webapp root")
    html = index.read_text(encoding="utf-8")
    patched = inject_dm_aliases_tag(html, relative=relative)
    if patched != html:
        index.write_text(patched, encoding="utf-8")
    return [f"index.html: {DM_ALIASES_FILE} loads "
            f"({'relative' if relative else 'absolute'} src)"]


# --------------------------------------------------------------------------
# 4. Russian strings the upstream ru locale still lacks for the
# after-new-login verification dialog (keys per element-web's hierarchical
# i18n JSON). Inserted only where absent: once Crowdin ships its own
# translation, apply_locales() stops touching it.
# --------------------------------------------------------------------------
# Strings we intentionally replace even though upstream already has a value:
# the crash page otherwise shows upstream's own name ("Ваш Element ...") and
# our rebrand must never leak it.
FORCE_LOCALE_OVERRIDES: dict[str, dict[str, str]] = {
    "ru": {
        "error|misconfigured": "Ваш Plotina Web неверно настроен",
    },
}


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
        forced = FORCE_LOCALE_OVERRIDES.get(lang, {})
        forced_changed = False
        for dotted, value in forced.items():
            node = data
            parts = dotted.split("|")
            for part in parts[:-1]:
                child = node.get(part)
                if not isinstance(child, dict):
                    child = {}
                    node[part] = child
                node = child
            if node.get(parts[-1]) != value:
                node[parts[-1]] = value
                forced_changed = True
                actions.append(f"i18n/{name}: forced {parts[-1]!r}")
        if added or forced_changed:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n",
                            encoding="utf-8")
            for dotted in added:
                actions.append(f"i18n/{name}: added {dotted.split('|')[-1]!r}")
    return actions
