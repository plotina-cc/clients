#!/usr/bin/env python3
"""Assemble the self-hosted Element Call bundle for plotina.cc.

Python port of element-call/build.sh — the shell script is now a thin wrapper
that execs this file. The sequence, the `==> ...` progress lines, the pins
loaded from pins.env and every assertion are the bash original's, one-for-one:
this module is the build of record and build.sh only exists so CI keeps
calling the same entry point.

Pure-ish parts (argument parsing, pins/config validation, `du -h` formatting,
the bundle assertions) are factored into functions and unit-tested in
tests/build_py_test.py.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# The usage block of build.sh's header comment (its lines 2-34, `sed 's/^# \{0,1\}//'`),
# kept verbatim so -h prints the same text the shell script always printed.
USAGE = """
Assemble the self-hosted Element Call bundle for plotina.cc.

Two modes:
  release (default)  take the upstream release tarball, verify its SHA-256,
                     inject noise/, brand it as Plotina Call, add config.json.
                     No toolchain, ~40 MB of downloads, seconds of CPU.
  source             clone the tag and run `pnpm build:full`. Only worth it
                     when we carry a change that cannot be applied to the
                     built bundle — the release tarball is upstream's own
                     build output for that tag.

Usage:
  element-call/build.sh [options]

  --mode release|source   default: release
  --tag vX.Y.Z            default: EC_TAG from pins.env
  --out DIR               default: <repo>/dist
  --noise DIR             default: <repo>/noise
  --dfn-dir DIR           existing noise/dfn tree (v3/pkg, v3/models) instead
                          of downloading the two assets
  --config FILE           default: element-call/config.json
  --icons DIR             default: <repo>/branding/icons (the Plotina marks)
  --maps-out DIR          copy each source map and its script to DIR, then
                          drop the maps from the bundle (CI uploads DIR to
                          GlitchTip; the served JS keeps working because the
                          SDK talks to the server, not to the .map file)
  --markers-out FILE      where apply-patches.sh writes the `<patch><TAB><marker>`
                          list (default: $OUT/plotina-markers.txt). The artifact
                          gate in CI reads it after the build: every marker must
                          be inside the bundle, or the run fails.
  --sentry-cli FILE       sentry-cli binary: inject debug ids into the build
                          before --maps-out copies it elsewhere. Optional;
                          without it maps are still split out, just unlabelled
  --keep                  keep the work directory for inspection

Output: $OUT/plotina-element-call.tar.gz containing element-call-plotina/.
"""

# --- errors ---------------------------------------------------------------


class BuildError(Exception):
    """Fatal error; main() prints `error: <message>` and exits 1, like die()."""


class UsageExit(Exception):
    """-h/--help: print USAGE, exit 0."""

    def __init__(self, text: str):
        super().__init__(text)
        self.text = text


# --- argument handling -----------------------------------------------------

_VALUE_OPTS = {
    "--mode": "mode",
    "--tag": "tag",
    "--out": "out",
    "--noise": "noise",
    "--dfn-dir": "dfn_dir",
    "--config": "config",
    "--icons": "icons",
    "--maps-out": "maps_out",
    "--markers-out": "markers_out",
    "--sentry-cli": "sentry_cli",
}


def parse_args(argv: list[str]) -> dict:
    """The bash `while (($#)); do case ...` loop, one-for-one.

    Unset options stay ""; defaults are applied afterwards by apply_defaults(),
    mirroring the shell's pre-set variables. A value that is missing *or empty*
    aborts (bash `${2:?--x needs a value}`); the next token is taken verbatim,
    even if it starts with `--`, exactly like the shell did.
    """
    opts: dict = {key: "" for key in _VALUE_OPTS.values()}
    opts["keep"] = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-h", "--help"):
            raise UsageExit(USAGE)
        if arg == "--keep":
            opts["keep"] = True
            i += 1
            continue
        key = _VALUE_OPTS.get(arg)
        if key is None:
            raise BuildError(f"unknown argument: {arg} (try --help)")
        if i + 1 >= len(argv) or argv[i + 1] == "":
            raise BuildError(f"{arg} needs a value")
        opts[key] = argv[i + 1]
        i += 2
    return opts


def validate_mode(mode: str) -> None:
    if mode not in ("release", "source"):
        raise BuildError(f"--mode must be release or source, not '{mode}'")


def apply_defaults(opts: dict, pins: dict, here: Path, repo: Path) -> dict:
    """The shell's pre-set MODE/TAG/OUT/... variables plus `:-` fallbacks."""
    mode = opts["mode"] or "release"
    validate_mode(mode)
    return {
        "mode": mode,
        "tag": opts["tag"] or pins["EC_TAG"],
        "out": Path(opts["out"] or repo / "dist"),
        "noise": Path(opts["noise"] or repo / "noise"),
        "dfn_dir": Path(opts["dfn_dir"]) if opts["dfn_dir"] else None,
        "config": Path(opts["config"] or here / "config.json"),
        "icons": Path(opts["icons"] or repo / "branding" / "icons"),
        "maps_out": Path(opts["maps_out"]) if opts["maps_out"] else None,
        "markers_out": Path(opts["markers_out"]) if opts["markers_out"]
        else (Path(opts["out"] or repo / "dist") / "plotina-markers.txt"),
        "sentry_cli": opts["sentry_cli"] or None,
        "keep": bool(opts["keep"]),
    }


