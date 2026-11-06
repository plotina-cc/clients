#!/usr/bin/env python3
"""updater_manifest.py — build and validate the Tauri updater manifest
(`latest.json`) that Plotina Lite Desktop reads from
https://plotina.cc/dl/lite/latest.json.

SHAPE (Tauri v2 updater plugin; see https://v2.tauri.app/plugin/updater/)
    {
      "version":  "4.12.818",                       # semver, must outrank the
                                                    #   version baked into the app
      "notes":    "...",                             # shown in the update dialog
      "pub_date": "2026-11-07T18:00:00Z",            # RFC 3339
      "platforms": {
        "linux-x86_64":   {"url": "...", "signature": "<content of the .sig file>"},
        "windows-x86_64": {"url": "...", "signature": "..."}
      }
    }
Only `version`, `url` and `signature` are required by the plugin; `notes` and
`pub_date` are what our Settings dialog shows, so the builder insists on them.

THE SIGNATURE FIELD IS NOT MINISIGN TEXT
    `tauri build` writes `<artifact>.sig` as ONE base64 line: the base64 of a
    minisign document ("untrusted comment: signature from tauri secret key", the
    74-byte Ed/ED signature blob, "trusted comment: timestamp:… file:…", and the
    raw 64-byte Ed25519 signature). `tauri-plugin-updater`'s verify_signature()
    does base64_to_string(signature) and feeds the DECODED text to
    minisign_verify::Signature::decode, then verifies with allow_prehashed=true.
    So the manifest must carry the .sig file's bytes verbatim, and this script
    validates that the bytes really are that wrapped document — a hand-written
    minisign text, a path, a URL or a plain base64 of the raw signature all
    parse as "a signature" to a careless reader and fail on every client.
    The wrapped document names the file as it was when signed (the versioned
    bundle name); CI renames to the stable /dl alias afterwards, so pairing here
    is by filename (`<artifact>.sig` next to `<artifact>`) and cryptographically
    in CI (cargo test --test updater_signature).

WHAT IT ENFORCES (and why)
  * `https` only, and only the exact stable /dl URLs below. The updater runs
    with no user interaction in front of a URL, so the manifest never points at
    a host we do not control, never at http, and never at a GitHub
    /releases/download/ URL that a rate limit or a pruned release would turn
    into "could not check for updates" on every install.
  * the Linux artifact is the AppImage itself and the Windows artifact is the
    NSIS `-setup.exe`. With `createUpdaterArtifacts: true` (not the legacy
    "v1Compatible") Tauri signs those files directly, so the bytes behind the
    stable /dl aliases are exactly the signed bytes — no second
    `.AppImage.tar.gz` copy on the edge, and the manual download and the update
    payload stay one file.
  * no `.msi`, `.deb` or `.rpm` anywhere: the feed publishes one signed artifact
    per platform (AppImage, NSIS setup.exe) because those are the stable aliases.
    The plugin resolves `<os>-<arch>-<installer>` before the bare `<os>-<arch>`,
    so an MSI or deb/rpm install that asked this feed would be handed the
    NSIS/AppImage payload and apply it over the package manager's database. That
    is why the client asks `plotina_install_kind` first and shows a manual state
    instead; letting MSI installs update themselves would mean publishing and
    signing the `.msi` under a `windows-x86_64-msi` key (see cinny/README.md).
  * `pub_date` parses as RFC 3339 and `version` carries no prerelease or build
    suffix, matching what scripts/build_config.py stamps into the app.

USAGE
    # in CI, after the two platform builds have produced their .sig files
    python3 scripts/updater_manifest.py build \
        --version 4.12.818 \
        --notes-file notes.md \
        --platform linux-x86_64=dist/linux/Plotina-Lite-Desktop.AppImage.sig \
        --platform windows-x86_64=dist/windows/Plotina-Lite-Desktop-setup.exe.sig \
        --out dist/update-lite-desktop.json

    # validate anything, e.g. before serving it
    python3 scripts/updater_manifest.py validate --manifest dist/update-lite-desktop.json

EXIT CODES
    0 ok; 1 invalid manifest / unreadable signature; 2 usage error.
"""

import argparse
import base64
import datetime
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build_config  # noqa: E402  (sibling module: version + https rules)

