#!/usr/bin/env python3
"""Tests for the Element Call widget swap in the Element Web image.

The image is the pinned upstream one plus an overlay, and the upstream image
ships a stock Element Call under /app/widgets/element-call/ — no per-person
volume memory and no hide-this-stream control. The overlay replaces that widget
wholesale with the archive .github/workflows/build-element-call.yml publishes
(pinned in element-desktop/element-call.lock.json by tag + sha256: one pin for
both clients), and the build has to fail when anything but our bundle lands in
the image.

The checks themselves live in element-desktop/scripts/element-call-widget.py —
one implementation for both clients, never a fork. element-web/scripts/
element-call-widget.py is the thin adapter that only supplies the Web URL
prefix: the browser client serves the app from the site root, so the widget is
opened at /widgets/element-call/ (the desktop shell serves it two levels down,
at /webapp/widgets/element-call/).

    python3 -m unittest discover -s element-web/tests -p 'test_element_call_widget.py'

stdlib only; no network, no Docker, no new dependencies.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent
ROOT = WEBAPP.parent
ADAPTER = WEBAPP / "scripts" / "element-call-widget.py"
COMMITTED_CORE = WEBAPP / "scripts" / "element-call-widget-core.py"
DESKTOP_CORE = ROOT / "element-desktop" / "scripts" / "element-call-widget.py"
DESKTOP_LOCK = ROOT / "element-desktop" / "element-call.lock.json"

MOUNT = "widgets/element-call"
URL_PREFIX = "/widgets/element-call"

# The smallest tree that passes every check: the bundle markers our Element Call
# carries (patches 0004/0005 plus the per-person volume store), the Russian
# label for the hide-stream control, and the archive's own Plotina markers.
OUR_INDEX = (
    "<!doctype html><html lang=\"en\"><head><script>window.__plotinaEc=true;</script>"
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    '<script src="/noise/boot.js"></script>'
    '<script src="/noise/plotina-panel.js"></script>'
    '<script src="/noise/source-link.js" defer></script>'
    '<meta charset="UTF-8"><link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">'
    '<link rel="preload" href="/config.json" as="fetch">'
    '<script type="module" crossorigin src="/assets/index-OURS.js"></script>'
    '<link rel="stylesheet" crossorigin href="/assets/index-OURS.css">'
    "<title>Plotina Call</title></head><body><div id=\"root\"></div></body></html>"
)
OUR_BUNDLE = (
    "var a=\"video_tile.stream_paused\",b=\"video_tile.watch_stream\","
    "c=\"video_tile.screen_share_visibility\",d=\"cc.plotina.voice_volumes\","
    "e=this.setSubscribed.bind(this),g=\"/assets/ringtone-OURS.mp3\";"
    "const m={f:[\"assets/spa-OURS.js\"]};"
)
# The build .16 replaces. It looks like ours but hides streams through a submenu
# keyed video_tile.hide_stream, which the card says must be gone.
SUPERSEDED_BUNDLE = (
    "var a=\"video_tile.hide_stream\",b=\"video_tile.screen_share_visibility\","
    "c=\"cc.plotina.voice_volumes\",d=this.setSubscribed.bind(this);"
)
# The stock widget as the pinned upstream image ships it (index-Bz16m3ir.js and
# ./assets/ are literal: that is what /app/widgets/element-call/ contains in
# vectorim/element-web:v1.12.32).
UPSTREAM_INDEX = (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Element Call</title><script>window.global = window;</script>"
    '<script type="module" crossorigin src="./assets/index-Bz16m3ir.js"></script>'
    '<link rel="modulepreload" crossorigin href="./assets/rolldown-runtime-BN9lgz8A.js">'
    '<link rel="stylesheet" crossorigin href="./assets/index-DpQMpGAv.css">'
    "</head><body class=\"no-theme\"><div id=\"root\"></div></body></html>"
)
UPSTREAM_BUNDLE = (
    "var a=\"video_tile.always_show\",b=\"io.element.call.reaction\","
    "c=this.setSubscribed.bind(this);"
)


def adapter_module():
    """Import element-web/scripts/element-call-widget.py as a module."""
    spec = importlib.util.spec_from_file_location("element_call_widget_web", ADAPTER)
    assert spec and spec.loader, f"missing {ADAPTER}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_archive(root: Path, *, ours: bool = True, with_noise: bool = True,
                 ru_label: bool = True, marker: bool = True) -> Path:
    """Write a plotina-element-call.tar.gz-shaped archive under root."""
    stage = root / "stage" / "element-call-plotina"
    (stage / "assets").mkdir(parents=True)
    (stage / "index.html").write_text(OUR_INDEX if ours else UPSTREAM_INDEX, encoding="utf-8")
    (stage / "assets" / ("index-OURS.js" if ours else "index-Bz16m3ir.js")).write_text(
        OUR_BUNDLE if ours else UPSTREAM_BUNDLE, encoding="utf-8"
    )
    (stage / "assets" / "index-OURS.css").write_text(
        "body{background:url(/assets/bg.png)}", encoding="utf-8"
    )
    (stage / "assets" / "ru-app-CTBNJ8GR.json").write_text(
        json.dumps({"video_tile": {"stream_paused": "Стрим приостановлен"}} if ru_label else {"a": "b"},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    (stage / "config.json").write_text('{"livekit":{"livekit_service_url":"https://x"}}', encoding="utf-8")
    if marker:
        (stage / "plotina-icon.svg").write_text("<svg/>", encoding="utf-8")
    if with_noise:
        # The archive ships its own copy of the shared noise layer. The image
        # already serves one at /app/noise/, and a second copy would initialize
        # the denoiser twice and add 24 MB to the layer.
        (stage / "noise").mkdir()
        (stage / "noise" / "boot.js").write_text("/*dfn*/", encoding="utf-8")
    tarball = root / "plotina-element-call.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(stage, arcname="element-call-plotina")
    return tarball


def make_base_image_app(root: Path) -> Path:
    """An /app as the pinned upstream image ships it: index.html + stock widget."""
    app = root / "app"
    (app / MOUNT / "assets").mkdir(parents=True)
    (app / "index.html").write_text("<html><head></head><body></body></html>", encoding="utf-8")
    (app / "bundles" / "81bff4fd060173d686ec").mkdir(parents=True)
    (app / "bundles" / "81bff4fd060173d686ec" / "app.js").write_text("var a=1;", encoding="utf-8")
    (app / MOUNT / "index.html").write_text(UPSTREAM_INDEX, encoding="utf-8")
    (app / MOUNT / "assets" / "index-Bz16m3ir.js").write_text(UPSTREAM_BUNDLE, encoding="utf-8")
    (app / MOUNT / "assets" / "ru-app-GuuWXZzS.json").write_text(
        json.dumps({"video_tile": {"always_show": "Всегда показывать"}}, ensure_ascii=False),
        encoding="utf-8",
    )
    (app / MOUNT / "config.json").write_text('{"matrix_rtc_session":{}}', encoding="utf-8")
    return app


def write_lock(root: Path, url: str, sha256: str) -> Path:
    lock = root / "element-call.lock.json"
    lock.write_text(json.dumps({"tag": "v0.26.1-plotina-call.15", "url": url, "sha256": sha256},
                               indent=4) + "\n", encoding="utf-8")
    return lock


def sha256_of(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_adapter(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run the adapter CLI the way the Dockerfile does."""
    return subprocess.run(
        [sys.executable, str(ADAPTER), *args],
        capture_output=True, text=True, timeout=600,
        env={**os.environ, **(env or {})},
    )