def release_name(tag: str, environ: dict) -> str:
    # The name events are grouped under in GlitchTip. Written to
    # $OUT/sentry-release.txt by the --maps-out step so the upload cannot
    # drift from the build. Mirrors ${VITE_SENTRY_RELEASE:-element-call@$TAG}.
    return environ.get("VITE_SENTRY_RELEASE") or f"element-call@{tag}"


# --- pins.env --------------------------------------------------------------


def load_pins(path: Path) -> dict:
    """Plain KEY=VALUE lines of pins.env, without sourcing it through bash.

    Comments and blank lines are skipped; the file promises no quoting.
    """
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise BuildError(f"pins.env: not a KEY=VALUE line: {line}")
        pins[key.strip()] = value.strip()
    return pins


def require_pins(pins: dict, keys: list[str]) -> None:
    for key in keys:
        if not pins.get(key):
            raise BuildError(f"pins.env: missing {key}")


# --- upstream --------------------------------------------------------------


def strip_v(tag: str) -> str:
    """bash's ${TAG#v}: drop one leading 'v'."""
    return tag[1:] if tag.startswith("v") else tag


def tarball_url(tag: str) -> str:
    return (
        "https://github.com/element-hq/element-call/releases/download/"
        f"{tag}/element-call-{strip_v(tag)}.tar.gz"
    )


def check_tag_pin(tag: str, ec_tag: str) -> None:
    if tag != ec_tag:
        raise BuildError(
            f"--tag {tag} is not the pinned {ec_tag}; "
            "bump EC_TAG and EC_TARBALL_SHA256 in pins.env together"
        )


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha(path: Path, expected: str, say=print) -> None:
    """The `echo '<sha>  <file>' | sha256sum -c -` of pins.env usage."""
    if sha256_of(path) == expected:
        say(f"{path}: OK")
    else:
        raise BuildError(f"sha256sum: {path}: FAILED (checksum did not match)")


def download(url: str, dst: Path) -> None:
    """curl -fsSL --retry 3 --retry-delay 2."""
    last: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "plotina-element-call-build"})
            with urllib.request.urlopen(request, timeout=300) as resp, open(dst, "wb") as fh:
                shutil.copyfileobj(resp, fh)
            return
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            last = exc
            if attempt < 3:
                time.sleep(2)
    raise BuildError(f"download failed: {url} ({last})")


def fetch_release(work: Path, tag: str, ec_tag: str, sha256: str, say=print,
                  download=download) -> Path:
    check_tag_pin(tag, ec_tag)
    url = tarball_url(tag)
    say(f"downloading {url}")
    tar = work / "upstream.tar.gz"
    download(url, tar)
    # sha256sum -c prints its verdict unprefixed, on stdout
    verify_sha(tar, sha256)

    say("extracting")
    with tarfile.open(tar, "r:gz") as tf:
        tf.extractall(path=work, filter="data")
    top = f"element-call-{strip_v(tag)}"
    if not (work / top).is_dir():
        raise BuildError(f"unexpected tarball layout: no {top}/")
    shutil.move(str(work / top), str(work / "dist"))
    return work / "dist"


def _tree_contains(root: Path, needle: bytes) -> bool:
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            try:
                if needle in Path(dirpath, name).read_bytes():
                    return True
            except OSError:
                continue
    return False


