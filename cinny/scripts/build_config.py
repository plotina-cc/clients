#!/usr/bin/env python3
"""build_config.py — stamp the Plotina Lite Desktop version and emit the Tauri
build config that CI and scripts/build.sh actually pass to `tauri build`.

WHY THE VERSION NEEDS STAMPING
    Upstream pins the app version to the Cinny tag (4.12.8) in
    src-tauri/tauri.conf.json, so every Plotina build used to report the same
    version. The Tauri updater compares semver: an installed app only offers
    an update when the manifest version is strictly greater. With a constant
    4.12.8 either no update is ever offered, or the same update is offered
    forever after it is installed (the app never learns it moved). So each
    build gets its own version, derived from the release tag.

SCHEME
    tag  v<base>-plotina-lite-desktop.<N>   ->  version  <major>.<minor>.<patch*100 + N>
    e.g. v4.12.8-plotina-lite-desktop.18    ->  4.12.818
    a branch/dispatch build has no counter  ->  <major>.<minor>.<patch*100>  (4.12.800)

    The build counter rides in the PATCH component on purpose. A semver
    prerelease ("4.12.8-plotina-lite-desktop.18") is legal for the updater but
    not for the installers: '-' is illegal in an RPM Version and it splits the
    Debian version into upstream+revision, so the same string cannot serve
    both. A plain numeric patch is valid everywhere — semver, dpkg, rpm,
    NSIS/MSI file versions (each field must stay <= 65535) — and it is
    strictly monotone: patch*100 keeps one hundred slots per upstream patch
    release, so .18 < .19 and any later upstream base still outranks every
    build made from the previous one.

    The human-readable identity (the tag) is not lost: it goes into the
    updater manifest's `notes` and into the Debian revision
    (fix-deb-branding.sh turns the tag into `-plotina.<N>`).

VALIDATION
    `config` also re-checks the updater invariants of the overlay before a
    build starts: endpoints are https and point at plotina.cc, a pubkey is
    present, and createUpdaterArtifacts is true. A build that would ship an
    app that can never update, or one that would fetch updates over http,
    fails here instead of silently shipping.

USAGE
    python3 scripts/build_config.py version --ref-name v4.12.8-plotina-lite-desktop.18 \
        --upstream-tag-file UPSTREAM_TAG
    python3 scripts/build_config.py config --overlay tauri.plotina.json \
        --version 4.12.818 --out /tmp/tauri.build.json

EXIT CODES
    0 ok; 1 the value or the overlay is unusable; 2 usage error.
"""

import argparse
import json
import pathlib
import re
import sys

# 'v4.12.8-plotina-lite-desktop.18' (tag) or '4.12.8...' when already stripped.
TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)-plotina-lite-desktop(?:\.(\d+))?$")
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)
# Windows FILEVERSION / MSI: every numeric field must fit a 16-bit word.
MAX_WINDOWS_FIELD = 65535
BUILDS_PER_UPSTREAM_PATCH = 100
EXPECTED_ENDPOINTS = ["https://plotina.cc/dl/lite/latest.json"]
EXPECTED_UPDATER_HOST = "plotina.cc"


class BuildConfigError(Exception):
    """A version, overlay or config value that must not be built with."""


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def split_base(upstream_tag):
    """('4.12.8' or 'v4.12.8') -> (4, 12, 8). Raises BuildConfigError."""
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", (upstream_tag or "").strip())
    if not match:
        raise BuildConfigError(
            "UPSTREAM_TAG must read like 'v4.12.8' (got %r)" % (upstream_tag,))
    return tuple(int(part) for part in match.groups())


def derive_version(ref_name, upstream_tag):
    """The app version for a git ref. See the SCHEME block above.

    ref_name is GITHUB_REF_NAME (a tag for release builds, a branch name for
    dispatch builds) or a bare base version. Anything that is not a Lite
    Desktop release tag builds the .0 counter slot, which is always the newest
    upstream base without pretending a scratch build is a release.
    """
    ref = (ref_name or "").strip()
    match = TAG_RE.match(ref)
    if match:
        major, minor, patch, build = match.groups()
        base = (int(major), int(minor), int(patch))
        return stamp(base, int(build or 0))
    base = split_base(upstream_tag)
    return stamp(base, 0)


def stamp(base, build):
    major, minor, patch = base
    if not is_int(build) or build < 0 or build >= BUILDS_PER_UPSTREAM_PATCH:
        raise BuildConfigError(
            "Plotina build counter must be 0..%d (got %r): the scheme reserves "
            "one hundred patch slots per upstream release" % (BUILDS_PER_UPSTREAM_PATCH - 1, build))
    version = "%d.%d.%d" % (major, minor, patch * BUILDS_PER_UPSTREAM_PATCH + build)
    validate_version(version)
    return version


def validate_version(version):
    """Semver, no prerelease/build metadata, and Windows-safe fields."""
    if not SEMVER_RE.match(version or ""):
        raise BuildConfigError("not a valid semver version: %r" % (version,))
    if "-" in version or "+" in version:
        raise BuildConfigError(
            "version %r must not carry a prerelease or build suffix: '-' breaks "
            "the RPM Version field and the Debian upstream/revision split" % (version,))
    for field in version.split("."):
        if int(field) > MAX_WINDOWS_FIELD:
            raise BuildConfigError(
                "version %r has a component above %d; NSIS/MSI file versions "
                "cannot hold it" % (version, MAX_WINDOWS_FIELD))
    return version