class UpstreamWidgetIsTheNegativeControlTest(unittest.TestCase):
    """The swap is only worth anything if the check refuses the stock widget.

    The fixture is the layout the pinned upstream image really has: the widget
    from the element-web tarball, opened at ./assets/index-Bz16m3ir.js, carrying
    none of our patches.
    """

    def test_check_rejects_the_upstream_widget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app = make_base_image_app(Path(tmp))
            proc = run_adapter("--check", "--webapp", str(app))
            self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("cc.plotina.voice_volumes", proc.stderr)
            self.assertIn("video_tile.stream_paused", proc.stderr)
            self.assertIn("Стрим приостановлен", proc.stderr)
            self.assertIn("plotina-icon.svg", proc.stderr)

    def test_check_rejects_the_superseded_widget(self) -> None:
        """The build .16 replaces still carries the hide_stream menu: refuse it."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"),
                               "--webapp", str(app))
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            (app / MOUNT / "assets" / "index-OURS.js").write_text(
                SUPERSEDED_BUNDLE, encoding="utf-8")
            check = run_adapter("--check", "--webapp", str(app))
            self.assertNotEqual(check.returncode, 0)
            self.assertIn("hide_stream", check.stderr)
            self.assertIn("superseded", check.stderr)

    def test_check_accepts_the_upstream_widget_only_after_the_swap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            self.assertNotEqual(run_adapter("--check", "--webapp", str(app)).returncode, 0)
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertEqual(run_adapter("--check", "--webapp", str(app)).returncode, 0)


class WebPrefixTest(unittest.TestCase):
    """The browser client serves the app from the site root, so the widget is
    opened at /widgets/element-call/ — not at the desktop's /webapp/... mount."""

    def test_default_prefix_is_the_web_mount(self) -> None:
        module = adapter_module()
        self.assertEqual(module.URL_PREFIX, URL_PREFIX)
        # The prefix has to sit on top of the checker's own mount: the widget is
        # installed at <mount>/ and served at <prefix>/assets/…
        self.assertEqual(module.load_core([]).MOUNT, MOUNT)
        self.assertEqual(URL_PREFIX, "/" + MOUNT)

    def test_asset_urls_are_rebased_onto_the_web_mount(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            widget = app / MOUNT
            html = (widget / "index.html").read_text(encoding="utf-8")
            self.assertIn(f'src="{URL_PREFIX}/assets/index-OURS.js"', html)
            self.assertIn(f'href="{URL_PREFIX}/config.json"', html)
            self.assertIn(f'href="{URL_PREFIX}/plotina-icon.svg"', html)
            self.assertNotIn('src="/assets/', html)
            bundle = (widget / "assets" / "index-OURS.js").read_text(encoding="utf-8")
            self.assertNotIn('"/assets/', bundle)
            self.assertNotIn('"assets/', bundle)
            self.assertIn(f'"{URL_PREFIX}/assets/ringtone-OURS.mp3"', bundle)

    def test_no_desktop_mount_survives_in_the_image(self) -> None:
        """A /webapp/... path would 404 in the browser: Element Web has no
        vector:// handler, and its bundle opens ./widgets/element-call/."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            for path in (app / MOUNT).rglob("*"):
                if path.is_file() and path.suffix in (".html", ".js", ".css"):
                    self.assertNotIn("/webapp/widgets/element-call", path.read_text(encoding="utf-8"),
                                     msg=str(path))

    def test_explicit_url_prefix_is_honoured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"),
                               "--webapp", str(app), "--url-prefix", "/somewhere/else")
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            html = (app / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertIn('src="/somewhere/else/assets/index-OURS.js"', html)
            # The check follows the prefix it was given, not the default.
            self.assertNotEqual(run_adapter("--check", "--webapp", str(app)).returncode, 0)
            self.assertEqual(
                run_adapter("--check", "--webapp", str(app),
                            "--url-prefix", "/somewhere/else").returncode, 0)


class NoiseLayerIsNotDuplicatedTest(unittest.TestCase):
    """The image already serves the shared noise layer at /app/noise/."""

    def test_archive_noise_tree_does_not_land_in_the_widget(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertFalse((app / MOUNT / "noise").exists())

    def test_widget_loads_the_image_noise_layer_through_the_web_root(self) -> None:
        """The widget index sits at /widgets/element-call/, so ../../noise/ is
        /noise/ — the same bytes the app document loads."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            html = (app / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertIn('src="../../noise/plotina-dfn.js"', html)
            # .17 removed the floating capsule: OUR_INDEX still carries the panel
            # tag, so it has to be stripped, not rebased onto the mount.
            self.assertNotIn("plotina-panel", html)
            self.assertEqual(html.count("noise/plotina-dfn.js"), 1)
            self.assertNotIn('src="/noise/', html)
            self.assertNotIn("noise/boot.js", html)

    def test_widget_index_keeps_the_call_app_marker(self) -> None:
        """boot.js no-ops on window.__plotinaEc, which is what keeps the app
        document's getUserMedia wrapper out of the widget page."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            html = (app / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertIn("window.__plotinaEc=true", html)


class InstallReplacesWidgetTest(unittest.TestCase):
    def test_no_upstream_file_survives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            widget = app / MOUNT
            self.assertFalse((widget / "assets" / "index-Bz16m3ir.js").exists())
            self.assertEqual(
                sorted(p.name for p in (widget / "assets").iterdir()),
                ["index-OURS.css", "index-OURS.js", "ru-app-CTBNJ8GR.json"],
            )
            self.assertTrue((widget / "plotina-icon.svg").is_file())

    def test_install_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            first = (app / MOUNT / "index.html").read_text(encoding="utf-8")
            run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            second = (app / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertEqual(first, second)

    def test_upstream_archive_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root, ours=False)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertNotEqual(proc.returncode, 0)

    def test_sha256_mismatch_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), "0" * 64)
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("sha256 mismatch", proc.stderr)

    def test_missing_ru_label_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = make_base_image_app(root)
            tarball = make_archive(root, ru_label=False)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            proc = run_adapter("--lock", str(lock), "--work", str(root / "work"), "--webapp", str(app))
            self.assertNotEqual(proc.returncode, 0)


class OneCheckerForBothClientsTest(unittest.TestCase):
    """No fork of the swap logic: the adapter must load the desktop module, so
    the two clients cannot drift apart on what "our widget" means."""

    def test_adapter_loads_the_committed_core_copy(self) -> None:
        """The context is element-web/ alone, so the adapter takes the committed
        copy — which the drift test above keeps byte-identical to the desktop."""
        module = adapter_module()
        core = module.load_core([])
        self.assertEqual(Path(core.__file__).resolve(), COMMITTED_CORE.resolve())
        self.assertIs(module.core, core)
        self.assertEqual(COMMITTED_CORE.read_bytes(), DESKTOP_CORE.read_bytes())

    def test_adapter_falls_back_to_the_desktop_module(self) -> None:
        """Without the copy (a checkout that has not staged it) the repo's desktop
        module is what runs: same file, so still one implementation."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = Path(tmp)
            (ctx / "scripts").mkdir()
            adapter = ctx / "scripts" / "element-call-widget.py"
            adapter.write_text(ADAPTER.read_text(encoding="utf-8"), encoding="utf-8")
            # HERE.parent.parent is now tmp/, so point the repo fallback at the
            # real tree through the one documented override.
            env = {**os.environ, "ELEMENT_CALL_WIDGET_CORE": str(DESKTOP_CORE)}
            proc = subprocess.run(
                [sys.executable, str(adapter), "--check", "--webapp", str(ctx)],
                capture_output=True, text=True, timeout=120, env=env,
            )
            self.assertNotEqual(proc.returncode, 0)
            # The message names the tree it looked at, proving the desktop module
            # produced this verdict rather than a missing-file error.
            self.assertIn("widgets/element-call", proc.stderr)

    def test_adapter_prefers_a_sibling_core_in_the_build_context(self) -> None:
        """element-web/ is the Docker build context and the desktop tree is not
        in it, so the context carries the same bytes as element-call-widget-core.py."""
        with tempfile.TemporaryDirectory() as tmp:
            ctx = Path(tmp)
            (ctx / "scripts").mkdir()
            (ctx / "scripts" / "element-call-widget.py").write_text(
                ADAPTER.read_text(encoding="utf-8"), encoding="utf-8")
            (ctx / "scripts" / "element-call-widget-core.py").write_text(
                DESKTOP_CORE.read_text(encoding="utf-8"), encoding="utf-8")
            app = make_base_image_app(ctx / "app-root")
            proc = subprocess.run(
                [sys.executable, str(ctx / "scripts" / "element-call-widget.py"),
                 "--check", "--webapp", str(app)],
                capture_output=True, text=True, timeout=120,
            )
            # Same verdict as the repo copy: the upstream widget is refused, and
            # the message proves the sibling core was the one that ran.
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("cc.plotina.voice_volumes", proc.stderr)

    def test_adapter_without_any_core_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ctx = Path(tmp)
            (ctx / "scripts").mkdir()
            adapter = ctx / "scripts" / "element-call-widget.py"
            adapter.write_text(ADAPTER.read_text(encoding="utf-8"), encoding="utf-8")
            proc = subprocess.run([sys.executable, str(adapter), "--check", "--webapp", str(ctx)],
                                  capture_output=True, text=True, timeout=120)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("element-call-widget-core.py", proc.stderr)


class DockerfileWiringTest(unittest.TestCase):
    """The swap only protects the image if the build actually runs it."""

    def setUp(self) -> None:
        self.dockerfile = (WEBAPP / "Dockerfile").read_text(encoding="utf-8")

    def test_widget_swap_layer_installs_with_the_web_prefix(self) -> None:
        self.assertIn("COPY scripts/element-call-widget.py", self.dockerfile)
        self.assertIn("COPY scripts/element-call-widget-core.py", self.dockerfile)
        self.assertIn("COPY element-call.lock.json", self.dockerfile)
        self.assertIn("--webapp /app", self.dockerfile)
        self.assertIn(f"--url-prefix {URL_PREFIX}", self.dockerfile)

    def _run_layers(self) -> list[str]:
        """Every RUN instruction with its line continuations joined."""
        layers: list[str] = []
        current: list[str] = []
        for line in self.dockerfile.splitlines():
            if current:
                current.append(line)
                if not line.rstrip().endswith("\\"):
                    layers.append("\n".join(current))
                    current = []
                continue
            if line.startswith("RUN "):
                current = [line]
                if not line.rstrip().endswith("\\"):
                    layers.append(line)
                    current = []
        if current:
            layers.append("\n".join(current))
        return layers

    def test_build_fails_when_the_widget_is_not_ours(self) -> None:
        """--check runs in the same layer as the install: a build that swapped
        in anything but our bundle must not finish."""
        layers = [l for l in self._run_layers() if "element-call-widget.py" in l]
        self.assertEqual(len(layers), 1, "expected exactly one widget layer")
        layer = layers[0]
        self.assertIn("--check", layer)
        install_at = layer.index("element-call-widget.py")
        check_at = layer.index("--check", install_at)
        self.assertLess(install_at, check_at, "the check must run after the install")
        # And it must run before the layer's cleanup, or it would check the
        # leftovers rather than the image: `set -eux` makes the exit code count.
        self.assertIn("set -eux", layer)

    def test_build_asserts_both_features_in_the_image(self) -> None:
        self.assertIn("cc.plotina.voice_volumes", self.dockerfile)
        self.assertIn("setSubscribed", self.dockerfile)

    def test_build_asserts_the_paused_stream_and_rejects_the_old_menu(self) -> None:
        """.16 hides other streams by default and the hide_stream submenu is gone,
        so the image layer must demand the new key and refuse the old one."""
        self.assertIn("video_tile.stream_paused", self.dockerfile)
        self.assertIn("Стрим приостановлен", self.dockerfile)
        self.assertIn('test "$(grep -o video_tile.hide_stream "$bundle" | wc -l)" -eq 0',
                      self.dockerfile)

    def test_widget_noise_tags_resolve_inside_the_image(self) -> None:
        """../../noise/ from /widgets/element-call/ is /app/noise/, so the file
        the widget's index loads has to be in the image — and the capsule panel
        .17 removed must not be, not even as a stale COPY."""
        self.assertIn("COPY noise/plotina-dfn.js /app/noise/plotina-dfn.js", self.dockerfile)
        self.assertNotIn("COPY noise/plotina-panel.js", self.dockerfile)
        self.assertIn("! test -e /app/noise/plotina-panel.js", self.dockerfile)

    def test_build_context_stages_one_pin_for_both_clients(self) -> None:
        """One Element Call for both clients: element-web/ carries byte copies of
        the pin and of the checker, so the Docker context is self-contained (the
        desktop tree is not in it). Drift between the copies fails here, exactly
        like LICENSE-AGPL-3.0 / NOTICE are guarded — not in two places of truth."""
        for copy, canonical in (
            (WEBAPP / "element-call.lock.json", DESKTOP_LOCK),
            (WEBAPP / "scripts" / "element-call-widget-core.py", DESKTOP_CORE),
        ):
            with self.subTest(copy=copy.name):
                self.assertTrue(copy.is_file(), msg=f"{copy} missing")
                self.assertEqual(copy.read_bytes(), canonical.read_bytes(),
                                 msg=f"{copy} drifted from {canonical}")

    def test_the_pin_is_not_forked(self) -> None:
        """A second pin with its own tag would let the two clients ship different
        Element Calls; the copies must stay one pin."""
        lock = json.loads((WEBAPP / "element-call.lock.json").read_text(encoding="utf-8"))
        desktop = json.loads(DESKTOP_LOCK.read_text(encoding="utf-8"))
        self.assertEqual(lock, desktop)

    def test_ci_builds_the_context_that_contains_the_pin(self) -> None:
        """The workflow copies element-web/. into its context, so the committed
        lock and checker ride along — no extra staging step to forget."""
        workflow = (ROOT / ".github" / "workflows" / "build-element-web.yml").read_text(
            encoding="utf-8")
        self.assertIn("cp -a element-web/. \"$context\"/", workflow)
        self.assertIn("cp -a noise \"$context/noise\"", workflow)

    def test_smoke_test_serves_the_widget(self) -> None:
        smoke = (WEBAPP / "scripts" / "smoke-image.sh").read_text(encoding="utf-8")
        self.assertIn("/widgets/element-call/", smoke)
        self.assertIn("/noise/plotina-dfn.js", smoke)


class RepositoryPinTest(unittest.TestCase):
    def test_the_pin_is_a_real_tag_and_digest(self) -> None:
        lock = json.loads(DESKTOP_LOCK.read_text(encoding="utf-8"))
        self.assertRegex(lock["tag"], r"^v\d+\.\d+\.\d+-plotina-call\.\d+$")
        self.assertRegex(lock["sha256"], r"^[0-9a-f]{64}$")
        self.assertTrue(lock["url"].endswith(f"/{lock['tag']}/plotina-element-call.tar.gz"))

    def test_readme_documents_the_widget_swap(self) -> None:
        readme = (WEBAPP / "README.md").read_text(encoding="utf-8")
        self.assertIn("widgets/element-call", readme)
        self.assertIn("cc.plotina.voice_volumes", readme)


if __name__ == "__main__":
    unittest.main()
