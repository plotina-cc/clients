#!/usr/bin/env python3
"""Install Plotina's Element Call as the desktop webapp's call widget.

    element-call-widget.py --lock element-call.lock.json --work .build --webapp <dir>
    element-call-widget.py --check --webapp <dir>

Why this exists: element-web opens its call widget from
`webapp/widgets/element-call/`, and in the pinned upstream tarball that directory
is a stock Element Call build with none of our patches (element-call/patches/):
no per-person volume memory (patch 0004) and no hide-this-stream control (patch
0005). Taking the tarball's widget means Desktop silently lacks both features
while the web client at call.plotina.cc has them.

So the widget is replaced wholesale by the archive
.github/workflows/build-element-call.yml publishes (pinned in
element-desktop/element-call.lock.json by tag + sha256 — never "latest").
Upstream's copy is deleted first, so no upstream file can survive the swap.

Two things the archive cannot ship as-is:

1. It is built for a site root (call.plotina.cc), but the shell serves the
   webapp from vector://vector/webapp/ and the widget lives two levels down.
   Every root-absolute `/assets/...` URL would 404 and the widget would render
   an empty #root. The install rebases them onto /webapp/widgets/element-call.

2. Its index.html carries the edge's `/noise/...` script tags and a copy of the
   shared noise layer. The desktop webapp already has that layer at its root
   (apply-noise.py), the widget is served from two levels down, and a second
   copy would initialize the denoiser twice. The install drops the archive's
   noise/ tree and points the tags at ../../noise/.

Every check below is a negative control against the upstream widget: see
tests/test_element_call_widget.py, which feeds it the real upstream layout and
requires a non-zero exit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

# Where the archive's files land inside the webapp, and the absolute URL path the
# vector:// handler resolves them under (electron-main.ts: /webapp/<rel> -> asar/<rel>).
MOUNT = "widgets/element-call"
URL_PREFIX = "/webapp/" + MOUNT

# Root directory inside plotina-element-call.tar.gz.
ARCHIVE_ROOT = "element-call-plotina"

# Features that only exist in our Element Call. The upstream build contains none
# of them, which is what makes these checks fail on the wrong widget.
BUNDLE_MARKERS = (
    "video_tile.stream_paused",
    "video_tile.screen_share_visibility",
    "cc.plotina.voice_volumes",
)
# Keys the previous build carried and this one must not. Build .16 replaced the
# hide_stream submenu with the paused tile and the eye button, so a bundle that
# still ships the key is the superseded build, not the one the lock pins.
SUPERSEDED_MARKERS = ("video_tile.hide_stream",)
# Patch 0005's label as the user sees it; proves the ru locale of *our* bundle.
RU_LABEL = "Стрим приостановлен"
# Markers that only the Plotina build carries.
PLOTINA_MARKERS = ("window.__plotinaEc",)
PLOTINA_FILES = ("plotina-icon.svg",)

# The desktop noise layer the call widget needs, relative from
# webapp/widgets/element-call/ to the webapp's own noise/. Only this one:
#   - plotina-dfn.js owns the microphone path here (the bundle's publish hook
#     calls window.__plotinaAttach); the level control itself moved into Element
#     Call's Settings -> Audio with .17, so the floating capsule script that used
#     to ride along (plotina-panel.js) is neither shipped nor loaded any more;
#   - boot.js is deliberately absent — it no-ops on window.__plotinaEc
#     (noise/boot.js, CALL_APP) and would wrap getUserMedia a second time;
#   - logic.js is absent because neither of the two reads PlotinaNoiseLogic
#     (they carry their own constants), so loading it here adds nothing.
WIDGET_NOISE_TAGS = (
    '<script src="../../noise/plotina-dfn.js"></script>',
)
# Absolute tags written by element-call/inject-noise.py for call.plotina.cc. The
# panel tag is the one .17 stopped emitting; it stays in the strip list so an
# older archive handed to --check has its capsule tag removed, not rebased.
ARCHIVE_NOISE_TAGS = (
    '<script src="/noise/logic.js"></script>',
    '<script src="/noise/plotina-dfn.js"></script>',
    '<script src="/noise/boot.js"></script>',
    '<script src="/noise/plotina-panel.js"></script>',
    '<script src="/noise/source-link.js" defer></script>',
)
EC_MARKER = "<script>window.__plotinaEc=true;</script>"

# matcher for an asset URL that would resolve outside the widget under vector://
ROOT_ABSOLUTE = ('"/assets/', "'/assets/", "`/assets/", "(/assets/")
# Vite keeps its lazy-chunk map as bare quoted "assets/x.js" entries; those
# resolve against the document URL, which under vector:// is the origin root.
BARE_ASSET = ('"assets/', "'assets/", "`assets/")
# index.html carries bare href/src attributes (the <link rel="preload"
# href="/config.json"> and the icon), which the JS string rewrites do not touch.
HTML_ATTRS = ('href="', 'src="')


def read_lock(lock_path: Path) -> dict:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    for key in ("tag", "url", "sha256"):
        if not lock.get(key):
            sys.exit(f"element-call.lock.json: missing {key!r}; pin tag, url and sha256 together")
    if len(lock["sha256"]) != 64:
        sys.exit(f"element-call.lock.json: sha256 {lock['sha256']!r} is not a hex digest")
    return lock


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, dst: Path) -> None:
    """Fetch url to dst. Local file:// and plain paths are allowed for tests."""
    parsed = urllib.parse.urlparse(url)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if parsed.scheme in ("", "file"):
        src = Path(urllib.request.url2pathname(parsed.path) if parsed.scheme else url)
        shutil.copyfile(src, dst)
        return
    with urllib.request.urlopen(url, timeout=600) as resp, dst.open("wb") as fh:
        shutil.copyfileobj(resp, fh)


