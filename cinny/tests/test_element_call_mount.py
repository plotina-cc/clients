#!/usr/bin/env python3
"""Tests for scripts/mount-element-call.py -- our Element Call inside Lite.

Run: python3 -m unittest discover -s cinny/tests -p 'test_element_call_mount.py'

Why this exists: Lite used to ship upstream's @element-hq/element-call-embedded
0.20.1 in dist/public/element-call/. That widget has neither the stream-hiding
control nor per-participant volume, and it is built for the site root, so the
archive we mount has to be rebased onto the mount path. The checks below are
the gate the card asks for:

  * the frame is OUR bundle (hide_stream, screen_share_visibility,
    cc.plotina.voice_volumes, the ru label, the Plotina icon);
  * nothing of the upstream widget survives, and no source map is shipped;
  * the denoiser lives INSIDE the mount (the older pipeline copied a 50 MB
    noise/ tree to the dist root that no frame loaded);
  * plotina-dfn.js resolves its models from the mount, not from location.origin;
  * the account-data sender is wired exactly once -- and skipped when the
    bundle already ships the action itself.

The upstream widget is the negative control: every marker check must fail on
it, and verify_frame() must exit non-zero.
"""
import json
import tarfile
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "mount-element-call.py"

OUR_INDEX = (
    '<!doctype html><html lang="en"><head>'
    '<script>window.__plotinaEc=true;</script>'
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    '<script src="/noise/boot.js"></script>'
    '<script src="/noise/plotina-panel.js"></script>'
    '<script src="/noise/source-link.js" defer></script>'
    '<meta charset="UTF-8"><link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">'
    '<link rel="preload" href="/config.json" as="fetch">'
    '<meta property="og:image" content="/plotina-512.png">'
    '<title>Plotina Call</title>'
    '<script type="module" crossorigin src="/assets/index-OURS.js"></script>'
    '<link rel="stylesheet" crossorigin href="/assets/index-OURS.css">'
    "</head><body><div id=\"root\"></div></body></html>"
)
OUR_BUNDLE = (
    'var a="video_tile.hide_stream",b="video_tile.screen_share_visibility",'
    'c="cc.plotina.voice_volumes";'
)
UPSTREAM_INDEX = (
    '<!doctype html><html><head><meta charset="UTF-8">'
    '<script type="module" crossorigin src="./assets/index-Bz16m3ir.js"></script>'
    "<title>Element Call</title></head><body><div id=\"root\"></div></body></html>"
)
UPSTREAM_BUNDLE = 'var a="video_tile.always_show",b="io.element.call.reaction";'

DFN_JS = """(function () {
  function base() {
    // Absolute, not relative to the page: Element Call opens /room/ with a
    // trailing slash, and new URL("noise/", ...) resolved to /room/noise/.
    return location.origin + "/noise";
  }
})();
"""


