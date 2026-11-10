#!/usr/bin/env python3
"""Fail the build when the Element webapp ships a dead custom property.

Usage: check-theme-tokens.py <webapp-root>

Thin CLI over webapp_fixes.audit_webapp(), so the image build and the desktop
prepare step verify the SAME predicate the brand pass itself enforces. Exit
code 1 with a one-line reason on failure.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent                      # element-web/
if str(WEBAPP) not in sys.path:
    sys.path.insert(0, str(WEBAPP))

import webapp_fixes  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--webapp", default="/app",
                        help="Element webapp root (default: /app)")
    args = parser.parse_args()
    try:
        for action in webapp_fixes.audit_webapp(Path(args.webapp)):
            print(f"check-theme-tokens: {action}")
    except webapp_fixes.BrandingError as exc:
        print(f"check-theme-tokens: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())