def fetch_archive(lock_path: Path, work: Path) -> Path:
    """Return the local archive for the lock, verifying sha256 either way.

    Same cache policy as prepare-webapp.sh uses for the element-web tarball: a
    file in WORK whose digest matches is reused, anything else is fetched again
    (a corrupted or half-written cache must never be unpacked).
    """
    lock = read_lock(lock_path)
    tarball = work / Path(urllib.parse.urlparse(lock["url"]).path).name
    if tarball.is_file() and sha256_file(tarball) == lock["sha256"]:
        print(f"    cached {tarball}")
        return tarball
    print(f"    fetch {lock['url']} ({lock['tag']})")
    part = tarball.with_suffix(tarball.suffix + ".part")
    _download(lock["url"], part)
    digest = sha256_file(part)
    if digest != lock["sha256"]:
        part.unlink(missing_ok=True)
        sys.exit(
            f"element-call: sha256 mismatch for {lock['url']}\n"
            f"  expected {lock['sha256']}\n  actual   {digest}\n"
            "  the pinned archive changed: do not ship it, re-pin element-call.lock.json"
        )
    part.replace(tarball)
    return tarball


def unpack(tarball: Path, work: Path) -> Path:
    """Extract the archive; returns the element-call-plotina directory."""
    stage = Path(tempfile.mkdtemp(prefix="ec-widget-", dir=work))
    with tarfile.open(tarball, "r:gz") as tar:
        members = tar.getnames()
        if not any(name.split("/")[0] == ARCHIVE_ROOT for name in members):
            sys.exit(f"element-call: {tarball.name} has no {ARCHIVE_ROOT}/ root; wrong archive")
        if any(name.startswith("/") or ".." in Path(name).parts for name in members):
            sys.exit(f"element-call: {tarball.name} contains absolute or escaping paths")
        tar.extractall(stage)
    root = stage / ARCHIVE_ROOT
    if not (root / "index.html").is_file():
        sys.exit(f"element-call: {ARCHIVE_ROOT}/index.html missing; not an Element Call build")
    return root


def _bundle_files(widget: Path) -> list[Path]:
    return sorted(p for p in (widget / "assets").glob("*.js") if p.is_file())