def check_updater_overlay(overlay):
    """Fail unless the overlay really describes an updatable Plotina build."""
    bundle = overlay.get("bundle") or {}
    plugins = overlay.get("plugins") or {}
    updater = plugins.get("updater") or {}
    errors = []

    if bundle.get("createUpdaterArtifacts") is not True:
        errors.append("bundle.createUpdaterArtifacts must be true, got %r "
                      "(no signed updater artifacts would be produced)"
                      % (bundle.get("createUpdaterArtifacts"),))

    pubkey = updater.get("pubkey")
    if not isinstance(pubkey, str) or not pubkey.strip():
        errors.append("plugins.updater.pubkey is missing: the client could not "
                      "verify a signature, and the updater refuses to run without one")
    else:
        try:
            import base64
            decoded = base64.b64decode(pubkey, validate=True).decode("utf-8")
        except Exception as exc:
            raise BuildConfigError("plugins.updater.pubkey is not base64 minisign text: %s" % exc)
        if "minisign public key" not in decoded:
            raise BuildConfigError(
                "plugins.updater.pubkey does not decode to a minisign public key")

    endpoints = updater.get("endpoints")
    if not isinstance(endpoints, list) or not endpoints:
        errors.append("plugins.updater.endpoints must be a non-empty list, got %r" % (endpoints,))
    else:
        for endpoint in endpoints:
            if not isinstance(endpoint, str) or not endpoint.startswith("https://"):
                errors.append("updater endpoint %r is not https" % (endpoint,))
            elif EXPECTED_UPDATER_HOST not in endpoint.split("/")[2]:
                errors.append("updater endpoint %r is not on %s" % (endpoint, EXPECTED_UPDATER_HOST))

    if overlay.get("identifier") != "cc.plotina.chat":
        errors.append("identifier must stay cc.plotina.chat, got %r" % (overlay.get("identifier"),))

    if errors:
        raise BuildConfigError("; ".join(errors))
    return True


def load_overlay(path):
    path = pathlib.Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildConfigError("overlay not found: %s" % path)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildConfigError("overlay %s is not readable JSON: %s" % (path, exc))
    if not isinstance(data, dict):
        raise BuildConfigError("overlay %s must be a JSON object" % path)
    return data


def write_build_config(overlay_path, out_path, version, unsigned_local_build=False):
    """Overlay + stamped version, written as one config file for `tauri build`.

    The overlay is always validated as a release config. `unsigned_local_build`
    then turns the *generated* file into one that skips signing, for a developer
    who has no updater key: nothing shippable comes out of it, and the checked-in
    overlay keeps saying true.
    """
    overlay = dict(load_overlay(overlay_path))
    validate_version(version)
    check_updater_overlay(overlay)
    if unsigned_local_build:
        overlay["bundle"] = dict(overlay.get("bundle") or {})
        overlay["bundle"]["createUpdaterArtifacts"] = False
        print("build_config: UNSIGNED local build (createUpdaterArtifacts=false) — "
              "this config must never be released; no updater artifact exists.",
              file=sys.stderr)
    overlay["version"] = version
    out = pathlib.Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(overlay, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return overlay


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="build_config.py",
        description="Stamp the Plotina Lite Desktop version and emit the Tauri build config.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_version = sub.add_parser("version", help="print the stamped app version for a ref")
    p_version.add_argument("--ref-name", required=True,
                           help="GITHUB_REF_NAME (tag or branch) or a bare base version")
    p_version.add_argument("--upstream-tag-file", default=None,
                           help="path to cinny/UPSTREAM_TAG; used when the ref is not a release tag")
    p_version.add_argument("--out", default=None, help="write the version here too (default: stdout only)")

    p_config = sub.add_parser("config", help="write the stamped Tauri build config")
    p_config.add_argument("--overlay", required=True)
    p_config.add_argument("--out", required=True)
    p_config.add_argument("--ref-name", default=None)
    p_config.add_argument("--version", default=None, help="use this version instead of deriving it")
    p_config.add_argument("--upstream-tag-file", default=None)
    p_config.add_argument("--no-updater-artifacts", action="store_true",
                          help="local builds only: do not sign a bundle (no updater artifact)")

    p_check = sub.add_parser("check", help="validate the overlay's updater settings only")
    p_check.add_argument("--overlay", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "version":
            upstream = ""
            if args.upstream_tag_file:
                upstream = pathlib.Path(args.upstream_tag_file).read_text(encoding="utf-8").strip()
            else:
                upstream = pathlib.Path("UPSTREAM_TAG").read_text(encoding="utf-8").strip()
            version = derive_version(args.ref_name, upstream)
            print(version)
            if args.out:
                pathlib.Path(args.out).write_text(version + "\n", encoding="utf-8")
            return 0

        if args.command == "config":
            version = args.version
            if not version:
                if not args.ref_name:
                    raise BuildConfigError("config needs --version or --ref-name")
                tag_path = args.upstream_tag_file or "UPSTREAM_TAG"
                version = derive_version(args.ref_name, pathlib.Path(tag_path).read_text(encoding="utf-8").strip())
            write_build_config(args.overlay, args.out, version,
                                 unsigned_local_build=args.no_updater_artifacts)
            print("%s -> %s (version %s)" % (args.overlay, args.out, version))
            return 0

        if args.command == "check":
            check_updater_overlay(load_overlay(args.overlay))
            print("updater overlay ok")
            return 0
    except BuildConfigError as exc:
        print("build_config: %s" % exc, file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