DL_BASE = "https://plotina.cc/dl/"
# platform key -> the stable artifact the updater downloads for it. The names
# are the release assets mirrored by the edge (infra scripts/assets.map), so
# the signed bytes and the served bytes are the same file.
EXPECTED_ARTIFACTS = {
    "linux-x86_64": "Plotina-Lite-Desktop.AppImage",
    "windows-x86_64": "Plotina-Lite-Desktop-setup.exe",
}
KNOWN_PLATFORMS = tuple(EXPECTED_ARTIFACTS)
# RFC 3339 date-time with either 'Z' or a numeric offset.
RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
REQUIRED_TOP_KEYS = ("version", "notes", "pub_date", "platforms")
UNTRUSTED_COMMENT_RE = re.compile(r"^untrusted comment: \S", re.M)
BASE64_BLOB_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
# the trusted comment is tab-separated, so the name may contain spaces
TRUSTED_FILE_RE = re.compile(r"(?:^|\t)file:([^\t\n]+)", re.M)
# minisign: 2-byte algorithm magic, 8-byte key id, then the signature.
SIG_BLOB_BYTES = 2 + 8 + 64


class ManifestError(Exception):
    """A manifest (or one of its inputs) that must not be published."""


def artifact_url(platform):
    try:
        return DL_BASE + EXPECTED_ARTIFACTS[platform]
    except KeyError:
        raise ManifestError(
            "unknown updater platform %r; this client ships %s only"
            % (platform, ", ".join(sorted(KNOWN_PLATFORMS))))


def decode_signature(text):
    """Return the minisign document a Tauri `.sig` file wraps, or raise.

    This is `base64_to_string()` from tauri-plugin-updater: the exact bytes the
    client will hand to minisign_verify::Signature::decode. Anything that does
    not survive that round trip cannot be verified by a client, so it must never
    be published — including a signature that was base64-decoded once by hand
    and pasted in as text.
    """
    if not isinstance(text, str):
        raise ManifestError("signature must be text, got %s" % type(text).__name__)
    stripped = text.strip()
    if not stripped:
        raise ManifestError("signature is empty")
    if stripped.startswith(("http://", "https://", "/", "./")):
        raise ManifestError("signature is a path or URL (%s); the manifest must carry "
                            "the content of the .sig file" % stripped[:60])
    try:
        raw = base64.b64decode(stripped, validate=True)
    except Exception as exc:
        raise ManifestError("signature is not the base64 document Tauri writes: %s" % exc)
    try:
        document = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ManifestError("signature does not decode to utf-8 minisign text: %s" % exc)
    if not UNTRUSTED_COMMENT_RE.search(document):
        raise ManifestError("decoded signature has no minisign 'untrusted comment:' line")
    lines = [line.strip() for line in document.splitlines() if line.strip()]
    blobs = [line for line in lines if BASE64_BLOB_RE.match(line)]
    if not blobs:
        raise ManifestError("decoded signature carries no base64 payload line")
    # First blob is the minisign signature frame: magic + key id + 64-byte ed25519.
    frame = base64.b64decode(blobs[0])
    if len(frame) != SIG_BLOB_BYTES:
        raise ManifestError("minisign signature frame is %d bytes, expected %d"
                            % (len(frame), SIG_BLOB_BYTES))
    return document, frame


def signature_key_id(frame):
    """The 8-byte minisign key id inside a signature frame (for reporting)."""
    return frame[2:10]


def signed_file_name(document):
    """The file name recorded in the trusted comment, if any."""
    match = TRUSTED_FILE_RE.search(document)
    return match.group(1).strip() if match else None


def read_signature(path):
    """The verbatim text of a .sig file, proven to be a wrapped minisign document."""
    path = pathlib.Path(path)
    if not path.is_file():
        raise ManifestError("signature file not found: %s" % path)
    text = path.read_text(encoding="utf-8", errors="strict")
    try:
        decode_signature(text)
    except ManifestError as exc:
        raise ManifestError("%s: %s" % (path, exc))
    return text.strip()


def expected_signed_name(sig_path):
    """'foo.AppImage.sig' -> 'foo.AppImage' (None when there is no .sig)."""
    name = pathlib.Path(sig_path).name
    if name.endswith(".sig"):
        return name[:-len(".sig")]
    return None


