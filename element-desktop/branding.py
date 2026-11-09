#!/usr/bin/env python3
"""Apply Plotina branding to the webapp directory the Element Desktop shell embeds.

Usage: branding.py --webapp <.build/webapp> --icons <branding/icons>

This runs right after apply-noise.py and owns only the browser-facing shell:
the page title and metadata, favicons, the error view the desktop shell shows,
the PWA manifest, and the mobile install guide the desktop never needs. Noise
injection and config.json stay in apply-noise.py and render-config.py.

PARITY RULE: every fix the Element Web image ships must also ship here. The
web fixes — the --timeline-text-color contrast fallback, the plotina-modal-a11y
style, the plotina-theme.js first-visit bootstrap and the ru locale fills —
are not re-implemented in this file: they come from ../element-web/webapp_fixes.py,
the single source of truth both branding scripts share, and
tests/test_webapp_fixes.py feeds identical CSS/HTML through both entry points
and asserts byte-identical output. The only desktop-specific difference is
allowed to be the tag form: the shell serves the webapp from
vector://vector/webapp/, so root-absolute srcs 404 and everything (including
the plotina-theme.js payload, which branding.py copies out of ../element-web
into the webapp root here instead of a Dockerfile COPY) stays relative.

Icon hrefs are relative on purpose: the shell serves the webapp from
vector://vector/webapp/, and absolute /plotina-... paths would 404 there —
the same reason apply-noise.py adds relative script tags.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ELEMENT_WEB = HERE.parent / "element-web"  # webapp_fixes.py + plotina-theme.js
if str(ELEMENT_WEB) not in sys.path:
    sys.path.insert(0, str(ELEMENT_WEB))
try:
    import webapp_fixes  # type: ignore[import-not-found]  # lives in ../element-web
except ImportError as exc:  # build host without the sibling directory
    sys.exit(f"branding: cannot import {ELEMENT_WEB / 'webapp_fixes.py'}: {exc}")

BRAND = "Plotina Desktop"
IMG_ALT = "Plotina"
THEME_COLOR = "#17795A"
NOSCRIPT = "Plotina Desktop requires JavaScript to be enabled."

# webapp destination name -> source path under the icons directory
ICONS = {
    "plotina-icon.svg": ("plotina-green.svg",),
    "plotina-icon-192.png": ("png/green-192.png",),
    "plotina-512.png": ("png/green-512.png",),
}

ELEMENT_LOGO_SRC = "themes/element/img/logos/element-app-logo.png"
LOGO_FILE = Path("themes") / "element" / "img" / "logos" / "element-app-logo.png"


def set_meta(html: str, key: str, name: str, value: str, where: str) -> str:
    """Rewrite the content of <meta {key}="{name}">, in either attribute order."""
    patterns = [
        rf'(<meta\s+{key}="{re.escape(name)}"\s+content=")[^"]*(")',
        rf'(<meta\s+content=")[^"]*("\s+{key}="{re.escape(name)}")',
    ]
    for pattern in patterns:
        html, n = re.subn(pattern, rf"\g<1>{value}\g<2>", html, count=1)
        if n:
            return html
    sys.exit(f"branding: no <meta {key}={name!r}> in {where}; upstream layout changed")


def rebrand_index(index: Path, icons_dir: Path) -> None:
    src = index.read_text(encoding="utf-8")

    src, n = re.subn(r"<title>.*?</title>", f"<title>{BRAND}</title>", src, count=1, flags=re.S)
    if not n:
        sys.exit(f"branding: no <title> in {index}; upstream layout changed")

    src = set_meta(src, "name", "apple-mobile-web-app-title", BRAND, str(index))
    src = set_meta(src, "name", "application-name", BRAND, str(index))
    src = set_meta(src, "name", "theme-color", THEME_COLOR, str(index))
    # The social card must not point at app.element.io: the desktop ships the
    # icon inside the webapp itself.
    src = set_meta(src, "property", "og:image", "plotina-512.png", str(index))

    # Upstream ships Element favicons and apple touch icons. Remove every icon
    # link, then add ours once: appending a second icon leaves the original
    # first, and Chromium keeps showing it.
    src = re.sub(
        r'<link\b[^>]*\brel="(?:shortcut icon|icon|apple-touch-icon|mask-icon)"[^>]*>\s*',
        "",
        src,
        flags=re.IGNORECASE,
    )
    if "</head>" not in src:
        sys.exit(f"branding: no </head> in {index}; upstream layout changed")
    src = src.replace(
        "</head>",
        '<link id="favicon" rel="icon" type="image/svg+xml" href="plotina-icon.svg">\n'
        '<link rel="apple-touch-icon" sizes="192x192" href="plotina-icon-192.png">\n'
        "</head>",
        1,
    )

    src, n = re.subn(
        r"<noscript>.*?</noscript>", f"<noscript>{NOSCRIPT}</noscript>", src, count=1, flags=re.S
    )
    if not n:
        sys.exit(f"branding: no <noscript> in {index}; upstream layout changed")

    index.write_text(src, encoding="utf-8")


def rebrand_error_view(webapp: Path) -> None:
    views = sorted(webapp.glob("bundles/*/error-view.js"))
    if not views:
        sys.exit(f"branding: no bundles/*/error-view.js under {webapp}; upstream layout changed")
    replaced = 0
    for view in views:
        src = view.read_text(encoding="utf-8")
        # The error view is minified React: the logo is createElement("img",
        # {...,src:"...",alt:"Element"}), so the attributes are JS strings.
        src, n = re.subn(re.escape(ELEMENT_LOGO_SRC), "plotina-512.png", src)
        replaced += n
        src = src.replace('alt:"Element"', f'alt:"{IMG_ALT}"').replace(
            'alt="Element"', f'alt="{IMG_ALT}"'
        )
        view.write_text(src, encoding="utf-8")
    if replaced and not (webapp / "plotina-512.png").is_file():
        sys.exit("branding: error view was rewritten but plotina-512.png is missing")
    if not replaced and "plotina-512.png" not in views[0].read_text(encoding="utf-8"):
        sys.exit(f"branding: {ELEMENT_LOGO_SRC} not found in error-view.js; upstream layout changed")


def copy_icons(webapp: Path, icons_dir: Path) -> None:
    for dest_name, sources in ICONS.items():
        for rel in sources:
            src = icons_dir / rel
            if src.is_file():
                shutil.copyfile(src, webapp / dest_name)
                break
        else:
            sys.exit(
                f"branding: missing icon for {dest_name} (looked for "
                + ", ".join(str(icons_dir / s) for s in sources)
                + ")"
            )
    # Anything still loading the upstream logo file must get our mark too.
    logo = webapp / LOGO_FILE
    if logo.parent.is_dir():
        shutil.copyfile(webapp / "plotina-512.png", logo)
    else:
        print(f"branding: warning: {logo.parent} absent, left the upstream logo alone", file=sys.stderr)


def rebrand_manifest(webapp: Path) -> None:
    path = webapp / "manifest.json"
    if not path.is_file():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        sys.exit(f"branding: {path} is not a JSON object")
    data["name"] = BRAND
    data["short_name"] = BRAND
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def remove_mobile_guide(webapp: Path) -> None:
    guide = webapp / "mobile_guide"
    if guide.is_dir():
        shutil.rmtree(guide)
    elif guide.exists():
        guide.unlink()


def apply_web_fixes(webapp: Path) -> list[str]:
    """Run the shared Element Web fixes on the unpacked webapp.

    Same helpers the web image runs (webapp_fixes.py), with the one
    desktop-specific difference: ../element-web/plotina-theme.js is copied
    into the webapp root and referenced RELATIVELY, like the noise tags —
    vector://vector/webapp/ never serves a root-absolute path. Fails loudly
    (BrandingError) when a custom-theme sheet is missing or the 133-use
    fallback count drops, exactly like the web pass.
    """
    theme_src = ELEMENT_WEB / webapp_fixes.THEME_INIT_FILE
    if not theme_src.is_file():
        sys.exit(f"branding: {theme_src} missing; the theme bootstrap payload "
                 "lives in ../element-web for both clients")
    shutil.copyfile(theme_src, webapp / webapp_fixes.THEME_INIT_FILE)
    (webapp / webapp_fixes.THEME_INIT_FILE).chmod(0o644)

    # Both overlay payloads live in ../element-web so the relative tags
    # resolve under vector://vector/webapp/; copy them into the webapp root.
    aliases_src = ELEMENT_WEB / webapp_fixes.DM_ALIASES_FILE
    if not aliases_src.is_file():
        sys.exit(f"branding: {aliases_src} missing; the DM alias payload "
                 "lives in ../element-web for both clients")
    shutil.copyfile(aliases_src, webapp / webapp_fixes.DM_ALIASES_FILE)
    (webapp / webapp_fixes.DM_ALIASES_FILE).chmod(0o644)

    # config.json points branding.welcome_background_url at /plotina-bg.png
    # (absolute on the web, where /app is the site root). apply-noise.py
    # rewrites that URL to the relative form for vector://, so the file has to
    # exist in the webapp root or the welcome screen silently loses its
    # background. plotina-icon.svg (auth_header_logo_url) comes from ICONS.
    background_src = ELEMENT_WEB / "plotina-bg.png"
    if not background_src.is_file():
        sys.exit(f"branding: {background_src} missing; the welcome background "
                 "lives in ../element-web for both clients")
    shutil.copyfile(background_src, webapp / "plotina-bg.png")
    (webapp / "plotina-bg.png").chmod(0o644)

    index = webapp / "index.html"
    html = index.read_text(encoding="utf-8")
    patched = webapp_fixes.inject_modal_style(html)
    if patched != html:
        index.write_text(patched, encoding="utf-8")

    actions = [
        f"{webapp_fixes.THEME_INIT_FILE} copied from ../element-web into the webapp root",
        "index.html: plotina-modal-a11y style injected (exactly once, after the bundle/theme links)",
    ]
    actions.extend(webapp_fixes.ensure_theme_boot(webapp, relative=True))
    actions.extend(webapp_fixes.ensure_dm_aliases(webapp, relative=True))
    actions.extend(webapp_fixes.apply_theme_css(webapp))
    actions.extend(webapp_fixes.apply_locales(webapp / "i18n"))
    return actions


def rebrand(webapp: Path, icons_dir: Path) -> list[str]:
    """Full brand pass; returns human-readable actions.

    Raises webapp_fixes.BrandingError when one of the shared web fixes
    cannot be applied: main() turns that into a failed build.
    """
    copy_icons(webapp, icons_dir)
    actions = []
    rebrand_index(webapp / "index.html", icons_dir)
    # The shared web fixes run on the final index.html, right after the
    # desktop-specific title/meta/icon work above.
    actions.extend(apply_web_fixes(webapp))
    rebrand_error_view(webapp)
    rebrand_manifest(webapp)
    remove_mobile_guide(webapp)
    return actions


def main() -> None:
    ap = argparse.ArgumentParser(description="Brand the webapp directory embedded in the Element Desktop shell.")
    ap.add_argument("--webapp", required=True, help="unpacked webapp directory (the future webapp.asar)")
    ap.add_argument("--icons", required=True, help="repository branding/icons directory")
    args = ap.parse_args()

    webapp = Path(args.webapp).resolve()
    icons_dir = Path(args.icons).resolve()
    if not (webapp / "index.html").is_file():
        sys.exit(f"branding: {webapp} does not look like an Element webapp (no index.html)")
    if not icons_dir.is_dir():
        sys.exit(f"branding: {icons_dir} is not a directory")

    try:
        actions = rebrand(webapp, icons_dir)
    except webapp_fixes.BrandingError as exc:
        sys.exit(f"branding: {exc}")
    for action in actions:
        print(f"branding: {action}")
    print(f"branded: {webapp} as {BRAND}")


if __name__ == "__main__":
    main()
