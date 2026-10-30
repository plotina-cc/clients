#!/usr/bin/env python3
"""Split the source maps out of a built Cinny dist.

Usage: sentry-sourcemaps.py --dist <cinny/dist> --out <dir>
                            [--sentry-cli <path>] [--release <name>]

Vite writes a .map next to every hashed script. Publishing them would hand the
whole TypeScript source to anyone who asks, so each map is copied to --out
together with the script it describes and then removed from the dist; CI
uploads --out to GlitchTip. The served JavaScript keeps working because the
SDK talks to the server, not to the .map file.

Only the Cinny app bundle is touched (dist/assets and the service worker at the
dist root). dist/public/ is copied verbatim from packages we do not build --
the embedded Element Call app, the pdf.js worker -- and their symbols belong to
whoever builds them.

With --sentry-cli the debug ids are injected first: sentry-cli writes one id
into both the script and its map, which is what pairs an event with its
symbols regardless of the URL it was served from (the same bundle runs from
cinny.plotina.cc and from tauri://localhost in the desktop app).
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def bundle_maps(dist: Path) -> list[Path]:
    """Maps of the Cinny bundle: everything under assets/ plus the root sw.js."""
    maps = list((dist / "assets").rglob("*.map"))
    maps += [p for p in dist.glob("*.map") if p.is_file()]
    return sorted(maps)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True, help="the built cinny/dist")
    ap.add_argument("--out", required=True, help="where the maps are collected")
    ap.add_argument("--sentry-cli", help="sentry-cli binary: inject debug ids first")
    ap.add_argument("--release", default="", help="only for the log line")
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    out = Path(args.out).resolve()

    if not (dist / "index.html").is_file():
        sys.exit(f"sentry-sourcemaps: {dist} does not look like a Cinny dist")

    if out.exists():
        # Never delete something that is not a maps directory: a mistyped
        # --out must fail here, not take the checkout with it.
        if out == Path("/") or (out / "index.html").is_file():
            sys.exit(f"sentry-sourcemaps: refusing to replace {out}")
        shutil.rmtree(out)

    if args.sentry_cli:
        # dist/public/ (the embedded Element Call app) and the pdf.js worker
        # come from packages we do not build, so their files are left exactly
        # as published; only our own bundle gets debug ids.
        print(f"injecting debug ids into {dist}")
        subprocess.run(
            [
                args.sentry_cli,
                "sourcemaps",
                "inject",
                str(dist),
                "--ignore",
                "public/**",
                "--ignore",
                "pdf.worker.min.js",
            ],
            check=True,
        )
    else:
        print("no sentry-cli given: splitting the maps out unlabelled")

    maps = bundle_maps(dist)
    for map_file in maps:
        rel = map_file.relative_to(dist)
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(map_file, out / rel)
        script = map_file.with_suffix("")
        if script.is_file():
            shutil.copy2(script, out / rel.with_suffix(""))
        map_file.unlink()

    leftover = bundle_maps(dist)
    if leftover:
        sys.exit(f"sentry-sourcemaps: maps are still in the dist: {leftover[:3]}")

    release = f" for {args.release}" if args.release else ""
    print(f"ok: {len(maps)} source maps in {out}{release}")


if __name__ == "__main__":
    main()