def build_manifest(version, signatures, pub_date=None, notes=""):
    """Assemble the manifest dict. `signatures` maps platform -> .sig path.

    Every platform entry is checked before anything is returned: a manifest is
    published as one object, so half a valid manifest is worthless.
    """
    build_config.validate_version(version)
    if not isinstance(notes, str) or not notes.strip():
        raise ManifestError("notes must be a non-empty string — the update dialog shows them")

    pub_date = pub_date or datetime.datetime.now(
        datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    validate_pub_date(pub_date)

    if not signatures:
        raise ManifestError("no platforms given: an empty manifest would leave "
                            "every client answering 'no update information'")

    platforms = {}
    for platform in sorted(signatures):
        sig_path = signatures[platform]
        signature = read_signature(sig_path)
        url = artifact_url(platform)
        signed_name = expected_signed_name(sig_path)
        artifact_name = url.rsplit("/", 1)[-1]
        if signed_name is not None and signed_name != artifact_name:
            raise ManifestError(
                "%s: signature %s covers %r but the manifest points at %r — "
                "the client would reject the download"
                % (platform, sig_path, signed_name, artifact_name))
        platforms[platform] = {"url": url, "signature": signature}

    manifest = {
        "version": version,
        "notes": notes.strip(),
        "pub_date": pub_date,
        "platforms": platforms,
    }
    errors = validate_manifest(manifest)
    if errors:
        raise ManifestError("assembled manifest is invalid:\n    - %s" % "\n    - ".join(errors))
    return manifest


def validate_pub_date(pub_date):
    if not isinstance(pub_date, str) or not RFC3339_RE.match(pub_date):
        raise ManifestError("pub_date %r is not RFC 3339 (e.g. 2026-11-07T18:00:00Z)" % (pub_date,))
    normalised = re.sub(r"[Zz]$", "+00:00", pub_date)
    try:
        datetime.datetime.fromisoformat(normalised)
    except ValueError as exc:
        raise ManifestError("pub_date %r is not a real timestamp: %s" % (pub_date, exc))


def validate_manifest(data):
    """Every rule from the module docstring, on an already parsed manifest.

    Returns a list of human-readable errors; [] means publishable.
    """
    errors = []
    if not isinstance(data, dict):
        return ["manifest must be a JSON object, got %s" % type(data).__name__]

    for key in REQUIRED_TOP_KEYS:
        if key not in data:
            errors.append("missing required field '%s'" % key)

    if "version" in data:
        try:
            build_config.validate_version(data["version"])
        except build_config.BuildConfigError as exc:
            errors.append("version: %s" % exc)

    if "pub_date" in data:
        try:
            validate_pub_date(data["pub_date"])
        except ManifestError as exc:
            errors.append(str(exc))

    notes = data.get("notes")
    if "notes" in data and (not isinstance(notes, str) or not notes.strip()):
        errors.append("notes must be a non-empty string")

    platforms = data.get("platforms")
    if "platforms" in data:
        if not isinstance(platforms, dict) or not platforms:
            errors.append("platforms must be a non-empty object")
            platforms = {}
        unknown = sorted(set(platforms) - set(KNOWN_PLATFORMS))
        if unknown:
            errors.append("unknown platform keys %s (this client ships %s)"
                          % (", ".join(unknown), ", ".join(sorted(KNOWN_PLATFORMS))))
        for platform, entry in (platforms or {}).items():
            if not isinstance(entry, dict):
                errors.append("%s: entry must be an object" % platform)
                continue
            url = entry.get("url")
            signature = entry.get("signature")
            if not isinstance(url, str) or not url:
                errors.append("%s: url is missing" % platform)
            else:
                if not url.startswith("https://"):
                    errors.append("%s: url %r is not https" % (platform, url))
                host = url.split("/")[2] if len(url.split("/")) > 2 else ""
                if host != build_config.EXPECTED_UPDATER_HOST:
                    errors.append("%s: url %r is not on %s"
                                  % (platform, url, build_config.EXPECTED_UPDATER_HOST))
                if url.rsplit("/", 1)[-1].endswith((".msi", ".deb", ".rpm")):
                    errors.append("%s: %r is a package, not the signed installer this "
                                  "feed publishes (AppImage + NSIS setup.exe). The "
                                  "plugin resolves <os>-<arch>-<installer> before the "
                                  "bare key, so listing a package here would move "
                                  "dpkg/rpm/msiexec installs out from under their own "
                                  "databases — those kinds stay manual."
                                  % (platform, url))
                if platform in EXPECTED_ARTIFACTS and url != artifact_url(platform):
                    errors.append("%s: url %r must be the stable artifact %r"
                                  % (platform, url, artifact_url(platform)))
            if "signature" not in entry:
                errors.append("%s: signature is missing" % platform)
            else:
                try:
                    decode_signature(signature)
                except ManifestError as exc:
                    errors.append("%s: signature: %s" % (platform, exc))
    return errors


def load_manifest(path):
    path = pathlib.Path(path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ManifestError("manifest not found: %s" % path)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError("manifest %s is not readable JSON: %s" % (path, exc))


def write_manifest(manifest, out_path):
    out = pathlib.Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
                   encoding="utf-8")
    return out


def summarise(manifest):
    """Human-readable one-liner per platform, for CI logs (no key material)."""
    lines = ["version %s, pub_date %s" % (manifest["version"], manifest["pub_date"])]
    for platform, entry in sorted(manifest["platforms"].items()):
        try:
            document, frame = decode_signature(entry["signature"])
            key_id = signature_key_id(frame).hex().upper()
            signed = signed_file_name(document) or "?"
        except ManifestError:
            key_id, signed = "unreadable", "?"
        lines.append("  %-16s %s  key id %s  signed from %s"
                     % (platform, entry["url"], key_id, signed))
    return "\n".join(lines)


def summarise(manifest):
    """One line per platform for CI logs: version, URL, key id, signed name."""
    lines = ["version %s, pub_date %s" % (manifest["version"], manifest["pub_date"])]
    for platform, entry in sorted(manifest.get("platforms", {}).items()):
        try:
            document, frame = decode_signature(entry["signature"])
            key_id = signature_key_id(frame).hex().upper()
            signed = signed_file_name(document) or "?"
        except ManifestError:
            key_id, signed = "unreadable", "?"
        lines.append("  %-16s %s  key id %s  signed from %s"
                     % (platform, entry["url"], key_id, signed))
    return "\n".join(lines)


def parse_platform_arg(value):
    if "=" not in value:
        raise argparse.ArgumentTypeError("--platform expects KEY=<path>.sig, got %r" % value)
    platform, path = value.split("=", 1)
    return platform.strip(), path.strip()


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="updater_manifest.py",
        description="Build and validate the Tauri updater manifest (latest.json).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build", help="assemble and validate latest.json")
    p_build.add_argument("--version", required=True)
    p_build.add_argument("--pub-date", default=None, help="RFC 3339 (default: now, UTC)")
    p_build.add_argument("--notes", default=None, help="notes text")
    p_build.add_argument("--notes-file", default=None, help="notes read from this file")
    p_build.add_argument("--platform", action="append", type=parse_platform_arg, required=True,
                         dest="platforms", metavar="KEY=<file>.sig",
                         help="one per built platform; repeatable")
    p_build.add_argument("--out", required=True)

    p_validate = sub.add_parser("validate", help="validate an existing manifest")
    p_validate.add_argument("--manifest", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            if args.notes and args.notes_file:
                raise ManifestError("pass --notes or --notes-file, not both")
            if args.notes_file:
                notes = pathlib.Path(args.notes_file).read_text(encoding="utf-8")
            else:
                notes = args.notes or ""
            signatures = dict(args.platforms)
            if len(signatures) != len(args.platforms):
                raise ManifestError("duplicate platform key in --platform arguments")
            manifest = build_manifest(args.version, signatures, pub_date=args.pub_date, notes=notes)
            out = write_manifest(manifest, args.out)
            print("wrote %s\n%s" % (out, summarise(manifest)))
            return 0

        if args.command == "validate":
            data = load_manifest(args.manifest)
            errors = validate_manifest(data)
            if errors:
                for error in errors:
                    print("updater_manifest: %s" % error, file=sys.stderr)
                return 1
            print(summarise(data))
            return 0
    except ManifestError as exc:
        print("updater_manifest: %s" % exc, file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
