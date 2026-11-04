#!/usr/bin/env python3
"""Apply Plotina branding to the webapp directory the Element Desktop shell embeds.

Usage: branding.py --webapp <.build/webapp> --icons <branding/icons>

This runs right after apply-noise.py and owns only the browser-facing shell:
the page title and metadata, favicons, the error view the desktop shell shows,
the PWA manifest, and the mobile install guide the desktop never needs. Noise
injection and config.json stay in apply-noise.py and render-config.py.

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


def rebrand(webapp: Path, icons_dir: Path) -> None:
    copy_icons(webapp, icons_dir)
    rebrand_index(webapp / "index.html", icons_dir)
    rebrand_error_view(webapp)
    rebrand_manifest(webapp)
    remove_mobile_guide(webapp)


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

    rebrand(webapp, icons_dir)
    print(f"branded: {webapp} as {BRAND}")


if __name__ == "__main__":
    main()
