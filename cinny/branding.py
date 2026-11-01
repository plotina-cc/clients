#!/usr/bin/env python3
"""Apply Plotina branding to a built Cinny web dist.

Usage: branding.py --dist <cinny/dist> [--brand "Plotina Lite Web"] [--public-url URL]

This runs after apply-noise.py. It owns only the browser-facing shell:
icons, HTML metadata and the web app manifest. Noise injection and the AGPL
files stay in apply-noise.py.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

DESCRIPTION = "Матрикс-клиент для сообщества Плотина."
ICON_SIZES = (32, 48, 64, 128, 192, 512)


def replace_meta(html: str, attribute: str, name: str, value: str) -> str:
    pattern = rf'(<meta\s+{attribute}="{re.escape(name)}"\s+content=")[^"]*(")'
    return re.sub(pattern, rf"\g<1>{value}\g<2>", html, count=1)


def rebrand(dist: Path, brand: str, public_url: str) -> None:
    index = dist / "index.html"
    repo_root = Path(__file__).resolve().parent.parent
    icon_root = repo_root / "branding" / "icons"
    icon_svg = icon_root / "plotina-black.svg"

    if icon_svg.is_file():
        shutil.copyfile(icon_svg, dist / "plotina-icon.svg")
    for size in ICON_SIZES:
        src = icon_root / "png" / f"black-{size}.png"
        if src.is_file():
            shutil.copyfile(src, dist / f"plotina-icon-{size}.png")

    if index.is_file():
        src = index.read_text(encoding="utf-8")
        src = re.sub(r"<title>.*?</title>", f"<title>{brand}</title>", src, count=1, flags=re.S)
        src = src.replace('content="Cinny"', f'content="{brand}"')

        # Upstream ships a favicon, Apple touch icons and a social card. Remove
        # every icon link, then add ours once: appending a second icon leaves
        # the original first, and browsers keep showing it.
        src = re.sub(
            r'<link\b[^>]*\brel="(?:shortcut icon|icon|apple-touch-icon)"[^>]*>\s*',
            "",
            src,
            flags=re.IGNORECASE,
        )
        if "</head>" not in src:
            sys.exit(f"branding: no </head> in {index}; upstream layout changed")
        src = src.replace(
            "</head>",
            '<link id="favicon" rel="icon" type="image/svg+xml" href="/plotina-icon.svg">\n'
            '<link rel="apple-touch-icon" sizes="192x192" href="/plotina-icon-192.png">\n'
            "</head>",
            1,
        )

        base = public_url.rstrip("/")
        src = replace_meta(src, "property", "og:url", base)
        src = replace_meta(src, "property", "og:image", f"{base}/plotina-icon-512.png")
        src = replace_meta(src, "property", "og:description", DESCRIPTION)
        src = replace_meta(src, "name", "description", DESCRIPTION)
        src = replace_meta(src, "name", "keywords", "plotina, matrix, chat, messenger")
        src = replace_meta(src, "name", "author", "Plotina")
        index.write_text(src, encoding="utf-8")

    for name in ("manifest.json", "manifest.webmanifest"):
        path = dist / name
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        data["name"] = brand
        data["short_name"] = brand
        data["description"] = DESCRIPTION
        if (dist / "plotina-icon-192.png").is_file() and (dist / "plotina-icon-512.png").is_file():
            data["icons"] = [
                {"src": "/plotina-icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "/plotina-icon-512.png", "sizes": "512x512", "type": "image/png"},
            ]
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--brand", default="Plotina Lite Web")
    ap.add_argument("--public-url", default="https://lite.plotina.cc")
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    if not (dist / "index.html").is_file():
        sys.exit(f"branding: {dist} does not look like a Cinny dist")
    rebrand(dist, args.brand, args.public_url)
    print(f"branded: {dist} as {args.brand}")


if __name__ == "__main__":
    main()