def check_widget(widget: Path) -> list[str]:
    """Return the reasons this directory is not our Element Call widget.

    Empty list == ours. Every entry is a check the upstream widget fails.
    """
    failures: list[str] = []
    index = widget / "index.html"
    if not index.is_file():
        return [f"{widget}: no index.html (upstream layout changed?)"]
    html = index.read_text(encoding="utf-8")

    assets = widget / "assets"
    if not assets.is_dir():
        return [f"{widget}: no assets/ directory"]

    bundles = _bundle_files(widget)
    if not bundles:
        return [f"{widget}: no app bundle under assets/*.js"]

    blob = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in bundles)
    for marker in BUNDLE_MARKERS:
        if marker not in blob:
            failures.append(f"bundle is missing {marker} (upstream Element Call, not ours)")
    for marker in SUPERSEDED_MARKERS:
        if marker in blob:
            failures.append(
                f"bundle still carries {marker} (superseded build: streams are hidden "
                "by default and the paused tile replaced the submenu)"
            )

    locales = sorted(assets.glob("*ru-app-*.json"))
    if not locales:
        failures.append("assets/*-ru-app-*.json is missing (no Russian locale in the widget)")
    else:
        ru = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in locales)
        if RU_LABEL not in ru:
            failures.append(f"ru locale is missing {RU_LABEL!r} (paused-stream control absent)")

    for marker in PLOTINA_MARKERS:
        if marker not in html:
            failures.append(f"index.html is missing {marker} (not a Plotina build)")
    for name in PLOTINA_FILES:
        if not (widget / name).is_file():
            failures.append(f"{name} is missing (not a Plotina build)")

    # A widget-local noise layer means the archive's copy survived: the webapp
    # root already has one and two copies would double-initialize the denoiser.
    if (widget / "noise").exists():
        failures.append("widget ships its own noise/ tree; the webapp root owns the noise layer")
    for tag in ARCHIVE_NOISE_TAGS:
        if tag in html:
            failures.append(f"index.html still carries the edge script tag {tag!r}")

    for tag in WIDGET_NOISE_TAGS:
        if tag not in html:
            failures.append(f"index.html is missing the desktop noise tag {tag!r}")
    if "plotina-panel" in html:
        failures.append(
            "index.html loads the removed noise capsule panel: .17 keeps the level "
            "control in Settings -> Audio and ships no plotina-panel.js"
        )
    if html.count("noise/boot.js"):
        failures.append("index.html loads noise/boot.js in the widget; plotina-dfn.js is the caller path")

    # The archive is built for a site root; anything that still resolves there
    # 404s under vector://vector/webapp/. Three shapes have to be caught: an
    # absolute /assets/ URL, Vite's bare "assets/..." dep map, and a bare
    # HTML attribute (href="/config.json", the icon).
    for path in [index, *assets.glob("*.js"), *assets.glob("*.css")]:
        text = path.read_text(encoding="utf-8", errors="replace")
        for bad in ROOT_ABSOLUTE:
            if bad in text:
                failures.append(
                    f"{path.relative_to(widget)} still has a root-absolute asset URL {bad!r}: "
                    f"rebase it onto {URL_PREFIX}"
                )
                break
        for bad in BARE_ASSET:
            if bad in text:
                failures.append(
                    f"{path.relative_to(widget)} still has a bare {bad!r} entry (Vite dep map): "
                    f"it resolves against the origin root, rebase it onto {URL_PREFIX}"
                )
                break
        if path.suffix == ".html":
            # A correctly rebased attribute points inside the mount, so it still
            # begins with href="/…"; only a URL that resolves outside it fails.
            for bad in re.findall(r'(?:href|src)="(/[^"]*)"', text):
                if not bad.startswith(URL_PREFIX + "/"):
                    failures.append(
                        f"index.html still has a root-absolute attribute {bad!r}: "
                        f"rebase it onto {URL_PREFIX}"
                    )
                    break
    if not html.count(URL_PREFIX + "/assets/"):
        failures.append(f"index.html references no {URL_PREFIX}/assets/ URL")
    return failures


def verify_widget(widget: Path) -> None:
    failures = check_widget(widget)
    if failures:
        sys.stderr.write(f"element-call: {widget} is not the Plotina widget:\n")
        for failure in failures:
            sys.stderr.write(f"  - {failure}\n")
        sys.exit(1)


def _prepare(src: Path, dst: Path, url_prefix: str) -> None:
    """Copy the archive into dst and make it work under url_prefix."""
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("noise"))

    prefix = url_prefix.rstrip("/") + "/"
    for path in [*dst.rglob("*.html"), *dst.rglob("*.js"), *dst.rglob("*.css")]:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".html":
            for tag in ARCHIVE_NOISE_TAGS:
                text = text.replace(tag, "")
        # Both attribute and JS-string forms are rewritten in one pass, and the
        # bare-attribute and bare-Vite-entry forms only where the URL still
        # starts at the root ("/x" or "assets/x"), so a second install of the
        # same archive cannot prefix an already-prefixed path (that produced
        # /webapp/.../webapp/... and a 404 on the app bundle).
        def rebase_attr(match: "re.Match[str]") -> str:
            attr, url = match.group(1), match.group(2)
            if url.startswith(prefix):
                return match.group(0)
            return f'{attr}="{prefix}{url.lstrip("/")}"'

        text = re.sub(r'(href|src)="(/[^"]*)"', rebase_attr, text)
        text = text.replace("`/assets/", "`" + prefix + "assets/")
        text = text.replace('"/assets/', f'"{prefix}assets/')
        text = text.replace("'/assets/", f"'{prefix}assets/")
        text = text.replace("(/assets/", f"({prefix}assets/")
        for quote in ('"', "'", "`"):
            text = text.replace(f"{quote}assets/", f"{quote}{prefix}assets/")
        text = text.replace('"/plotina-icon.svg"', f'"{prefix}plotina-icon.svg"')
        text = text.replace('"/plotina-512.png"', f'"{prefix}plotina-512.png"')
        text = text.replace("`/config.json`", f"`{prefix}config.json`")
        path.write_text(text, encoding="utf-8")

    index = dst / "index.html"
    html = index.read_text(encoding="utf-8")
    if EC_MARKER not in html:
        sys.exit(f"element-call: {index} has no {EC_MARKER}; not a Plotina Element Call build")
    if "noise/boot.js" in html:
        sys.exit("element-call: the archive grew a boot.js tag; the widget must not load it")
    tags = "".join(WIDGET_NOISE_TAGS)
    html = html.replace(EC_MARKER, EC_MARKER + tags, 1)
    index.write_text(html, encoding="utf-8")


