#!/usr/bin/env python3
"""Inject Plotina noise suppression into an unpacked Element Web build.

Usage: apply-noise.py --webapp <dir> --noise <dir> [--config element-web/config.json]

The desktop shell serves the webapp over the vector:// scheme, as
vector://vector/webapp/, and only paths below /webapp/ are served. The script
tags therefore stay relative and noise/boot.js resolves its own directory at
runtime, so this one overlay works both here and on the web.

Also writes config.json into the webapp: the homeserver/branding from
element-web/config.json plus the desktop-only web_base_url. update_base_url is
removed on purpose -- without it the Electron shell never asks Element for an
update.

The config is expected to come from element-web/scripts/render-config.py, which
fills sentry.dsn from SENTRY_DSN; a config without a usable sentry block fails
the build here rather than shipping a desktop that never reports a crash.

Idempotent; fails loudly if an anchor moves, so an upstream change cannot ship a
build with the denoiser silently missing.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse

TAG = '<script src="noise/logic.js"></script><script src="noise/boot.js" defer></script>'
MARKER = "noise/boot.js"

REQUIRED_ASSETS = [
    "logic.js",
    "boot.js",
    "vendor/dfn.esm.js",
    "dfn/v3/pkg/df_bg.wasm",
    "dfn/v3/models/DeepFilterNet3_onnx.tar.gz",
]

WEB_BASE_URL = "https://chat.plotina.cc/"


def patch_html(path: Path) -> None:
    if not path.is_file():
        sys.exit(f"apply-noise: missing document {path}")
    src = path.read_text(encoding="utf-8")
    if MARKER in src:
        print(f"already patched: {path}")
        return
    if "</head>" not in src:
        sys.exit(f"apply-noise: no </head> in {path}; upstream layout changed")
    path.write_text(src.replace("</head>", TAG + "</head>", 1), encoding="utf-8")
    print(f"patched: {path}")


def write_config(src: Path, dst: Path) -> None:
    config = json.loads(src.read_text(encoding="utf-8"))
    sentry = config.get("sentry")
    if not isinstance(sentry, dict) or not str(sentry.get("dsn") or "").strip():
        sys.exit(f"apply-noise: {src} has no sentry.dsn; the desktop app would never report to GlitchTip")
    if config.pop("update_base_url", None) is not None:
        print("dropped update_base_url: our builds never follow Element's update feed")
    config.setdefault("web_base_url", WEB_BASE_URL)
    dst.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    url = urlparse(str(sentry["dsn"]))
    print(f"config: {dst} (sentry {sentry.get('environment')} -> {url.hostname}{url.path})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--webapp", required=True)
    ap.add_argument("--noise", required=True)
    ap.add_argument("--config", required=True)
    args = ap.parse_args()

    webapp = Path(args.webapp).resolve()
    noise_src = Path(args.noise).resolve()
    config_src = Path(args.config).resolve()

    if not (webapp / "index.html").is_file():
        sys.exit(f"apply-noise: {webapp} does not look like an Element Web build")

    noise_dst = webapp / "noise"
    if noise_dst.exists():
        shutil.rmtree(noise_dst)
    shutil.copytree(noise_src, noise_dst)

    for rel in REQUIRED_ASSETS:
        if not (noise_dst / rel).is_file():
            sys.exit(f"apply-noise: missing asset {rel} in {noise_src}")

    # boot.js must find its own directory, otherwise the desktop build loads
    # /noise/... from vector://vector/ and every asset 404s.
    if "currentScript" not in (noise_dst / "boot.js").read_text(encoding="utf-8"):
        sys.exit("apply-noise: noise/boot.js does not resolve its own path; refresh the shared noise layer")

    patch_html(webapp / "index.html")
    write_config(config_src, webapp / "config.json")

    version = webapp / "version"
    if version.is_file():
        print(f"webapp version: {version.read_text(encoding='utf-8').strip()}")

    size = sum(p.stat().st_size for p in noise_dst.rglob("*") if p.is_file())
    print(f"ok: {noise_dst} ({size // 1_000_000} MB)")


if __name__ == "__main__":
    main()