def apply_patch_set(here: Path, src: Path, markers: Path, say=print) -> None:
    """Apply every element-call/patches/*.patch through scripts/apply-patches.sh.

    One entry point for the whole repository: the script sorts with LC_ALL=C, checks each patch
    against the tree the previous ones built, refuses a patch without a marker or a file count that
    does not match, and writes the marker list the artifact gate reads after the build.
    """
    script = here.parent / "scripts" / "apply-patches.sh"
    if not script.is_file():
        raise BuildError(f"the patch script is missing: {script}")
    markers.parent.mkdir(parents=True, exist_ok=True)
    say(f"applying plotina patches through {script.name}")
    proc = subprocess.run(["bash", str(script), str(here), str(src), str(markers)])
    if proc.returncode != 0:
        raise BuildError("applying the Plotina patches failed; the script named the patch above")


def build_from_source(work: Path, conf: dict, pins: dict, release: str,
                      environ: dict, here: Path, say=print) -> Path:
    if not shutil.which("node"):
        raise BuildError(f"--mode source needs node {pins['NODE_VERSION']} on PATH")
    major = subprocess.run(["node", "-p", 'process.versions.node.split(".")[0]'],
                           capture_output=True, text=True, check=True).stdout.strip()
    if int(major) < int(pins["NODE_VERSION"]):
        found = subprocess.run(["node", "-v"], capture_output=True, text=True, check=True).stdout.strip()
        say(f"warning: upstream pins Node {pins['NODE_VERSION']}, found {found}")

    say(f"cloning {pins['EC_REPO']} at {conf['tag']}")
    subprocess.run(["git", "clone", "--depth", "1", "--branch", conf["tag"],
                    pins["EC_REPO"], str(work / "src")], check=True)

    apply_patch_set(here, work / "src", conf["markers_out"], say=say)

    if not shutil.which("pnpm"):
        say(f"activating pnpm@{pins['PNPM_VERSION']} through corepack")
        subprocess.run(["corepack", "enable"], check=True)
        subprocess.run(["corepack", "prepare", f"pnpm@{pins['PNPM_VERSION']}", "--activate"], check=True)

    say("pnpm install && pnpm build:full (this is the 16 GB, 10-20 minute part)")
    env = dict(environ)
    # VITE_APP_VERSION is the console/rageshake version; the release is what
    # groups events in GlitchTip and must equal dist/sentry-release.txt.
    env["VITE_APP_VERSION"] = environ.get("VITE_APP_VERSION") or strip_v(conf["tag"])
    env["VITE_SENTRY_RELEASE"] = release
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=work / "src", env=env, check=True)
    subprocess.run(["pnpm", "build:full"], cwd=work / "src", env=env, check=True)

    src_dist = work / "src" / "dist"
    if not (src_dist / "index.html").is_file():
        raise BuildError("the build produced no dist/index.html")
    # The processor and its badge live in /noise/plotina-dfn.js; the bundle only
    # has the bridge that calls window.__plotinaAttach.
    if not _tree_contains(src_dist / "assets", b"__plotinaAttach"):
        raise BuildError("the Plotina track-processor bridge is not in the bundle")
    shutil.move(str(src_dist), str(work / "dist"))
    return work / "dist"


# --- source maps -----------------------------------------------------------


def split_source_maps(dist: Path, maps_out: Path, out: Path, release: str,
                      sentry_cli: str | None, say=print, run=subprocess.run) -> int:
    """--maps-out, the comment above it in build.sh applies verbatim: the
    published bundle must not ship the whole TypeScript source, so each map is
    copied out together with the script it describes and then removed. CI
    uploads the copy to GlitchTip. Debug ids are injected first (when a CLI is
    given), so the uploaded script and the served one agree on line numbers."""
    if sentry_cli:
        say("injecting debug ids into the source maps")
        run([sentry_cli, "sourcemaps", "inject", str(dist / "assets")], check=True)

    say(f"copying source maps to {maps_out}")
    maps = 0
    for map_path in sorted(p for p in dist.rglob("*.map") if p.is_file()):
        rel = map_path.relative_to(dist)
        dest = maps_out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(map_path, dest)
        script = map_path.with_name(map_path.name[: -len(".map")])
        if script.is_file():
            shutil.copy2(script, maps_out / str(rel)[: -len(".map")])
        map_path.unlink()
        maps += 1

    if maps == 0:
        say("warning: the build produced no source maps")
    if any(p.is_file() for p in dist.rglob("*.map")):
        raise BuildError("source maps are still in the bundle")

    out.mkdir(parents=True, exist_ok=True)
    (out / "sentry-release.txt").write_text(release + "\n", encoding="utf-8")
    return maps


# --- noise -----------------------------------------------------------------


