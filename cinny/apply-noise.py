#!/usr/bin/env python3
"""Finish a built Cinny (Lite) dist: licences, and the gate on the call frame.

Usage: apply-noise.py --dist <cinny/dist>

What changed and why. This script used to copy a 50 MB noise/ tree into
dist/noise and inject two <script> tags into dist/public/element-call/index.html.
That was for upstream's embedded Element Call, which knew nothing about the
denoiser. Lite now ships OUR Element Call (scripts/mount-element-call.py): the
archive carries its own noise/ inside the mount and its index.html already loads
those scripts, so a second copy at the dist root was 50 MB no frame ever fetched,
plus a second initialisation path for the same denoiser.

Settings -> General still reaches the frame: patch 0009 is React, the shell and
the frame share one origin, and both read the same plotina.noise.* localStorage
keys. Nothing has to be injected into the shell, and nothing is injected here.

Branding is deliberately not done here; run branding.py after this script.

Idempotent. Fails loudly if the frame is not ours, so a build cannot ship
upstream's widget by accident.
"""
import argparse
import shutil
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOUNT_TOOL = HERE / "scripts" / "mount-element-call.py"


def _mount_tool():
    if not MOUNT_TOOL.is_file():
        sys.exit(f"apply-noise: missing {MOUNT_TOOL}")
    spec = spec_from_file_location("mount_element_call", MOUNT_TOOL)
    if spec is None or spec.loader is None:
        sys.exit(f"apply-noise: cannot load {MOUNT_TOOL}")
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--noise", help="ignored: the call frame carries its own copy")
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    if not (dist / "index.html").is_file():
        sys.exit(f"apply-noise: {dist} does not look like a Cinny dist")
    if args.noise:
        print("apply-noise: --noise is ignored; the call frame carries noise/ itself")

    mount = _mount_tool()
    mount.verify_frame(dist / mount.MOUNT)

    stale = dist / "noise"
    if stale.exists():
        shutil.rmtree(stale)
        print(f"removed: {stale} (the frame loads its denoiser from its own mount)")

    # The dist is what the web server hands out and what goes into the Tauri
    # bundle; AGPL-3.0 requires the licence text and the modification notice to
    # travel with it. The copies are byte-identical to ../LICENSE and ../NOTICE.
    repo_root = HERE.parent
    for src, dst in (
        (repo_root / "LICENSE", dist / "LICENSE-AGPL-3.0"),
        (repo_root / "NOTICE", dist / "NOTICE"),
    ):
        if not src.is_file():
            sys.exit(f"apply-noise: missing {src}")
        shutil.copyfile(src, dst)
    print(f"licence: {dist / 'LICENSE-AGPL-3.0'}; notice: {dist / 'NOTICE'}")
    total = sum(p.stat().st_size for p in dist.rglob("*") if p.is_file())
    print(f"ok: {dist} ({total / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
