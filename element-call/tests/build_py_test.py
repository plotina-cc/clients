"""Unit tests for element-call/build.py (run: python3 -m unittest discover -s element-call/tests -p '*test*.py').

build.py is the Python port of element-call/build.sh; the shell script is a
thin wrapper around it.  These tests cover everything the port extracted into
pure or near-pure functions: argument parsing (byte-for-byte the bash
`while/case` semantics), pins.env loading, tag/sha validation, config.json
validation, the source-map split, the noise copy, the final bundle assertions
and the `du -h` formatting.  Network and pnpm paths are exercised by the
release-mode diff against the bash original, not here.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EC = HERE.parent
REPO = EC.parent
sys.path.insert(0, str(EC))
sys.path.insert(0, str(HERE))

import build as ecbuild  # noqa: E402


class ParseArgsTests(unittest.TestCase):
    def test_defaults(self):
        opts = ecbuild.parse_args([])
        for key in ("mode", "tag", "out", "noise", "dfn_dir", "config",
                    "icons", "maps_out", "sentry_cli"):
            self.assertEqual(opts[key], "", f"unset option {key} must default to ''")
        self.assertFalse(opts["keep"])

    def test_every_flag(self):
        opts = ecbuild.parse_args([
            "--mode", "source", "--tag", "v1.2.3", "--out", "/o", "--noise", "/n",
            "--dfn-dir", "/d", "--config", "/c.json", "--icons", "/i",
            "--maps-out", "/m", "--sentry-cli", "/s", "--keep",
        ])
        self.assertEqual(opts["mode"], "source")
        self.assertEqual(opts["tag"], "v1.2.3")
        self.assertEqual(opts["out"], "/o")
        self.assertEqual(opts["noise"], "/n")
        self.assertEqual(opts["dfn_dir"], "/d")
        self.assertEqual(opts["config"], "/c.json")
        self.assertEqual(opts["icons"], "/i")
        self.assertEqual(opts["maps_out"], "/m")
        self.assertEqual(opts["sentry_cli"], "/s")
        self.assertTrue(opts["keep"])

    def test_last_value_wins(self):
        # bash loop: later --out simply overwrites the earlier one.
        opts = ecbuild.parse_args(["--out", "/a", "--out", "/b"])
        self.assertEqual(opts["out"], "/b")

    def test_missing_value(self):
        # bash `${2:?--tag needs a value}`: unset OR empty $2 aborts.
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.parse_args(["--tag"])
        self.assertEqual(str(cm.exception), "--tag needs a value")
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.parse_args(["--mode", ""])
        self.assertEqual(str(cm.exception), "--mode needs a value")

    def test_flag_takes_next_arg_verbatim(self):
        # bash does too: `--mode --tag` sets MODE to "--tag", not an error;
        # a following bare word then trips `unknown argument`.
        opts = ecbuild.parse_args(["--mode", "--tag"])
        self.assertEqual(opts["mode"], "--tag")
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.parse_args(["--mode", "--tag", "v1"])
        self.assertEqual(str(cm.exception), "unknown argument: v1 (try --help)")

    def test_unknown_argument(self):
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.parse_args(["--bogus"])
        self.assertEqual(str(cm.exception), "unknown argument: --bogus (try --help)")

    def test_unknown_positional(self):
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.parse_args(["release"])
        self.assertEqual(str(cm.exception), "unknown argument: release (try --help)")

    def test_help_exits_zero(self):
        with self.assertRaises(ecbuild.UsageExit) as cm:
            ecbuild.parse_args(["-h"])
        for flag in ("--mode", "--tag", "--out", "--noise", "--dfn-dir", "--config",
                     "--icons", "--maps-out", "--sentry-cli", "--keep"):
            self.assertIn(flag, cm.exception.text)
        self.assertIn("plotina-element-call.tar.gz", cm.exception.text)
        self.assertIn("Two modes:", cm.exception.text)
        with self.assertRaises(ecbuild.UsageExit):
            ecbuild.parse_args(["--help"])

    def test_mode_validation(self):
        ecbuild.validate_mode("release")
        ecbuild.validate_mode("source")
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.validate_mode("debug")
        self.assertEqual(str(cm.exception), "--mode must be release or source, not 'debug'")
        with self.assertRaises(ecbuild.BuildError):
            ecbuild.validate_mode("")


class ApplyDefaultsTests(unittest.TestCase):
    PINS = {"EC_TAG": "v0.26.1"}

    def test_defaults_come_from_pins_and_repo(self):
        opts = ecbuild.parse_args([])
        conf = ecbuild.apply_defaults(opts, self.PINS, here=Path("/r/element-call"), repo=Path("/r"))
        self.assertEqual(conf["mode"], "release")
        self.assertEqual(conf["tag"], "v0.26.1")
        self.assertEqual(conf["out"], Path("/r/dist"))
        self.assertEqual(conf["noise"], Path("/r/noise"))
        self.assertEqual(conf["config"], Path("/r/element-call/config.json"))
        self.assertEqual(conf["icons"], Path("/r/branding/icons"))
        self.assertEqual(conf["dfn_dir"], None)
        self.assertEqual(conf["maps_out"], None)
        self.assertEqual(conf["sentry_cli"], None)
        self.assertFalse(conf["keep"])

    def test_explicit_overrides(self):
        opts = ecbuild.parse_args(["--tag", "v9.9.9", "--out", "/x", "--keep"])
        conf = ecbuild.apply_defaults(opts, self.PINS, here=Path("/r/element-call"), repo=Path("/r"))
        self.assertEqual(conf["tag"], "v9.9.9")
        self.assertEqual(conf["out"], Path("/x"))
        self.assertTrue(conf["keep"])


class PinsTests(unittest.TestCase):
    def test_load_pins_skips_comments(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "pins.env"
            p.write_text(
                "# comment line\n"
                "\n"
                "EC_TAG=v0.26.1\n"
                "EC_TARBALL_SHA256=abc123\n",
                encoding="utf-8",
            )
            pins = ecbuild.load_pins(p)
        self.assertEqual(pins["EC_TAG"], "v0.26.1")
        self.assertEqual(pins["EC_TARBALL_SHA256"], "abc123")

    def test_real_pins_env_parses(self):
        pins = ecbuild.load_pins(EC / "pins.env")
        for key in ("EC_TAG", "EC_TARBALL_SHA256", "EC_REPO", "NODE_VERSION",
                    "PNPM_VERSION", "DFN_BASE", "DFN_WASM_SHA256", "DFN_MODEL_SHA256"):
            self.assertIn(key, pins)
        self.assertEqual(pins["EC_TAG"], "v0.26.1")
        self.assertEqual(len(pins["EC_TARBALL_SHA256"]), 64)

    def test_required_pins(self):
        pins = {"EC_TAG": "v1"}
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.require_pins(pins, ["EC_TAG", "EC_REPO"])
        self.assertEqual(str(cm.exception), "pins.env: missing EC_REPO")


class NamingTests(unittest.TestCase):
    def test_strip_v(self):
        self.assertEqual(ecbuild.strip_v("v0.26.1"), "0.26.1")
        self.assertEqual(ecbuild.strip_v("0.26.1"), "0.26.1")

    def test_tarball_url(self):
        self.assertEqual(
            ecbuild.tarball_url("v0.26.1"),
            "https://github.com/element-hq/element-call/releases/download/v0.26.1/element-call-0.26.1.tar.gz",
        )

    def test_tag_must_match_pin(self):
        ecbuild.check_tag_pin("v0.26.1", "v0.26.1")
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.check_tag_pin("v1.2.3", "v0.26.1")
        self.assertEqual(
            str(cm.exception),
            "--tag v1.2.3 is not the pinned v0.26.1; bump EC_TAG and EC_TARBALL_SHA256 in pins.env together",
        )

    def test_release_name(self):
        self.assertEqual(ecbuild.release_name("v0.26.1", {}), "element-call@v0.26.1")
        self.assertEqual(
            ecbuild.release_name("v0.26.1", {"VITE_SENTRY_RELEASE": "custom@1"}),
            "custom@1",
        )


class ConfigValidationTests(unittest.TestCase):
    def assertMessage(self, config, expected):
        with self.assertRaises(ecbuild.BuildError) as cm:
            ecbuild.install_config_text(json.dumps(config))
        self.assertEqual(str(cm.exception), expected)

    def test_valid_minimal(self):
        out = ecbuild.install_config_text(json.dumps({
            "default_server_config": {"m.homeserver": {"base_url": "https://p.cc", "server_name": "p.cc"}},
            "matrix_rtc_mode": "compatibility",
        }))
        self.assertTrue(out.endswith("\n"))
        self.assertEqual(json.loads(out)["default_server_config"]["m.homeserver"]["base_url"], "https://p.cc")

    def test_real_repo_config(self):
        text = (EC / "config.json").read_text(encoding="utf-8")
        out = ecbuild.install_config_text(text)
        self.assertIn("plotina.cc", out)

    def test_no_matrix_rtc_mode_is_fine(self):
        ecbuild.install_config_text(json.dumps(
            {"default_server_config": {"m.homeserver": {"base_url": "b", "server_name": "s"}}}))

    def test_bad_rtc_mode(self):
        self.assertMessage(
            {"default_server_config": {"m.homeserver": {"base_url": "b", "server_name": "s"}},
             "matrix_rtc_mode": "turbo"},
            "config.json: matrix_rtc_mode must be compatibility or matrix_2_0",
        )

    def test_missing_base_url(self):
        self.assertMessage(
            {"default_server_config": {"m.homeserver": {"server_name": "s"}}},
            "config.json: default_server_config.m.homeserver needs base_url and server_name",
        )

    def test_missing_homeserver_entirely(self):
        self.assertMessage(
            {},
            "config.json: default_server_config.m.homeserver needs base_url and server_name",
        )

    def test_non_ascii_preserved(self):
        out = ecbuild.install_config_text(json.dumps(
            {"default_server_config": {"m.homeserver": {"base_url": "b", "server_name": "имя"}}}))
        self.assertIn("имя", out)  # ensure_ascii=False, like the bash heredoc


class Sha256Tests(unittest.TestCase):
    def test_sha256_of(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "f"
            p.write_bytes(b"plotina")
            self.assertEqual(ecbuild.sha256_of(p), hashlib.sha256(b"plotina").hexdigest())

    def test_verify_sha_ok_prints(self):
        data = b"plotina"
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "f"
            p.write_bytes(data)
            lines = []
            ecbuild.verify_sha(p, digest, say=lines.append)
        self.assertEqual(lines, [f"{p}: OK"])

    def test_verify_sha_mismatch(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "f"
            p.write_bytes(b"plotina")
            with self.assertRaises(ecbuild.BuildError) as cm:
                ecbuild.verify_sha(p, "0" * 64, say=lambda *a: None)
        self.assertIn("sha256sum", str(cm.exception))
        self.assertIn("FAILED", str(cm.exception))


class DuHTests(unittest.TestCase):
    def test_pure_formatting(self):
        self.assertEqual(ecbuild.du_h(0), "0")
        self.assertEqual(ecbuild.du_h(512), "512")
        self.assertEqual(ecbuild.du_h(4096), "4.0K")
        self.assertEqual(ecbuild.du_h(12288), "12K")
        self.assertEqual(ecbuild.du_h(102400), "100K")
        self.assertEqual(ecbuild.du_h(1048576), "1.0M")
        self.assertEqual(ecbuild.du_h(10485760), "10M")
        self.assertEqual(ecbuild.du_h(40 * 1048576), "40M")
        self.assertEqual(ecbuild.du_h(2 * 1048576 * 1024), "2.0G")

    def test_matches_gnu_du(self):
        """Compare against real `du -h | cut -f1` on non-sparse files."""
        sizes = [1, 400, 1023, 1024, 1500, 5000, 20000, 100 * 1024, 5 * 1024 * 1024]
        with tempfile.TemporaryDirectory() as td:
            for size in sizes:
                p = Path(td) / f"f{size}"
                with open(p, "wb") as fh:
                    fh.write(os.urandom(size))
                # du counts allocated blocks; feed it the same source of truth
                blocks = os.stat(p).st_blocks * 512
                real = subprocess.run(
                    f"du -h '{p}' | cut -f1", shell=True, capture_output=True, text=True, check=True
                ).stdout.strip()
                self.assertEqual(ecbuild.du_h(blocks), real, f"size {size}")


class InputCheckTests(unittest.TestCase):
    def test_missing_input_message(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            noise = root / "noise"
            (noise / "vendor").mkdir(parents=True)
            for name in ("logic.js", "boot.js", "plotina-dfn.js", "plotina-panel.js"):
                (noise / name).write_text("//", encoding="utf-8")
            # vendor/dfn.esm.js intentionally absent
            config = root / "config.json"
            config.write_text("{}", encoding="utf-8")
            icons = root / "icons" / "png"
            icons.mkdir(parents=True)
            (icons.parent / "plotina-green.svg").write_text("<svg/>", encoding="utf-8")
            for png in ("green-48.png", "green-512.png"):
                (icons / png).write_bytes(b"\x89PNG")
            with self.assertRaises(ecbuild.BuildError) as cm:
                ecbuild.check_inputs(noise, config, root / "icons")
        self.assertEqual(str(cm.exception), f"missing input: {noise / 'vendor' / 'dfn.esm.js'}")


class MapsSplitTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.root = Path(self.td.name)
        self.dist = self.root / "dist"
        self.maps = self.root / "maps"
        self.out = self.root / "out"

    def _mk(self, name, body=b"code"):
        p = self.dist / "assets" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        (p.parent).mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)
        return p

    def test_split(self):
        a = self._mk("a.js")
        a.with_suffix(".js.map").write_text("{}")
        b = self._mk("b.js")  # script without a map stays
        orphan = self.dist / "sub" / "orphan.map"
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_text("{}")
        calls = []
        ecbuild.split_source_maps(self.dist, self.maps, self.out, "element-call@v1",
                                  sentry_cli=None, say=calls.append, run=subprocess.run)
        self.assertTrue((self.maps / "assets" / "a.js").is_file())
        self.assertTrue((self.maps / "assets" / "a.js.map").is_file())
        self.assertTrue((self.maps / "sub" / "orphan.map").is_file())
        self.assertFalse((self.dist / "assets" / "a.js.map").exists())
        self.assertTrue(a.is_file())          # the served script keeps working
        self.assertTrue(b.is_file())
        self.assertEqual((self.out / "sentry-release.txt").read_text(), "element-call@v1\n")
        self.assertIn(f"copying source maps to {self.maps}", calls)

    def test_sentry_cli_called_first(self):
        a = self._mk("a.js")
        a.with_suffix(".js.map").write_text("{}")
        cli = self.root / "fake-cli"
        cli.write_text('#!/bin/sh\necho "$@" >> "%s"\n' % (self.root / "cli-args.txt"), encoding="utf-8")
        cli.chmod(0o755)
        ecbuild.split_source_maps(self.dist, self.maps, self.out, "r@1",
                                  sentry_cli=str(cli), say=lambda *a: None, run=subprocess.run)
        logged = (self.root / "cli-args.txt").read_text()
        self.assertEqual(logged.strip(), f"sourcemaps inject {self.dist}/assets")

    def test_no_maps_warns(self):
        self.dist.mkdir(parents=True)
        calls = []
        ecbuild.split_source_maps(self.dist, self.maps, self.out, "r@1",
                                  sentry_cli=None, say=calls.append, run=subprocess.run)
        self.assertIn("warning: the build produced no source maps", calls)
        self.assertTrue((self.out / "sentry-release.txt").is_file())


class FetchReleaseTests(unittest.TestCase):
    def test_layout_and_move(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            src = work / "src"
            inner = src / "element-call-1.2.3"
            (inner / "assets").mkdir(parents=True)
            (inner / "index.html").write_text("hi", encoding="utf-8")
            (inner / "assets" / "index-AAAA.js").write_text("js", encoding="utf-8")
            tar = work / "t.tar.gz"
            with tarfile.open(tar, "w:gz") as tf:
                tf.add(src / "element-call-1.2.3", arcname="element-call-1.2.3")
            data = tar.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            downloads = []

            def fake_download(url, dst):
                downloads.append(url)
                Path(dst).write_bytes(data)

            dist = ecbuild.fetch_release(work, "v1.2.3", "v1.2.3", digest,
                                         say=lambda *a: None, download=fake_download)
            self.assertEqual(downloads, [
                "https://github.com/element-hq/element-call/releases/download/v1.2.3/element-call-1.2.3.tar.gz"])
            self.assertEqual(dist, work / "dist")
            self.assertTrue((dist / "index.html").is_file())
            self.assertTrue((dist / "assets" / "index-AAAA.js").is_file())

    def test_bad_sha_aborts_before_extract(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)

            def fake_download(url, dst):
                Path(dst).write_bytes(b"garbage")

            with self.assertRaises(ecbuild.BuildError):
                ecbuild.fetch_release(work, "v1.2.3", "v1.2.3", "0" * 64,
                                      say=lambda *a: None, download=fake_download)
            self.assertFalse((work / "dist").exists())

    def test_wrong_top_level_dir(self):
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            src = work / "src"
            (src / "something-else").mkdir(parents=True)
            (src / "something-else" / "index.html").write_text("x", encoding="utf-8")
            tar = work / "t.tar.gz"
            with tarfile.open(tar, "w:gz") as tf:
                tf.add(src / "something-else", arcname="something-else")
            data = tar.read_bytes()

            def fake_download(url, dst):
                Path(dst).write_bytes(data)

            with self.assertRaises(ecbuild.BuildError) as cm:
                ecbuild.fetch_release(work, "v1.2.3", "v1.2.3", hashlib.sha256(data).hexdigest(),
                                      say=lambda *a: None, download=fake_download)
        self.assertIn("unexpected tarball layout", str(cm.exception))


class CopyNoiseTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.root = Path(self.td.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        self.noise = self.root / "noise"
        (self.noise / "vendor").mkdir(parents=True)
        for name in ("logic.js", "boot.js", "plotina-dfn.js", "plotina-panel.js"):
            (self.noise / name).write_bytes(b"//x")
        (self.noise / "vendor" / "dfn.esm.js").write_bytes(b"//v")
        (self.noise / "vendor" / "LICENSE-APACHE").write_bytes(b"A")
        (self.noise / "vendor" / "LICENSE-MIT").write_bytes(b"M")
        # a stray subdirectory in noise/ must NOT be swept in (the bash script
        # installs a fixed file list, nothing recursive)
        (self.noise / "vendor" / "LICENSE-ABSENT").write_bytes(b"")
        os.chmod(self.noise / "vendor" / "LICENSE-ABSENT", 0o600)
        self.src_link = self.root / "source-link.js"
        self.src_link.write_bytes(b"//sl")

    def test_files_modes_and_vendor(self):
        ecbuild.copy_noise(self.dist, self.noise, self.src_link)
        for name in ("logic.js", "boot.js", "plotina-dfn.js", "plotina-panel.js", "source-link.js"):
            p = self.dist / "noise" / name
            self.assertTrue(p.is_file(), name)
            self.assertEqual(p.stat().st_mode & 0o777, 0o644, name)
        self.assertEqual((self.dist / "noise" / "vendor" / "dfn.esm.js").read_bytes(), b"//v")
        self.assertEqual((self.dist / "noise" / "vendor" / "LICENSE-APACHE").read_bytes(), b"A")
        self.assertEqual((self.dist / "noise" / "vendor" / "LICENSE-MIT").read_bytes(), b"M")
        self.assertEqual((self.dist / "noise" / "vendor" / "LICENSE-ABSENT").stat().st_mode & 0o777, 0o644)

    def test_dfn_from_dir(self):
        dfn = self.root / "dfn"
        (dfn / "v3" / "pkg").mkdir(parents=True)
        (dfn / "v3" / "models").mkdir(parents=True)
        wasm = dfn / "v3" / "pkg" / "df_bg.wasm"
        model = dfn / "v3" / "models" / "DeepFilterNet3_onnx.tar.gz"
        wasm.write_bytes(b"W")
        model.write_bytes(b"M")
        calls = []
        ecbuild.install_dfn(self.dist, dfn_dir=dfn, base="https://x/dfn/v3",
                            wasm_sha=hashlib.sha256(b"W").hexdigest(),
                            model_sha=hashlib.sha256(b"M").hexdigest(),
                            say=calls.append, download=lambda u, d: self.fail("must not download"))
        self.assertEqual((self.dist / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm").read_bytes(), b"W")
        self.assertEqual((self.dist / "noise" / "dfn" / "v3" / "models" / "DeepFilterNet3_onnx.tar.gz").read_bytes(), b"M")
        self.assertIn(f"copying DeepFilterNet3 assets from {dfn}", calls)
        self.assertEqual((self.dist / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm").stat().st_mode & 0o777, 0o644)

    def test_dfn_downloads(self):
        urls = []

        def fake_download(url, dst):
            urls.append(url)
            Path(dst).write_bytes(b"X")

        ecbuild.install_dfn(self.dist, dfn_dir=None, base="https://p.cc/noise/dfn/v3",
                            wasm_sha=hashlib.sha256(b"X").hexdigest(),
                            model_sha=hashlib.sha256(b"X").hexdigest(),
                            say=lambda *a: None, download=fake_download)
        self.assertEqual(urls, [
            "https://p.cc/noise/dfn/v3/pkg/df_bg.wasm",
            "https://p.cc/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz",
        ])


class CheckBundleTests(unittest.TestCase):
    """The final `checking the bundle` assertions, ported one-for-one."""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.root = Path(self.td.name)
        self.dist = self.root / "dist"
        self.icons = self.root / "icons"
        (self.dist / "assets").mkdir(parents=True)
        (self.icons / "png").mkdir(parents=True)

        self.index = self.dist / "index.html"
        self.index.write_text(
            '<!doctype html><html><head>'
            '<script src="/noise/logic.js"></script>'
            '<script src="/noise/plotina-panel.js"></script>'
            '<script src="/noise/source-link.js" defer></script>'
            '<title>Plotina Call</title>'
            '<link rel="icon" href="/plotina-icon.svg">'
            '<meta property="og:image" content="/plotina-512.png">'
            '<script type="module" src="/assets/index-AAAA.js"></script>'
            '</head><body></body></html>',
            encoding="utf-8",
        )
        (self.dist / "assets" / "index-AAAA.js").write_bytes(b"plotina()")
        noise = self.dist / "noise"
        noise.mkdir()
        (noise / "source-link.js").write_bytes(b"//sl")
        (noise / "plotina-panel.js").write_bytes(b"//panel")
        (self.dist / "config.json").write_text('{"a":1}', encoding="utf-8")
        (self.dist / "NOTICE").write_text("notice", encoding="utf-8")
        (self.dist / "plotina-icon.svg").write_bytes(b"<svg/>")
        (self.dist / "plotina-512.png").write_bytes(b"\x89PNG-512")
        green48 = b"\x89PNG-48"
        (self.icons / "png" / "green-48.png").write_bytes(green48)
        (self.dist / "favicon.png").write_bytes(green48)
        dfn = self.dist / "noise" / "dfn" / "v3"
        (dfn / "pkg").mkdir(parents=True)
        (dfn / "models").mkdir(parents=True)
        (dfn / "pkg" / "df_bg.wasm").write_bytes(b"\0" * 16_000_001)
        (dfn / "models" / "DeepFilterNet3_onnx.tar.gz").write_bytes(b"\0" * 7_000_001)

    def _run(self):
        ecbuild.check_bundle(self.dist, self.icons, say=lambda *a: None,
                             inject_check=lambda: None, branding_check=lambda: None)

    def test_passes_on_good_bundle(self):
        self._run()

    def test_element_call_left_in_index(self):
        self.index.write_text(self.index.read_text().replace("<title>Plotina Call</title>",
                                                             "<title>Element Call</title>"), encoding="utf-8")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "index.html still says 'Element Call'")

    def test_missing_logic_tag(self):
        self.index.write_text(self.index.read_text().replace('/noise/logic.js', '/other.js'), encoding="utf-8")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "logic.js tag missing from index.html")

    def test_no_hashed_bundle(self):
        (self.dist / "assets" / "index-AAAA.js").unlink()
        (self.dist / "assets" / "vendor-AAAA.js").write_bytes(b"x")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "no hashed app bundle under assets/")

    def test_upstream_url_left(self):
        (self.dist / "assets" / "index-AAAA.js").write_bytes(b"fetch('https://element.io/privacy')")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertIn("the bundle still links", str(cm.exception))
        self.assertIn("element", str(cm.exception))

    def test_docs_element_io(self):
        (self.dist / "assets" / "index-AAAA.js").write_bytes(b"https://docs.element.io/x")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertIn("docs\\.element\\.io", str(cm.exception))

    def test_favicon_wrong(self):
        (self.dist / "favicon.png").write_bytes(b"nope")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "favicon.png is not the Plotina 48px mark")

    def test_small_wasm(self):
        (self.dist / "noise" / "dfn" / "v3" / "pkg" / "df_bg.wasm").write_bytes(b"\0" * 10)
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "df_bg.wasm is 10B; expected ~16 MB")

    def test_empty_notice(self):
        (self.dist / "NOTICE").write_text("", encoding="utf-8")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "NOTICE is empty")

    def test_no_plotina_title(self):
        self.index.write_text(self.index.read_text().replace("<title>Plotina Call</title>", "<title>Call</title>"), encoding="utf-8")
        with self.assertRaises(ecbuild.BuildError) as cm:
            self._run()
        self.assertEqual(str(cm.exception), "index.html has no Plotina Call title")


class PackTests(unittest.TestCase):
    def test_deterministic_tar(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        stage = root / "stage" / "element-call-plotina"
        (stage / "assets").mkdir(parents=True)
        (stage / "index.html").write_text("A", encoding="utf-8")
        (stage / "assets" / "index-AAAA.js").write_bytes(b"B")
        art = root / "out.tar.gz"
        ecbuild.pack(stage, art, root / "out")
        listing = subprocess.run(["tar", "-tzf", str(art)], capture_output=True, text=True,
                                 check=True).stdout.splitlines()
        self.assertEqual(listing, sorted(listing))
        self.assertIn("element-call-plotina/index.html", listing)
        self.assertIn("element-call-plotina/assets/", listing)
        first, second = art.read_bytes(), None
        art.unlink()
        ecbuild.pack(stage, art, root / "out")
        second = art.read_bytes()
        self.assertEqual(first, second, "rebuild must produce identical bytes")
        with tarfile.open(art, "r:gz") as tf:
            names = tf.getnames()
            self.assertIn("element-call-plotina/assets/index-AAAA.js", names)
            self.assertEqual(tf.getmember("element-call-plotina/index.html").mtime, 0)

    def test_gzip_payload_roundtrip(self):
        # sanity: our artifact opens with plain gzip as well as tar
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        stage = root / "stage" / "element-call-plotina"
        stage.mkdir(parents=True)
        (stage / "a.txt").write_text("hello", encoding="utf-8")
        art = root / "o.tar.gz"
        ecbuild.pack(stage, art, root)
        raw = gzip.decompress(art.read_bytes())
        self.assertIn(b"hello", raw)


class ScriptContractTests(unittest.TestCase):
    def test_wrapper_execs_python(self):
        text = (EC / "build.sh").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("#!/usr/bin/env bash"), text[:40])
        self.assertIn('exec python3', text)
        self.assertIn('build.py', text)

    def test_usage_text_matches_original_build(self):
        # the -h output must keep listing the same surface as the ported script
        opts = {"__unused__": None}
        with self.assertRaises(ecbuild.UsageExit) as cm:
            ecbuild.parse_args(["--help"])
        self.assertIn("--sentry-cli FILE", cm.exception.text)
        self.assertIn("--dfn-dir DIR", cm.exception.text)


class ApplyPatchSetTests(unittest.TestCase):
    """The patch set is applied by the repository script, not by a copy of the loop in build.py.

    The loop that used to live here was blind in the same way the workflows were: it applied what it
    found and said nothing about how many of them landed, so a patch that stopped applying, or a
    patch set that quietly shrank, still produced a bundle. The script sorts, checks, counts, refuses
    a patch without a marker and writes the marker list the artifact gate consumes.
    """

    def make_fixture(self, root: Path, patch_body: str) -> Path:
        client = root / "element-call"
        (client / "patches").mkdir(parents=True)
        src = root / "src"
        src.mkdir()
        (src / "a.txt").write_text("alpha\nbeta\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(src)], check=True)
        subprocess.run(["git", "-C", str(src), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(src), "-c", "user.email=t@example.invalid", "-c", "user.name=test",
             "commit", "-qm", "init"], check=True)
        (client / "patches" / "0002-probe.patch").write_text(
            "# Plotina-Patch: probe\n# Plotina-Marker: probe-token\n\n"
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" + patch_body,
            encoding="utf-8")
        (root / "scripts").mkdir()
        shutil.copy(REPO / "scripts" / "apply-patches.sh", root / "scripts" / "apply-patches.sh")
        return client

    def test_applies_through_the_repository_script(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            client = self.make_fixture(root, "@@ -1,2 +1,3 @@\n alpha\n+probe-token\n beta\n")
            markers = root / "markers.txt"
            ecbuild.apply_patch_set(client, root / "src", markers)
            self.assertIn("probe-token", (root / "src" / "a.txt").read_text(encoding="utf-8"))
            self.assertEqual(markers.read_text(encoding="utf-8").strip(),
                             "0002-probe\tprobe-token")

    def test_failed_patch_is_an_error(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            client = self.make_fixture(root, "@@ -9,2 +9,3 @@\n zeta\n+probe-token\n theta\n")
            with self.assertRaises(ecbuild.BuildError):
                ecbuild.apply_patch_set(client, root / "src", root / "markers.txt")

    def test_missing_script_is_an_error(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            client = self.make_fixture(root, "@@ -1,2 +1,3 @@\n alpha\n+probe-token\n beta\n")
            (root / "scripts" / "apply-patches.sh").unlink()
            with self.assertRaises(ecbuild.BuildError) as cm:
                ecbuild.apply_patch_set(client, root / "src", root / "markers.txt")
            self.assertIn("apply-patches.sh", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