def load_tool():
    if not SCRIPT.is_file():
        raise AssertionError(f"{SCRIPT} does not exist")
    spec = spec_from_file_location("mount_element_call", SCRIPT)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_archive(root: Path, *, ours: bool = True, with_noise: bool = True,
                 ru_label: bool = True, source_map: bool = False,
                 native_action: bool = False) -> Path:
    """Write a plotina-element-call.tar.gz-shaped archive under root."""
    stage = root / "stage" / "element-call-plotina"
    (stage / "assets").mkdir(parents=True)
    (stage / "index.html").write_text(OUR_INDEX if ours else UPSTREAM_INDEX, encoding="utf-8")
    bundle = OUR_BUNDLE
    if native_action:
        # A future archive whose bundle sends the widget action itself: the
        # mount tool must then NOT install the runtime sender.
        bundle += 'send("cc.plotina.set_account_data",{})'
    (stage / "assets" / ("index-OURS.js" if ours else "index-Bz16m3ir.js")).write_text(
        bundle if ours else UPSTREAM_BUNDLE, encoding="utf-8"
    )
    (stage / "assets" / "index-OURS.css").write_text(
        "body{background:url(/assets/bg.png)}", encoding="utf-8"
    )
    if source_map:
        (stage / "assets" / "index-OURS.js.map").write_text("{}", encoding="utf-8")
    (stage / "assets" / "ru-app-CTBNJ8GR.json").write_text(
        json.dumps({"video_tile": {"hide_stream": "Не показывать этот стрим"}}
                   if ru_label else {"a": "b"}, ensure_ascii=False),
        encoding="utf-8",
    )
    (stage / "config.json").write_text('{"livekit":{"livekit_service_url":"https://x"}}',
                                       encoding="utf-8")
    (stage / "plotina-icon.svg").write_text("<svg/>", encoding="utf-8")
    (stage / "plotina-512.png").write_text("png", encoding="utf-8")
    if with_noise:
        # The frame's denoiser, model files included: Lite ships no noise/ of
        # its own any more, so these must travel inside the mount.
        (stage / "noise" / "dfn" / "v3" / "pkg").mkdir(parents=True)
        (stage / "noise" / "dfn" / "v3" / "models").mkdir(parents=True)
        for name in ("logic.js", "boot.js", "plotina-panel.js", "source-link.js"):
            (stage / "noise" / name).write_text("/*noise*/", encoding="utf-8")
        (stage / "noise" / "plotina-dfn.js").write_text(DFN_JS, encoding="utf-8")
        (stage / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm").write_text("wasm", encoding="utf-8")
        (stage / "noise" / "dfn" / "v3" / "models" / "DeepFilterNet3_onnx.tar.gz").write_text(
            "model", encoding="utf-8")
    tarball = root / "plotina-element-call.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(stage, arcname="element-call-plotina")
    return tarball


def make_dist(root: Path) -> Path:
    """A built Cinny dist carrying upstream's embedded widget."""
    dist = root / "dist"
    frame = dist / "public" / "element-call"
    (frame / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html><body></body></html>", encoding="utf-8")
    (dist / "assets").mkdir()
    (dist / "assets" / "index-APP.js").write_text("console.log(1)", encoding="utf-8")
    (frame / "index.html").write_text(UPSTREAM_INDEX, encoding="utf-8")
    (frame / "assets" / "index-Bz16m3ir.js").write_text(UPSTREAM_BUNDLE, encoding="utf-8")
    (frame / "config.json").write_text("{}", encoding="utf-8")
    return dist


class NegativeControlTest(unittest.TestCase):
    """Upstream's widget must fail the gate -- otherwise the gate proves nothing."""

    def test_upstream_frame_fails_every_marker(self) -> None:
        tool = load_tool()
        with tempfile.TemporaryDirectory() as tmp:
            dist = make_dist(Path(tmp))
            failures = tool.check_frame(dist / tool.MOUNT)
            text = "\n".join(failures)
            self.assertIn("hide_stream", text)
            self.assertIn("screen_share_visibility", text)
            self.assertIn("cc.plotina.voice_volumes", text)
            self.assertIn("__plotinaEc", text)
            self.assertIn("plotina-icon.svg", text)

    def test_upstream_frame_exits_non_zero(self) -> None:
        tool = load_tool()
        with tempfile.TemporaryDirectory() as tmp:
            dist = make_dist(Path(tmp))
            with self.assertRaises(SystemExit) as ctx:
                tool.verify_frame(dist / tool.MOUNT)
            self.assertNotEqual(ctx.exception.code, 0)


class InstallTest(unittest.TestCase):
    def install(self, tmp: str, **kwargs) -> tuple:
        tool = load_tool()
        root = Path(tmp)
        dist = make_dist(root)
        tarball = make_archive(root, **kwargs)
        tool.install(tarball, dist)
        return tool, dist, dist / tool.MOUNT

    def test_upstream_widget_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp)
            self.assertEqual(tool.check_frame(frame), [])
            self.assertFalse((frame / "assets" / "index-Bz16m3ir.js").exists())
            text = (frame / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("Element Call", text)
            self.assertNotIn("./assets/", text)
            self.assertNotIn('src="/assets/', text)
            self.assertIn('src="/public/element-call/assets/index-OURS.js"', text)
            self.assertIn('href="/public/element-call/plotina-icon.svg"', text)
            self.assertIn('"/public/element-call/config.json"', text)
            self.assertIn('content="/public/element-call/plotina-512.png"', text)

    def test_noise_lives_inside_the_mount_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp)
            self.assertTrue((frame / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm").is_file())
            self.assertFalse((dist / "noise").exists())
            # A dist left by the old pipeline had one at the root; installing
            # must not bring it back and must say so if it is there.
            self.assertNotIn(str(dist / "noise"), "\n".join(tool.check_frame(frame)))

    def test_noise_tags_point_into_the_mount(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp)
            text = (frame / "index.html").read_text(encoding="utf-8")
            self.assertIn('src="/public/element-call/noise/plotina-dfn.js"', text)
            self.assertNotIn('src="/noise/', text)
            dfn = (frame / "noise" / "plotina-dfn.js").read_text(encoding="utf-8")
            self.assertNotIn('location.origin + "/noise"', dfn)
            self.assertIn('"/public/element-call/noise"', dfn)

    def test_source_maps_are_not_shipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp, source_map=True)
            self.assertEqual(list(frame.rglob("*.map")), [])

    def test_account_data_sender_is_installed_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp)
            shim = frame / "noise" / "plotina-account-data.js"
            self.assertTrue(shim.is_file())
            text = (frame / "index.html").read_text(encoding="utf-8")
            self.assertEqual(text.count("plotina-account-data.js"), 1)
            self.assertIn("cc.plotina.set_account_data", shim.read_text(encoding="utf-8"))

    def test_sender_is_skipped_when_the_bundle_sends_the_action_itself(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool, dist, frame = self.install(tmp, native_action=True)
            self.assertFalse((frame / "noise" / "plotina-account-data.js").exists())
            self.assertNotIn("plotina-account-data.js",
                             (frame / "index.html").read_text(encoding="utf-8"))
            self.assertEqual(tool.check_frame(frame), [])

    def test_install_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool = load_tool()
            root = Path(tmp)
            dist = make_dist(root)
            tarball = make_archive(root)
            tool.install(tarball, dist)
            first = (dist / tool.MOUNT / "index.html").read_text(encoding="utf-8")
            tool.install(tarball, dist)
            second = (dist / tool.MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertEqual(first, second)
            self.assertEqual(second.count("plotina-dfn.js"), 1)
            self.assertEqual(second.count("plotina-account-data.js"), 1)

    def test_refuses_an_archive_that_is_not_ours(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tool = load_tool()
            root = Path(tmp)
            dist = make_dist(root)
            tarball = make_archive(root, ours=False, with_noise=False, ru_label=False)
            with self.assertRaises(SystemExit) as ctx:
                tool.install(tarball, dist)
            self.assertNotEqual(ctx.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
