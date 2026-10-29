#!/usr/bin/env python3
"""Write or validate the config.json Element Web serves at runtime.

Element Web fetches /config.json on every load; matrix-react-sdk's
initSentry() reads the "sentry" object from it and calls Sentry.init() at
startup. The overlay's config.json is that document. Its one deployment
specific value is the DSN of our GlitchTip relay, which also exists as the
SENTRY_DSN repository variable, so rotating it does not need a code change:

    SENTRY_DSN=https://... element-web/scripts/render-config.py --out dist/element-web-config.json
    element-web/scripts/render-config.py --config element-web/config.json --check

A missing sentry block, an empty DSN or a non-production environment is a
failed build here rather than a deployment that silently reports nowhere.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlparse

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.json"


def fail(message: str) -> NoReturn:
    print(f"render-config: {message}", file=sys.stderr)
    raise SystemExit(1)


def load(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as fh:
            config = json.load(fh)
    except OSError as exc:
        fail(f"cannot read {path}: {exc}")
    except json.JSONDecodeError as exc:
        fail(f"{path} is not valid JSON: {exc}")
    if not isinstance(config, dict):
        fail(f"{path} must contain a JSON object")
    return config


def check(config: dict) -> dict:
    """Return the sentry block after asserting it can actually report."""
    sentry = config.get("sentry")
    if not isinstance(sentry, dict):
        fail('config.json has no "sentry" object; Element Web would never initialise Sentry')

    dsn = str(sentry.get("dsn") or "").strip()
    if not dsn:
        fail("sentry.dsn is empty; pass the SENTRY_DSN repository variable with --dsn or in the environment")

    url = urlparse(dsn)
    if url.scheme != "https" or not url.hostname or not url.username:
        fail("sentry.dsn is not an https DSN with a public key")
    if not url.path.strip("/"):
        fail("sentry.dsn has no project path")
    # The public root of sentry.plotina.cc answers 403; only /relay/* is routed.
    # A DSN without that prefix parses but every envelope is refused, which is
    # impossible to notice from the app, so say it loudly.
    if not url.path.startswith("/relay/"):
        print(
            f"render-config: warning: dsn path is {url.path!r}, not /relay/<project>;"
            " events will not reach GlitchTip through the public host",
            file=sys.stderr,
        )

    if sentry.get("environment") != "production":
        fail(f'sentry.environment is {sentry.get("environment")!r}, expected "production"')
    return sentry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="config.json to read (default: element-web/config.json)")
    parser.add_argument("--out", type=Path, help="write the rendered document here")
    parser.add_argument("--dsn", default=os.environ.get("SENTRY_DSN", ""), help="DSN to write; defaults to $SENTRY_DSN, empty keeps the committed value")
    parser.add_argument("--check", action="store_true", help="validate only (the default); kept explicit for CI readability")
    args = parser.parse_args()

    config = load(args.config)

    dsn = (args.dsn or "").strip()
    if dsn:
        sentry = config.setdefault("sentry", {})
        if not isinstance(sentry, dict):
            fail('config["sentry"] is not a JSON object')
        sentry["dsn"] = dsn
        sentry["environment"] = "production"

    sentry = check(config)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # Validate what was written, not what we think we wrote.
        sentry = check(load(args.out))
        print(f"render-config: wrote {args.out}")

    url = urlparse(str(sentry["dsn"]))
    print(f"render-config: ok host={url.hostname} path={url.path} environment={sentry['environment']}")


if __name__ == "__main__":
    main()
