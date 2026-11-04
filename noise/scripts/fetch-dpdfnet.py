#!/usr/bin/env python3
"""Fetch the pinned DPDFNet + onnxruntime-web assets into <noise>/vendor/...

Mirrors cinny/scripts/fetch-noise.py: every file in dpdfnet.lock.json is
downloaded from its URL and verified against the recorded SHA-256. Existing
files with a matching digest are kept untouched (idempotent, CI-friendly).

The two big binaries (14.8 MB ort wasm + 10.6 MB model) stay out of git, same
policy as the DeepFilterNet3 assets; run this once before serving or building:

    python3 noise/scripts/fetch-dpdfnet.py            # fills noise/vendor/
    python3 noise/scripts/fetch-dpdfnet.py --dest dist/noise

Backends that cannot load their assets fail open to DFN3, so forgetting this
step costs the experiment, never a call.
"""
import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

NOISE = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=str(NOISE), help="noise/ directory to fill (default: this directory)")
    ap.add_argument("--lock", default=str(NOISE / "dpdfnet.lock.json"), help="lock file with URLs and sha256")
    args = ap.parse_args()

    dest = Path(args.dest)
    lock = json.loads(Path(args.lock).read_text())

    for rel, meta in lock.items():
        target = dest / rel
        if target.is_file():
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            if digest == meta["sha256"]:
                print(f"have: {rel}")
                continue
            print(f"mismatch, refetching: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"fetch: {meta['url']}")
        with urllib.request.urlopen(meta["url"], timeout=180) as resp:
            data = resp.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != meta["sha256"]:
            sys.exit(f"sha256 mismatch for {rel}: {digest} != {meta['sha256']}")
        target.write_bytes(data)
        print(f"ok: {rel} ({len(data)} bytes)")

    print("dpdfnet assets ready")


if __name__ == "__main__":
    main()