def install_widget(tarball: Path, webapp: Path, url_prefix: str = URL_PREFIX) -> Path:
    """Replace webapp/widgets/element-call/ with the archive's Element Call."""
    webapp = webapp.resolve()
    if not (webapp / "index.html").is_file():
        sys.exit(f"element-call: {webapp} is not an unpacked webapp (no index.html)")
    work = Path(tempfile.mkdtemp(prefix="ec-install-", dir=tarball.parent))
    try:
        src = unpack(tarball, work)
        prepared = work / "prepared"
        _prepare(src, prepared, url_prefix)

        # Verify before touching the webapp: a failed check must leave the tree
        # as it was, so a broken archive cannot half-swap a webapp.
        verify_widget(prepared)

        target = webapp / MOUNT
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(prepared, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return target


def _read_asar(asar: Path) -> tuple[dict[str, bytes], str]:
    """Read every file out of an asar archive.

    Layout: uint32 4, uint32 header_size, uint32 header_size+4, uint32 json_size,
    then the JSON header, then the file bytes. Reading the archive directly keeps
    the verdict tied to the packed bytes users install; `asar extract` would put
    an extra tool in the build path for no gain.
    """
    with asar.open("rb") as fh:
        _pickle, size_a, _size_b, json_size = struct.unpack("<4I", fh.read(16))
        header = json.loads(fh.read(json_size).decode("utf-8"))
        base = 8 + size_a

        def walk(node: dict, prefix: str = "") -> dict[str, bytes]:
            out: dict[str, bytes] = {}
            for name, entry in node.get("files", {}).items():
                path = f"{prefix}/{name}" if prefix else name
                if "files" in entry:
                    out.update(walk(entry, path))
                else:
                    fh.seek(base + int(entry["offset"]))
                    out[path] = fh.read(int(entry["size"]))
            return out

        return walk(header), hashlib.sha256(asar.read_bytes()).hexdigest()


def check_asar(asar: Path) -> list[str]:
    """Check the call widget as packed inside webapp.asar. Empty list == ours."""
    if not asar.is_file():
        return [f"{asar}: no such file"]
    try:
        files, _digest = _read_asar(asar)
    except (struct.error, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return [f"{asar}: not a readable asar archive ({exc})"]

    prefix = MOUNT + "/"
    widget = {p: data for p, data in files.items() if p.startswith(prefix)}
    if not widget:
        return [f"{asar}: has no {MOUNT}/ directory (the call widget is missing)"]

    # Same checks as on disk, over the packed bytes: reuse check_widget by
    # writing the widget out to a temporary directory and running it there. One
    # definition means the two cannot drift.
    work = Path(tempfile.mkdtemp(prefix="ec-asar-"))
    try:
        for path, data in widget.items():
            dst = work / path[len(prefix):]
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
        return [f"webapp.asar: {f}" for f in check_widget(work)]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="Install or verify Plotina's Element Call widget.")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--webapp", help="unpacked webapp directory")
    group.add_argument("--asar", type=Path, help="packed webapp.asar to verify")
    ap.add_argument("--lock", help="element-call.lock.json (required to install)")
    ap.add_argument("--work", help="cache directory for the archive (default: next to the lock)")
    ap.add_argument("--check", action="store_true", help="only verify the installed widget")
    ap.add_argument("--url-prefix", default=URL_PREFIX,
                    help=f"absolute path the widget is served under (default: {URL_PREFIX})")
    args = ap.parse_args()

    if args.asar:
        failures = check_asar(args.asar)
        if failures:
            sys.stderr.write(f"element-call: {args.asar} does not carry the Plotina widget:\n")
            for failure in failures:
                sys.stderr.write(f"  - {failure}\n")
            sys.exit(1)
        print(f"element-call: {args.asar} carries the Plotina widget")
        return

    webapp = Path(args.webapp).resolve()
    if args.check:
        widget = webapp / MOUNT
        verify_widget(widget)
        print(f"element-call: {widget} is the Plotina widget")
        return

    if not args.lock:
        sys.exit("element-call: --lock is required to install the widget")
    lock = Path(args.lock).resolve()
    work = Path(args.work).resolve() if args.work else lock.parent / ".build"
    work.mkdir(parents=True, exist_ok=True)

    print(f"==> element call widget from {read_lock(lock)['tag']}")
    tarball = fetch_archive(lock, work)
    target = install_widget(tarball, webapp, args.url_prefix)
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    print(f"element-call: {target} ({size // 1_000_000} MB)")


if __name__ == "__main__":
    main()