def _install(src: Path, dst_dir: Path) -> None:
    """install -m 0644."""
    _install_as(src, dst_dir / src.name)


def _install_as(src: Path, dst: Path) -> None:
    if not src.is_file():
        raise BuildError(f"missing input: {src}")
    shutil.copyfile(src, dst)
    os.chmod(dst, 0o644)


def copy_noise(dist: Path, noise: Path, source_link: Path) -> None:
    (dist / "noise" / "vendor").mkdir(parents=True, exist_ok=True)
    # No level panel: the control is the Settings -> Audio row in the patched
    # Element Call bundle. A plotina-panel.js left in noise/ is not shipped.
    for name in ("logic.js", "boot.js", "plotina-dfn.js"):
        _install(noise / name, dist / "noise")
    _install(source_link, dist / "noise")
    _install(noise / "vendor" / "dfn.esm.js", dist / "noise" / "vendor")
    # The vendored module is third-party; its licences travel with it.
    for lic in sorted((noise / "vendor").glob("LICENSE-*")):
        if lic.is_file():
            _install(lic, dist / "noise" / "vendor")


def install_dfn(dist: Path, dfn_dir: Path | None, base: str, wasm_sha: str,
                model_sha: str, say=print, download=download) -> None:
    pkg = dist / "noise" / "dfn" / "v3" / "pkg"
    models = dist / "noise" / "dfn" / "v3" / "models"
    pkg.mkdir(parents=True, exist_ok=True)
    models.mkdir(parents=True, exist_ok=True)
    wasm = pkg / "df_bg.wasm"
    model = models / "DeepFilterNet3_onnx.tar.gz"
    if dfn_dir:
        say(f"copying DeepFilterNet3 assets from {dfn_dir}")
        _install(dfn_dir / "v3" / "pkg" / "df_bg.wasm", pkg)
        _install(dfn_dir / "v3" / "models" / "DeepFilterNet3_onnx.tar.gz", models)
    else:
        say("downloading DeepFilterNet3 assets")
        download(f"{base}/pkg/df_bg.wasm", wasm)
        download(f"{base}/models/DeepFilterNet3_onnx.tar.gz", model)
    verify_sha(wasm, wasm_sha)
    verify_sha(model, model_sha)


# --- config ----------------------------------------------------------------


def install_config_text(text: str) -> str:
    """The python3 heredoc from build.sh, verbatim in logic and messages."""
    config = json.loads(text)
    hs = config.get("default_server_config", {}).get("m.homeserver", {})
    if not hs.get("base_url") or not hs.get("server_name"):
        raise BuildError("config.json: default_server_config.m.homeserver needs base_url and server_name")
    if config.get("matrix_rtc_mode") not in (None, "compatibility", "matrix_2_0"):
        raise BuildError("config.json: matrix_rtc_mode must be compatibility or matrix_2_0")
    return json.dumps(config, indent=2, ensure_ascii=False) + "\n"


def install_config(src: Path, dst: Path) -> None:
    dst.write_text(install_config_text(src.read_text(encoding="utf-8")), encoding="utf-8")


# --- assertions ------------------------------------------------------------


