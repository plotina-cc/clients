#!/usr/bin/env python3
"""Mount Plotina's Element Call into a built Cinny (Lite) dist.

Usage:
  mount-element-call.py --dist cinny/dist --lock cinny/element-call.lock.json
  mount-element-call.py --dist cinny/dist --archive plotina-element-call.tar.gz
  mount-element-call.py --dist cinny/dist --check        # gate, writes nothing

What it does, and why each step is not optional:

  * replaces dist/public/element-call/ -- in Lite that path holds upstream's
    @element-hq/element-call-embedded 0.20.1, which has neither the stream
    hiding control nor per-participant volume;
  * rebases the archive from the site root onto the mount. The archive is built
    as if it were the whole site (absolute /assets/, /noise/, /config.json), so
    without rebasing every asset 404s. The frame stays same-origin with the app,
    which is what makes localStorage (the noise level) and the widget handshake
    work without a CSP exception;
  * keeps the archive's own noise/ tree INSIDE the mount. The old pipeline
    copied a 50 MB noise/ to the dist root that no frame loaded (the frame is
    our archive, and it carries the denoiser itself) -- that copy is gone, and
    plotina-dfn.js is pointed at the mount instead of location.origin;
  * injects the account-data sender (element-call/plotina-account-data.js)
    unless the bundle already sends cc.plotina.set_account_data itself, so a
    future archive that carries the action natively retires the shim;
  * refuses to install an archive that is not ours: hide_stream,
    screen_share_visibility and cc.plotina.voice_volumes must be in the bundle.

The loader/verifier half is adapted from element-desktop/scripts/
element-call-widget.py (same archive, same rebasing defects); lock handling and
download are imported from there rather than copied.
"""
import argparse
import hashlib
import re
import shutil
import sys
import tempfile
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLIENT = HERE.parent
REPO = CLIENT.parent

MOUNT = "public/element-call"
URL_PREFIX = "/public/element-call"
ARCHIVE_ROOT = "element-call-plotina"
EC_MARKER = "window.__plotinaEc"
SENDER_NAME = "plotina-account-data.js"
SENDER_SRC = REPO / "element-call" / SENDER_NAME
ACTION = "cc.plotina.set_account_data"

# Every marker is a feature the card names; upstream 0.20.1 has none of them.
BUNDLE_MARKERS = (
    "video_tile.hide_stream",
    "screen_share_visibility",
    "cc.plotina.voice_volumes",
)
NOISE_REQUIRED = (
    "noise/plotina-dfn.js",
    "noise/dfn/v3/pkg/df_bg.wasm",
    "noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz",
)
DFN_BASE_FROM_ORIGIN = 'location.origin + "/noise"'


def _desktop_tool():
    """The Desktop installer's lock/download helpers, reused as-is."""
    path = REPO / "element-desktop" / "scripts" / "element-call-widget.py"
    if not path.is_file():
        sys.exit(f"mount-element-call: missing {path}")
    spec = spec_from_file_location("element_call_widget", path)
    if spec is None or spec.loader is None:
        sys.exit(f"mount-element-call: cannot load {path}")
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _bundle_files(frame: Path) -> list:
    return sorted(p for p in (frame / "assets").rglob("*.js") if p.is_file())


def _bundle_text(frame: Path) -> str:
    return "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in _bundle_files(frame))


def _has_native_sender(frame: Path) -> bool:
    """True when the archive's bundle sends the action itself (future builds)."""
    return ACTION in _bundle_text(frame)


