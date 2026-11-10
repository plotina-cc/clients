#!/usr/bin/env python3
"""Tests for the Element Call widget swap in the desktop webapp.

The desktop shell serves the webapp from vector://vector/webapp/ and element-web
opens its call widget at webapp/widgets/element-call/. That widget comes from the
upstream element-web tarball and carries none of our Element Call patches, so
Desktop has neither per-person volume memory nor the hide-stream control. This
module replaces the widget wholesale with the archive built by
.github/workflows/build-element-call.yml (pinned in element-call.lock.json) and
must refuse anything that is not ours — the upstream widget is the negative
control for every check.

    cd element-desktop && python3 -m unittest discover -s tests -p 'test_element_call*.py'

stdlib only; no new dependencies.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
HELPER = DESKTOP / "scripts" / "element-call-widget.py"

_spec = importlib.util.spec_from_file_location("element_call_widget", HELPER)
assert _spec and _spec.loader, f"missing {HELPER}"
ecw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ecw)

MOUNT = "widgets/element-call"
URL_PREFIX = "/webapp/widgets/element-call"

# The smallest tree that passes every check: the bundle markers our Element Call
# carries (patches 0004/0005 plus the noise track processor), the Russian label
# for the hide-stream control, and the archive's own Plotina marker.
OUR_INDEX = (
    "<!doctype html><html><head><script>window.__plotinaEc=true;</script>"
    '<link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">'
    '<link rel="preload" href="/config.json" as="fetch">'
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    '<script src="/noise/boot.js"></script>'
    '<script src="/noise/plotina-panel.js"></script>'
    '<script src="/noise/source-link.js" defer></script>'
    '<script type="module" crossorigin src="/assets/index-OURS.js"></script>'
    "<title>Plotina Call</title></head><body><div id=\"root\"></div></body></html>"
)
OUR_BUNDLE = (
    "var a=\"video_tile.hide_stream\",b=\"video_tile.screen_share_visibility\","
    "c=\"cc.plotina.voice_volumes\",d=\"/assets/ringtone-OURS.mp3\";"
)
UPSTREAM_INDEX = (
    "<!doctype html><html><head><meta charset=\"UTF-8\">"
    '<script type="module" crossorigin src="./assets/index-Bz16m3ir.js"></script>'
    "<title>Element Call</title></head><body><div id=\"root\"></div></body></html>"
)
UPSTREAM_BUNDLE = 'var a="video_tile.always_show",b="io.element.call.reaction";'


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
        json.dumps({"video_tile": {"hide_stream": "Не показывать этот стрим"}} if ru_label else {"a": "b"},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    (stage / "config.json").write_text('{"livekit":{"livekit_service_url":"https://x"}}', encoding="utf-8")
    if marker:
        (stage / "plotina-icon.svg").write_text("<svg/>", encoding="utf-8")
    if with_noise:
        # The archive ships its own copy of the shared noise layer; the desktop
        # webapp already has one at its root, so the swap must not keep this.
        (stage / "noise").mkdir()
        (stage / "noise" / "boot.js").write_text("/*dfn*/", encoding="utf-8")
    tarball = root / "plotina-element-call.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(stage, arcname="element-call-plotina")
    return tarball


def make_webapp(root: Path) -> Path:
    """An unpacked upstream webapp: index.html plus the upstream call widget."""
    webapp = root / "webapp"
    (webapp / MOUNT / "assets").mkdir(parents=True)
    (webapp / "index.html").write_text("<html><head></head><body></body></html>", encoding="utf-8")
    (webapp / MOUNT / "index.html").write_text(UPSTREAM_INDEX, encoding="utf-8")
    (webapp / MOUNT / "assets" / "index-Bz16m3ir.js").write_text(UPSTREAM_BUNDLE, encoding="utf-8")
    (webapp / MOUNT / "config.json").write_text('{"matrix_rtc_session":{}}', encoding="utf-8")
    return webapp


def write_lock(root: Path, url: str, sha256: str) -> Path:
    lock = root / "element-call.lock.json"
    lock.write_text(json.dumps({"tag": "v0.26.1-plotina-call.15", "url": url, "sha256": sha256},
                               indent=4) + "\n", encoding="utf-8")
    return lock


def sha256_of(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


class VerifyRejectsUpstreamTest(unittest.TestCase):
    """The check is the negative control for the swap: upstream must fail it."""

    def test_upstream_widget_fails_every_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            webapp = make_webapp(Path(tmp))
            widget = webapp / MOUNT
            failures = ecw.check_widget(widget)
            text = "\n".join(failures)
            # Every advertised feature marker is missing in the upstream bundle.
            self.assertIn("video_tile.hide_stream", text)
            self.assertIn("screen_share_visibility", text)
            self.assertIn("cc.plotina.voice_volumes", text)
            self.assertIn("ru-app", text)
            self.assertIn("plotina-icon.svg", text)

    def test_upstream_widget_exits_non_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            webapp = make_webapp(Path(tmp))
            with self.assertRaises(SystemExit) as ctx:
                ecw.verify_widget(webapp / MOUNT)
            self.assertNotEqual(ctx.exception.code, 0)

    def test_our_widget_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root)
            ecw.install_widget(tarball, webapp)
            self.assertEqual(ecw.check_widget(webapp / MOUNT), [])
            ecw.verify_widget(webapp / MOUNT)  # does not raise


class InstallReplacesWidgetTest(unittest.TestCase):
    def test_no_upstream_file_survives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            widget = webapp / MOUNT
            self.assertFalse((widget / "assets" / "index-Bz16m3ir.js").exists())
            self.assertNotIn("Element Call", (widget / "index.html").read_text(encoding="utf-8"))
            self.assertNotIn("./assets/", (widget / "index.html").read_text(encoding="utf-8"))
            # A file that only our archive has proves the copy really happened.
            self.assertTrue((widget / "plotina-icon.svg").is_file())
            self.assertEqual(
                sorted(p.name for p in (widget / "assets").iterdir()),
                ["index-OURS.css", "index-OURS.js", "ru-app-CTBNJ8GR.json"],
            )

    def test_archive_noise_copy_is_not_duplicated_in_the_widget(self) -> None:
        """The webapp root already carries the noise layer; a second copy is 24 MB
        of dead weight inside the asar and a second init path."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            self.assertFalse((webapp / MOUNT / "noise").exists())

    def test_install_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root)
            ecw.install_widget(tarball, webapp)
            first = (webapp / MOUNT / "index.html").read_text(encoding="utf-8")
            ecw.install_widget(tarball, webapp)
            second = (webapp / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertEqual(first, second)
            self.assertEqual(second.count("noise/plotina-dfn.js"), 1)
            self.assertEqual(second.count("noise/plotina-panel.js"), 1)


class NoiseWiringTest(unittest.TestCase):
    """The archive's own /noise/<script> tags cannot resolve under vector://, and
    dragging its noise/ copy in would initialize the denoiser twice."""

    def test_absolute_noise_tags_are_replaced_by_the_desktop_pair(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            html = (webapp / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertNotIn('src="/noise/', html)
            self.assertIn('src="../../noise/plotina-dfn.js"', html)
            self.assertIn('src="../../noise/plotina-panel.js"', html)
            # boot.js replaces getUserMedia for the app document; on the widget
            # page it would no-op on window.__plotinaEc while adding a second
            # wrapper to the same document, so it must not be injected here.
            self.assertNotIn("noise/boot.js", html)
            self.assertEqual(html.count("noise/plotina-dfn.js"), 1)
            self.assertEqual(html.count("noise/plotina-panel.js"), 1)

    def test_install_keeps_the_plotina_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            html = (webapp / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertIn("window.__plotinaEc=true", html)


class AssetRebaseTest(unittest.TestCase):
    """The archive is built for a site root (call.plotina.cc); under
    vector://vector/webapp/widgets/element-call/ every /assets/ URL 404s and the
    widget renders an empty #root."""

    def test_every_asset_url_is_rebased_to_the_mount(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            widget = webapp / MOUNT
            for path in (widget / "index.html", widget / "assets" / "index-OURS.js",
                         widget / "assets" / "index-OURS.css"):
                text = path.read_text(encoding="utf-8")
                total = text.count("/assets/")
                rebased = text.count(URL_PREFIX + "/assets/")
                self.assertGreater(total, 0, f"{path.name} lost its asset reference")
                self.assertEqual(total, rebased, f"{path.name}: {total - rebased} asset URL(s) still root-absolute")

    def test_check_widget_catches_a_leftover_root_absolute_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            bundle = webapp / MOUNT / "assets" / "index-OURS.js"
            bundle.write_text(bundle.read_text(encoding="utf-8") + ';var x="/assets/leak.mp3";',
                              encoding="utf-8")
            failures = ecw.check_widget(webapp / MOUNT)
            self.assertTrue(any("root-absolute" in f for f in failures), failures)

    def test_check_widget_catches_a_root_absolute_html_link(self) -> None:
        """index.html ships <link rel="preload" href="/config.json">: a bare
        attribute, not a JS string, so the string rewrites miss it."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            index = webapp / MOUNT / "index.html"
            index.write_text(
                index.read_text(encoding="utf-8").replace(
                    "</head>", '<link rel="preload" href="/config.json" as="fetch"></head>', 1
                ),
                encoding="utf-8",
            )
            failures = ecw.check_widget(webapp / MOUNT)
            self.assertTrue(any("/config.json" in f for f in failures), failures)

    def test_check_widget_catches_a_bare_vite_dep_entry(self) -> None:
        """Vite keeps its lazy-chunk map as bare "assets/x.js": resolved against
        the document that is the origin root, not the widget."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            bundle = webapp / MOUNT / "assets" / "index-OURS.js"
            bundle.write_text(
                bundle.read_text(encoding="utf-8")
                + ';const m={f:["assets/spa-XXXX.js","assets/dist-YYYY.js"]};',
                encoding="utf-8",
            )
            failures = ecw.check_widget(webapp / MOUNT)
            self.assertTrue(any("bare" in f for f in failures), failures)

    def test_install_rebases_the_html_config_preload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            index_src = root / "stage" / "element-call-plotina" / "index.html"
            ecw.install_widget(make_archive(root), webapp)
            html = (webapp / MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertIn(f'href="{URL_PREFIX}/config.json"', html)
            self.assertNotIn('href="/config.json"', html)

    def test_install_rebases_the_vite_dep_map(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root)
            ecw.install_widget(tarball, webapp)
            bundle = webapp / MOUNT / "assets" / "index-OURS.js"
            self.assertNotIn('"assets/', bundle.read_text(encoding="utf-8"))


class LockAndShaTest(unittest.TestCase):
    def test_sha256_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            work.mkdir()
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), "0" * 64)
            with self.assertRaises(SystemExit) as ctx:
                ecw.fetch_archive(lock, work)
            self.assertNotEqual(ctx.exception.code, 0)

    def test_matching_sha256_is_cached_and_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            work.mkdir()
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            first = ecw.fetch_archive(lock, work)
            self.assertEqual(first.read_bytes(), tarball.read_bytes())
            # Second call must hit the cache, not the (still existing) source.
            second = ecw.fetch_archive(lock, work)
            self.assertEqual(first, second)

    def test_cache_with_wrong_bytes_is_refetched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            work.mkdir()
            tarball = make_archive(root)
            lock = write_lock(root, tarball.as_uri(), sha256_of(tarball))
            cached = work / tarball.name
            cached.write_bytes(b"corrupt")
            again = ecw.fetch_archive(lock, work)
            self.assertEqual(again.read_bytes(), tarball.read_bytes())

    def test_missing_archive_root_dir_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            bogus = root / "wrong.tar.gz"
            stage = root / "stage2" / "not-ours"
            stage.mkdir(parents=True)
            (stage / "index.html").write_text(OUR_INDEX, encoding="utf-8")
            with tarfile.open(bogus, "w:gz") as tar:
                tar.add(stage, arcname="not-ours")
            with self.assertRaises(SystemExit):
                ecw.install_widget(bogus, webapp)

    def test_upstream_archive_is_refused_by_install(self) -> None:
        """Even a correctly pinned archive is only accepted when it carries our
        Element Call; a swapped asset must fail the build, not ship."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root, ours=False)
            with self.assertRaises(SystemExit) as ctx:
                ecw.install_widget(tarball, webapp)
            self.assertNotEqual(ctx.exception.code, 0)


class MissingMarkerTest(unittest.TestCase):
    def test_ru_locale_label_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root, ru_label=False)
            with self.assertRaises(SystemExit):
                ecw.install_widget(tarball, webapp)

    def test_plotina_icon_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            tarball = make_archive(root, marker=False)
            with self.assertRaises(SystemExit):
                ecw.install_widget(tarball, webapp)


class AsarCheckTest(unittest.TestCase):
    """build.sh verifies the widget inside webapp.asar, not just in .build/webapp:
    the packed bytes are what users install."""

    def _asar(self, root: Path, widget: Path) -> Path:
        """Pack a minimal asar the way @electron/asar lays one out."""
        import struct

        asar = root / "webapp.asar"
        files = {}
        blob = b""
        for path in sorted(widget.rglob("*")):
            if not path.is_file():
                continue
            data = path.read_bytes()
            files[path.relative_to(widget).as_posix()] = {"size": len(data), "offset": str(len(blob))}
            blob += data
        header = {"files": {"widgets": {"files": {"element-call": {"files": files}}}}}
        encoded = json.dumps(header).encode("utf-8")
        padded = (len(encoded) + 3) // 4 * 4
        head = struct.pack("<4I", 4, 8 + padded, 12 + padded, len(encoded)) + encoded + b"\0" * (padded - len(encoded))
        asar.write_bytes(head + blob)
        return asar

    def test_packed_asar_with_our_widget_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            ecw.install_widget(make_archive(root), webapp)
            asar = self._asar(root, webapp / MOUNT)
            self.assertEqual(ecw.check_asar(asar), [])

    def test_packed_asar_with_the_upstream_widget_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = make_webapp(root)
            asar = self._asar(root, webapp / MOUNT)
            failures = ecw.check_asar(asar)
            text = "\n".join(failures)
            self.assertIn("video_tile.hide_stream", text)
            self.assertIn("cc.plotina.voice_volumes", text)
            self.assertIn("plotina-icon.svg", text)

    def test_packed_asar_missing_the_widget_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty = root / "empty"
            (empty / "assets").mkdir(parents=True)
            (empty / "assets" / "x.js").write_text("var a=1;", encoding="utf-8")
            asar = self._asar(root, empty)
            self.assertTrue(ecw.check_asar(asar))


if __name__ == "__main__":
    unittest.main()