def check_inputs(noise: Path, config: Path, icons: Path) -> None:
    for f in (noise / "logic.js", noise / "boot.js", noise / "plotina-dfn.js",
              noise / "vendor" / "dfn.esm.js",
              config, icons / "plotina-green.svg", icons / "png" / "green-48.png",
              icons / "png" / "green-512.png"):
        if not f.is_file():
            raise BuildError(f"missing input: {f}")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def check_bundle(dist: Path, icons: Path, *, say=print,
                 inject_check=lambda: None, branding_check=lambda: None) -> None:
    """`checking the bundle` + the independent branding asserts, in bash order.

    inject_check/branding_check re-run the two tools' --check with stdout
    silenced, exactly like the `>/dev/null` redirects did; they raise or exit
    on failure on their own.
    """
    inject_check()
    index = _read(dist / "index.html")
    if "/noise/logic.js" not in index:
        raise BuildError("logic.js tag missing from index.html")
    if "/noise/plotina-panel.js" in index:
        raise BuildError("index.html still loads the floating noise panel")
    if "/noise/source-link.js" not in index:
        raise BuildError("source-link.js tag missing from index.html")
    if not _nonempty(dist / "noise" / "source-link.js"):
        raise BuildError("source-link.js is missing from the bundle")
    if (dist / "noise" / "plotina-panel.js").exists():
        raise BuildError("plotina-panel.js is still in the bundle")
    if "assets/" not in index:
        raise BuildError("no asset references in index.html; wrong tarball?")
    if not sorted((dist / "assets").glob("index-*.js")):
        raise BuildError("no hashed app bundle under assets/")
    if not _nonempty(dist / "config.json"):
        raise BuildError("config.json is empty")
    if not _nonempty(dist / "NOTICE"):
        raise BuildError("NOTICE is empty")

    # Branding, asserted independently of branding.py's own --check: a shell
    # that says Plotina, an icon tree that came from branding/icons, no
    # upstream URL.
    branding_check()
    if "Element Call" in index:
        raise BuildError("index.html still says 'Element Call'")
    if "<title>Plotina Call</title>" not in index:
        raise BuildError("index.html has no Plotina Call title")
    if 'href="/plotina-icon.svg"' not in index:
        raise BuildError("index.html points its icon somewhere else")
    if 'content="/plotina-512.png"' not in index:
        raise BuildError("index.html has no Plotina social card")
    for icon in ("plotina-icon.svg", "plotina-512.png", "favicon.png"):
        if not _nonempty(dist / icon):
            raise BuildError(f"{icon} is missing from the bundle")
    if (dist / "favicon.png").read_bytes() != (icons / "png" / "green-48.png").read_bytes():
        raise BuildError("favicon.png is not the Plotina 48px mark")
    for pattern in (r"https://element\.io/privacy", r"https://element\.io/cookie-policy",
                    r"docs\.element\.io"):
        hit = False
        for js in sorted((dist / "assets").glob("*.js")):
            if re.search(pattern, _read(js)):
                hit = True
                break
        if hit:
            raise BuildError(f"the bundle still links {pattern}")

    wasm_size = _file_size(dist / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm")
    model_size = _file_size(dist / "noise" / "dfn" / "v3" / "models" / "DeepFilterNet3_onnx.tar.gz")
    if not wasm_size > 10000000:
        raise BuildError(f"df_bg.wasm is {wasm_size}B; expected ~16 MB")
    if not model_size > 7000000:
        raise BuildError(f"model is {model_size}B; expected ~8 MB")


def _nonempty(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def _file_size(path: Path) -> int:
    return path.stat().st_size


# --- package ---------------------------------------------------------------


def du_h(size: int) -> str:
    """`du -h`'s rendering of a byte count (GNU coreutils human output):
    exponent chosen as floor(log1024), one decimal kept while the value is
    under 10, plain bytes below 1K."""
    if size < 1024:
        return str(size)
    unit = "KMGTP"
    value = float(size)
    e = 0
    while value >= 1024 and e < len(unit):
        value /= 1024
        e += 1
    if value < 10:
        return f"{value:.1f}{unit[e - 1]}"
    return f"{value:.0f}{unit[e - 1]}"


def pack(src_dir: Path, artifact: Path, out_dir: Path) -> None:
    """tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf.

    Same input, same bytes: makes a rebuild comparable with the published
    asset. Entry order, mtimes and ownership are pinned the same way GNU tar
    is pinned in build.sh; the gzip header carries mtime 0 as well.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    root = src_dir.name
    entries: list[tuple[str, Path, bool]] = [(root + "/", src_dir, True)]
    for dirpath, dirs, files in os.walk(src_dir):
        base = Path(dirpath)
        for name in sorted(dirs):
            p = base / name
            rel = p.relative_to(src_dir)
            entries.append((f"{root}/{rel}/", p, True))
        for name in sorted(files):
            p = base / name
            rel = p.relative_to(src_dir)
            entries.append((f"{root}/{rel}", p, False))
    entries.sort(key=lambda e: e[0])

    raw = open(artifact, "wb")
    try:
        gz = gzip.GzipFile(filename="", mode="wb", compresslevel=6, mtime=0, fileobj=raw)
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
            for arc, path, is_dir in entries:
                info = tf.gettarinfo(str(path), arcname=arc)
                info.name = arc
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                if is_dir or not info.isfile():
                    tf.addfile(info)
                else:
                    with open(path, "rb") as fh:
                        tf.addfile(info, fh)
        gz.close()
    finally:
        raw.close()


# --- main ------------------------------------------------------------------


def main(argv: list[str] | None = None, environ: dict | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    environ = dict(os.environ if environ is None else environ)
    # bash writes each printf line as it goes; keep stdout line-buffered so our
    # `==> ...` lines interleave with inject-noise/branding output the same way.
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    here = Path(__file__).resolve().parent
    repo = here.parent

    def say(msg: str) -> None:
        print(f"==> {msg}")

    try:
        pins = load_pins(here / "pins.env")
        require_pins(pins, ["EC_TAG", "EC_TARBALL_SHA256", "DFN_BASE",
                            "DFN_WASM_SHA256", "DFN_MODEL_SHA256"])
        opts = parse_args(argv)
        mode = opts["mode"] or "release"
        validate_mode(mode)
        if mode == "source":
            require_pins(pins, ["EC_REPO", "NODE_VERSION", "PNPM_VERSION"])
        conf = apply_defaults(opts, pins, here=here, repo=repo)
        release = release_name(conf["tag"], environ)

        check_inputs(conf["noise"], conf["config"], conf["icons"])

        work = Path(tempfile.mkdtemp())
        try:
            if conf["mode"] == "release":
                dist = fetch_release(work, conf["tag"], pins["EC_TAG"],
                                     pins["EC_TARBALL_SHA256"], say=say)
            else:
                dist = build_from_source(work, conf, pins, release, environ, here, say=say)

            if conf["maps_out"]:
                split_source_maps(dist, conf["maps_out"], conf["out"], release,
                                  conf["sentry_cli"], say=say)

            say("patching index.html")
            rc = subprocess.run([sys.executable, str(here / "inject-noise.py"),
                                 str(dist / "index.html")]).returncode
            if rc:
                return rc
            rc = subprocess.run([sys.executable, str(here / "inject-noise.py"),
                                 "--check", str(dist / "index.html")]).returncode
            if rc:
                return rc

            say("branding as Plotina Call")
            # Ours to brand: the shell of index.html, the strings the bundle
            # prints and the element.io links. branding.py counts every literal
            # it rewrites and aborts when the pinned tag does not carry the
            # number its rule table expects.
            rc = subprocess.run([sys.executable, str(here / "branding.py"),
                                 "--icons", str(conf["icons"]), str(dist)]).returncode
            if rc:
                return rc
            rc = subprocess.run([sys.executable, str(here / "branding.py"),
                                 "--icons", str(conf["icons"]), "--check", str(dist)]).returncode
            if rc:
                return rc

            say("copying noise/ into the bundle")
            copy_noise(dist, conf["noise"], here / "source-link.js")

            install_dfn(dist, conf["dfn_dir"], pins["DFN_BASE"],
                        pins["DFN_WASM_SHA256"], pins["DFN_MODEL_SHA256"], say=say)

            say("installing config.json")
            install_config(conf["config"], dist / "config.json")

            # Upstream's LICENSE-AGPL-3.0 is byte-identical to our repository
            # LICENSE, and the release tarball ships no licence files at all,
            # so carry it in the bundle.
            _install_as(repo / "LICENSE", dist / "LICENSE-AGPL-3.0")
            _install(repo / "NOTICE", dist)

            say("checking the bundle")
            def silent_check(script: str, extra: list[str]) -> None:
                rc = subprocess.run([sys.executable, str(here / script), *extra],
                                    stdout=subprocess.DEVNULL).returncode
                if rc:
                    raise SystemExit(rc)

            check_bundle(
                dist, conf["icons"], say=say,
                inject_check=lambda: silent_check("inject-noise.py", ["--check", str(dist / "index.html")]),
                branding_check=lambda: silent_check("branding.py", ["--icons", str(conf["icons"]), "--check", str(dist)]),
            )

            stage = work / "stage" / "element-call-plotina"
            stage.mkdir(parents=True)
            shutil.copytree(str(dist), str(stage), symlinks=True, dirs_exist_ok=True)

            artifact = conf["out"] / "plotina-element-call.tar.gz"
            say(f"packing {artifact}")
            pack(stage, artifact, conf["out"])

            say("done")
            files = sum(len(fs) for _r, _d, fs in os.walk(stage))
            print(f"    artifact  {artifact} ({du_h(artifact.stat().st_blocks * 512)})")
            print(f"    sha256    {sha256_of(artifact)}")
            print(f"    upstream  element-call {conf['tag']} ({conf['mode']} mode)")
            print(f"    files     {files}")
            return 0
        finally:
            if conf["keep"]:
                say(f"work directory kept: {work}")
            else:
                shutil.rmtree(work, ignore_errors=True)
    except UsageExit as exc:
        print(str(exc), end="" if str(exc).endswith("\n") else "\n")
        return 0
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        # set -e in bash propagated the child's exit code; do the same.
        return exc.returncode


if __name__ == "__main__":
    sys.exit(main())