def _rebase(path: Path, prefix: str) -> None:
    """Rewrite root-absolute URLs onto the mount path (idempotent)."""
    prefix = prefix.rstrip("/")
    root = prefix + "/"
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".html":
        def rebase_attr(match: "re.Match[str]") -> str:
            attr, url = match.group(1), match.group(2)
            if url.startswith(root):
                return match.group(0)
            return f'{attr}="{root}{url.lstrip("/")}"'

        text = re.sub(r'(href|src)="(/[^"]*)"', rebase_attr, text)
        text = text.replace('content="/plotina-512.png"', f'content="{root}plotina-512.png"')
    # The frame resolves its denoiser from an absolute path because Element Call
    # serves /room/ with a trailing slash; point that absolute path at the mount.
    text = text.replace(DFN_BASE_FROM_ORIGIN, f'"{root}noise"')
    for quote in ('"', "'", "`", "("):
        text = text.replace(f"{quote}/assets/", f"{quote}{root}assets/")
        text = text.replace(f"{quote}assets/", f"{quote}{root}assets/")
    text = text.replace('"/config.json"', f'"{root}config.json"')
    text = text.replace('"/plotina-icon.svg"', f'"{root}plotina-icon.svg"')
    text = text.replace('"/plotina-512.png"', f'"{root}plotina-512.png"')
    path.write_text(text, encoding="utf-8")


