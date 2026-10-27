#!/usr/bin/env python3
"""Download the pinned DeepFilterNet3 assets into noise/dfn/v3/...

The two binaries are 24 MB together, so they are not kept in git: CI fetches
them from our own edge and verifies the SHA-256 from noise.lock.json. Local builds
that already have them (rsync from the server) skip the download.
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "noise.lock.json").read_text())

for rel, meta in LOCK.items():
    target = ROOT / "noise" / rel
    if target.is_file():
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest == meta["sha256"]:
            print(f"have: {rel}")
            continue
        print(f"mismatch, refetching: {rel}")
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"fetch: {meta['url']}")
    with urllib.request.urlopen(meta["url"], timeout=120) as resp:
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != meta["sha256"]:
        sys.exit(f"sha256 mismatch for {rel}: {digest} != {meta['sha256']}")
    target.write_bytes(data)
    print(f"ok: {rel} ({len(data) // 1_000_000} MB)")

print("noise assets ready")
