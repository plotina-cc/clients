#!/usr/bin/env python3
"""Inject Plotina noise suppression into a built Cinny web dist.

Usage: apply-noise.py --dist <cinny/dist> --noise <path to noise/>

Two documents need patching:
  * dist/index.html                  -> the app shell (level slider)
  * dist/public/element-call/index.html -> the embedded Element Call page that
    actually captures the microphone

Idempotent: a second run reports "already patched" instead of duplicating tags.
Fails loudly if the anchors move, so an upstream change cannot silently ship a
build without the denoiser.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

CINNY_TAG = '<script src="/noise/logic.js"></script><script src="/noise/cinny-ui.js" defer></script>'
CALL_TAG = '<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script>'

REQUIRED_ASSETS = [
    "logic.js",
    "boot.js",
    "cinny-ui.js",
    "vendor/dfn.esm.js",
    "dfn/v3/pkg/df_bg.wasm",
    "dfn/v3/models/DeepFilterNet3_onnx.tar.gz",
]


def patch_html(path: Path, snippet: str, marker: str) -> None:
    if not path.is_file():
        sys.exit(f"apply-noise: missing document {path}")
    src = path.read_text(encoding="utf-8")
    if marker in src:
        print(f"already patched: {path}")
        return
    if "</head>" not in src:
        sys.exit(f"apply-noise: no </head> in {path}; upstream layout changed")
    path.write_text(src.replace("</head>", snippet + "</head>", 1), encoding="utf-8")
    print(f"patched: {path}")


def rebrand(dist: Path, brand: str) -> None:
    index = dist / "index.html"
    repo_root = Path(__file__).resolve().parent.parent
    icon_svg = repo_root / "branding" / "icons" / "plotina-black.svg"
    icon_192 = repo_root / "branding" / "icons" / "png" / "black-192.png"
    icon_512 = repo_root / "branding" / "icons" / "png" / "black-512.png"
    if icon_svg.is_file():
        shutil.copyfile(icon_svg, dist / "plotina-icon.svg")
    for src, name in ((icon_192, "plotina-icon-192.png"), (icon_512, "plotina-icon-512.png")):
        if src.is_file():
            shutil.copyfile(src, dist / name)
    if index.is_file():
        src = index.read_text(encoding="utf-8")
        src = src.replace("<title>Cinny</title>", f"<title>{brand}</title>")
        src = src.replace('content="Cinny"', f'content="{brand}"')
        if 'rel="icon" href="/plotina-icon.svg"' not in src:
            src = src.replace(
                "</head>",
                '<link rel="icon" type="image/svg+xml" href="/plotina-icon.svg"></head>',
                1,
            )
        index.write_text(src, encoding="utf-8")
    for name in ("manifest.json", "manifest.webmanifest"):
        path = dist / name
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            data["name"] = brand
            data["short_name"] = brand
            if (dist / "plotina-icon-192.png").is_file() and (dist / "plotina-icon-512.png").is_file():
                data["icons"] = [
                    {"src": "/plotina-icon-192.png", "sizes": "192x192", "type": "image/png"},
                    {"src": "/plotina-icon-512.png", "sizes": "512x512", "type": "image/png"},
                ]
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")



def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--noise", required=True)
    ap.add_argument("--brand", default="Plotina Lite Web")
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    noise_src = Path(args.noise).resolve()

    if not (dist / "index.html").is_file():
        sys.exit(f"apply-noise: {dist} does not look like a Cinny dist")

    noise_dst = dist / "noise"
    if noise_dst.exists():
        shutil.rmtree(noise_dst)
    shutil.copytree(noise_src, noise_dst)

    for rel in REQUIRED_ASSETS:
        if not (noise_dst / rel).is_file():
            sys.exit(f"apply-noise: missing asset {rel} in {noise_src}")

    patch_html(dist / "index.html", CINNY_TAG, "/noise/cinny-ui.js")
    patch_html(dist / "public" / "element-call" / "index.html", CALL_TAG, "/noise/boot.js")
    rebrand(dist, args.brand)

    # The dist is what the web server hands out and what goes into the Tauri
    # bundle; AGPL-3.0 requires the licence text and the modification notice to
    # travel with it. The copies are byte-identical to ../LICENSE and ../NOTICE.
    repo_root = Path(__file__).resolve().parent.parent
    for src, dst in (
        (repo_root / "LICENSE", dist / "LICENSE-AGPL-3.0"),
        (repo_root / "NOTICE", dist / "NOTICE"),
    ):
        if not src.is_file():
            sys.exit(f"apply-noise: missing {src}")
        shutil.copyfile(src, dst)
    print(f"licence: {dist / 'LICENSE-AGPL-3.0'}; notice: {dist / 'NOTICE'}")

    print(f"ok: {noise_dst} ({sum(p.stat().st_size for p in noise_dst.rglob('*') if p.is_file()) // 1_000_000} MB)")


if __name__ == "__main__":
    main()
