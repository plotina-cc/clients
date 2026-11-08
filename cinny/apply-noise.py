#!/usr/bin/env python3
"""Inject Plotina noise suppression into a built Cinny web dist.

Usage: apply-noise.py --dist <cinny/dist> --noise <path to noise/>

One document needs patching:
  * dist/public/element-call/index.html -> the embedded Element Call page that
    actually captures the microphone

The app shell (dist/index.html) is deliberately left alone: the Settings ->
General noise block is React now (patches/0009-plotina-noise-settings.patch),
compiled into the bundle, and it shares the plotina.noise.* keys with the call
frame over localStorage. No <script> tags belong in the shell any more.

Branding is deliberately not done here; run branding.py after this script.

Idempotent: a second run reports "already patched" instead of duplicating tags.
Fails loudly if the anchors move, so an upstream change cannot silently ship a
build without the denoiser.
"""
import argparse
import shutil
import sys
from pathlib import Path

CALL_TAG = '<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script>'

REQUIRED_ASSETS = [
    "logic.js",
    "boot.js",
    "vendor/dfn.esm.js",
    "dfn/v3/pkg/df_bg.wasm",
    "dfn/v3/models/DeepFilterNet3_onnx.tar.gz",
    # DPDFNet experimental backend (fetch-dpdfnet.py fills the binaries;
    # the whole noise/ tree is copied below, this list is the assertion).
    "vendor/dpdfnet.esm.js",
    "vendor/dpdfnet/dpdfnet2_48khz_hr/model_stateful.onnx",
    "vendor/dpdfnet/dpdfnet2_48khz_hr/initial_states.bin",
    "vendor/dpdfnet/dpdfnet2_48khz_hr/initial_states.json",
    "vendor/dpdfnet/dpdfnet2_48khz_hr/config.ini",
    "vendor/ort/ort.wasm.bundle.min.mjs",
    "vendor/ort/ort-wasm-simd-threaded.mjs",
    "vendor/ort/ort-wasm-simd-threaded.wasm",
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--noise", required=True)
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    noise_src = Path(args.noise).resolve()

    call_doc = dist / "public" / "element-call" / "index.html"
    if not call_doc.is_file():
        sys.exit(f"apply-noise: {dist} does not look like a Cinny dist")

    noise_dst = dist / "noise"
    if noise_dst.exists():
        shutil.rmtree(noise_dst)
    shutil.copytree(noise_src, noise_dst)

    for rel in REQUIRED_ASSETS:
        if not (noise_dst / rel).is_file():
            sys.exit(f"apply-noise: missing asset {rel} in {noise_src}")

    patch_html(call_doc, CALL_TAG, "/noise/boot.js")

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