def _inject_sender(frame: Path, prefix: str) -> None:
    """Wire the account-data sender, exactly once, or stand down if native."""
    index = frame / "index.html"
    html = index.read_text(encoding="utf-8")
    target = frame / "noise" / SENDER_NAME
    tag = f'<script src="{prefix}/noise/{SENDER_NAME}"></script>'

    if _has_native_sender(frame):
        # The archive sends the action itself: no shim, and drop a stale copy so
        # a rebuilt archive cannot end up with two senders.
        if SENDER_NAME in html or target.exists():
            html = html.replace(tag, "")
            index.write_text(html, encoding="utf-8")
            target.unlink(missing_ok=True)
            print(f"sender: native in the bundle, removed {SENDER_NAME}")
        return

    if not SENDER_SRC.is_file():
        sys.exit(f"mount-element-call: missing sender {SENDER_SRC}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SENDER_SRC, target)
    if SENDER_NAME in html:
        return
    # Before the app bundle: the shim installs a property setter on
    # window.matrixclient and must be in place before Element Call assigns it.
    anchor = '<script type="module"'
    if anchor in html:
        html = html.replace(anchor, tag + anchor, 1)
    elif "</head>" in html:
        html = html.replace("</head>", tag + "</head>", 1)
    else:
        sys.exit("mount-element-call: index.html has no place for the sender tag")
    index.write_text(html, encoding="utf-8")
    print(f"sender: {target.relative_to(frame)}")


def check_frame(frame: Path) -> list:
    """Every reason this directory is not our Element Call ([] = good)."""
    failures = []
    index = frame / "index.html"
    if not index.is_file():
        return [f"{frame}/index.html is missing"]
    html = index.read_text(encoding="utf-8")

    if EC_MARKER not in html:
        failures.append(f"index.html has no {EC_MARKER}: not our archive")
    if "<title>Plotina Call</title>" not in html:
        failures.append("index.html does not carry the Plotina Call title")
    if "./assets/" in html:
        failures.append("index.html still uses root-relative ./assets/ (not rebased)")
    if 'src="/assets/' in html:
        failures.append("index.html still uses the site-root /assets/ (not rebased)")
    if not (frame / "plotina-icon.svg").is_file():
        failures.append("plotina-icon.svg is missing (archive was not ours)")

    bundle = _bundle_text(frame)
    for marker in BUNDLE_MARKERS:
        if marker not in bundle:
            failures.append(f"frame bundle has no {marker}")

    labels = list((frame / "assets").glob("ru-app-*.json"))
    if not labels:
        failures.append("ru-app-*.json label file is missing")
    elif not any("hide_stream" in p.read_text(encoding="utf-8", errors="replace") for p in labels):
        failures.append("ru label has no hide_stream key")

    for rel in NOISE_REQUIRED:
        if not (frame / rel).is_file():
            failures.append(f"denoiser asset {rel} is missing")

    dfn = frame / "noise" / "plotina-dfn.js"
    if dfn.is_file() and DFN_BASE_FROM_ORIGIN in dfn.read_text(encoding="utf-8"):
        failures.append("plotina-dfn.js still resolves its models from location.origin")

    maps = list(frame.rglob("*.map"))
    if maps:
        failures.append(f"{len(maps)} source map(s) shipped with the frame")

    native = _has_native_sender(frame)
    shim_tag = f"/noise/{SENDER_NAME}" in html
    shim_file = (frame / "noise" / SENDER_NAME).is_file()
    if native and (shim_tag or shim_file):
        failures.append("two account-data senders: the bundle sends the action and a shim is installed")
    if not native and not shim_tag:
        failures.append(f"no account-data sender: bundle has no {ACTION} and no {SENDER_NAME}")
    if not native and shim_tag and not shim_file:
        failures.append(f"index.html references {SENDER_NAME} but the file is missing")
    if html.count(SENDER_NAME) > 1:
        failures.append(f"{SENDER_NAME} is tagged more than once")
    return failures


def verify_frame(frame: Path) -> None:
    failures = check_frame(frame)
    if failures:
        sys.exit(
            "mount-element-call: refusing this Element Call frame:\n  - "
            + "\n  - ".join(failures)
        )


def prepare(src: Path, dst: Path, prefix: str) -> None:
    """Copy the archive into dst, rebased onto the mount path."""
    shutil.copytree(src, dst)
    for path in [*dst.rglob("*.html"), *dst.rglob("*.js"), *dst.rglob("*.css")]:
        _rebase(path, prefix)
    for stale in dst.rglob("*.map"):
        stale.unlink()
    _inject_sender(dst, prefix)


def install(tarball: Path, dist: Path, mount: str = MOUNT,
            url_prefix: str = URL_PREFIX, *, archive_sha256: str = "") -> Path:
    """Replace dist/<mount>/ with our Element Call from tarball."""
    dist = dist.resolve()
    if not (dist / "index.html").is_file():
        sys.exit(f"mount-element-call: {dist} is not a built Cinny dist (no index.html)")
    if archive_sha256:
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        if digest != archive_sha256:
            sys.exit(f"mount-element-call: {tarball} sha256 {digest} != lock {archive_sha256}")

    work = Path(tempfile.mkdtemp(prefix="ec-mount-", dir=tarball.parent))
    try:
        tool = _desktop_tool()
        src = tool.unpack(tarball, work)
        prepared = work / "prepared"
        prepare(src, prepared, url_prefix.rstrip("/"))
        # Verify before touching the dist: a broken archive must leave the tree
        # as it was, never half-swapped.
        verify_frame(prepared)

        target = dist / mount
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(prepared, target)
        if (dist / "noise").exists():
            print(
                "mount-element-call: note: dist/noise is still there; "
                "the frame carries its own copy and apply-noise.py removes it"
            )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return target


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--mount", default=MOUNT)
    ap.add_argument("--url-prefix", default=URL_PREFIX)
    ap.add_argument("--archive", help="local plotina-element-call.tar.gz")
    ap.add_argument("--lock", help="element-call.lock.json (url + sha256)")
    ap.add_argument("--work", help="download cache (default: next to the lock)")
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()

    dist = Path(args.dist).resolve()
    if args.check:
        verify_frame(dist / args.mount)
        print(f"ok: {dist / args.mount} is our Element Call")
        return

    sha = ""
    if args.archive:
        tarball = Path(args.archive).resolve()
    elif args.lock:
        tool = _desktop_tool()
        lock = tool.read_lock(Path(args.lock))
        work = Path(args.work).resolve() if args.work else Path(args.lock).resolve().parent / ".build" / "element-call"
        work.mkdir(parents=True, exist_ok=True)
        tarball = tool.fetch_archive(lock, work)
        sha = lock["sha256"]
    else:
        ap.error("one of --archive or --lock is required")

    target = install(tarball, dist, args.mount, args.url_prefix, archive_sha256=sha)
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    print(f"ok: {target} ({size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
