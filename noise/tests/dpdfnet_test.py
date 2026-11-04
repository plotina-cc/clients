#!/usr/bin/env python3
"""Pin/asset tests for the DPDFNet backend. Run:

    python3 -m unittest discover -s noise/tests -p '*_test.py'

Checks:
  * noise/dpdfnet.lock.json is well-formed (https URLs, 64-hex digests).
  * the pinned model config really is the 48 kHz spec_real streaming layout
    the vendored module assumes (win 960 / hop 480 / 481 bins / 13 states).
  * initial_states.json sizes match the .bin, and the ONNX input signature
    contains 'spec' plus the state names in the config order (only when the
    assets have been fetched; otherwise skipped with a hint).
  * every fetched file hashes to the pinned SHA-256 (test_pin_digests).
"""
import hashlib
import json
import re
import unittest
from pathlib import Path

NOISE = Path(__file__).resolve().parent.parent
LOCK_PATH = NOISE / "dpdfnet.lock.json"
MODEL_REL = "vendor/dpdfnet/dpdfnet2_48khz_hr"


def lock():
    return json.loads(LOCK_PATH.read_text(encoding="utf-8"))


class LockFileTest(unittest.TestCase):
    def setUp(self):
        self.entries = lock()

    def test_lock_shape(self):
        self.assertIn(f"{MODEL_REL}/model_stateful.onnx", self.entries)
        self.assertIn("vendor/ort/ort.wasm.bundle.min.mjs", self.entries)
        for rel, meta in self.entries.items():
            with self.subTest(rel=rel):
                self.assertTrue(meta["url"].startswith("https://"), meta["url"])
                self.assertRegex(meta["sha256"], r"^[0-9a-f]{64}$")
                self.assertTrue(rel.startswith("vendor/"), rel)

    def test_model_url_pinned_by_commit(self):
        meta = self.entries[f"{MODEL_REL}/model_stateful.onnx"]
        # raw.githubusercontent.com/OWNER/REPO/40-hex-SHA/... — immutable pin
        m = re.match(
            r"^https://raw\.githubusercontent\.com/[^/]+/[^/]+/([0-9a-f]{40})/", meta["url"]
        )
        self.assertTrue(m, f"model url must be pinned to a full commit sha: {meta['url']}")

    def test_ort_url_pinned_by_version(self):
        meta = self.entries["vendor/ort/ort.wasm.bundle.min.mjs"]
        self.assertRegex(meta["url"], r"onnxruntime-web@\d+\.\d+\.\d+/")


class ModelConfigTest(unittest.TestCase):
    """config.ini / initial_states.json consistency (skipped without assets)."""

    @classmethod
    def setUpClass(cls):
        base = NOISE / MODEL_REL
        cls.config = base / "config.ini"
        cls.json = base / "initial_states.json"
        cls.bin = base / "initial_states.bin"
        cls.model = base / "model_stateful.onnx"
        if not cls.model.is_file():
            raise unittest.SkipTest("assets not fetched: run noise/scripts/fetch-dpdfnet.py")

    def _config_map(self):
        text = self.config.read_text()
        return dict(re.findall(r"^(\w+)\s*=\s*(\S+)", text, re.M))

    def test_config_is_48k_spec_real(self):
        cfg = self._config_map()
        self.assertEqual(cfg["sample_rate"], "48000")
        self.assertEqual(cfg["win_len"], "960")
        self.assertEqual(cfg["hop_size"], "480")
        self.assertEqual(cfg["freq_bins"], "481")
        self.assertEqual(cfg["interface"], "spec_real")

    def test_states_layout(self):
        cfg = self._config_map()
        self.assertEqual(int(cfg["num_states"]), 13)
        names = cfg["state_names"].split(",")
        self.assertEqual(len(names), int(cfg["num_states"]))
        layout = json.loads(self.json.read_text())
        self.assertEqual([s["name"] for s in layout], names)
        total = sum(s["num_elements"] for s in layout)
        self.assertEqual(self.bin.stat().st_size, total * 4)
        # offsets are dense
        acc = 0
        for s in layout:
            self.assertEqual(s["offset"], acc)
            acc += s["num_elements"]
        self.assertEqual(acc, total)

    def test_pin_digests(self):
        base = NOISE / MODEL_REL
        for entry in ("model_stateful.onnx", "initial_states.bin", "initial_states.json", "config.ini"):
            rel = f"{MODEL_REL}/{entry}"
            with self.subTest(rel=rel):
                digest = hashlib.sha256((base / entry).read_bytes()).hexdigest()
                self.assertEqual(digest, lock()[rel]["sha256"], f"sha256 drift for {rel}")


class OrtVendorTest(unittest.TestCase):
    def test_ort_digests(self):
        for rel in (
            "vendor/ort/ort.wasm.bundle.min.mjs",
            "vendor/ort/ort-wasm-simd-threaded.mjs",
            "vendor/ort/ort-wasm-simd-threaded.wasm",
        ):
            path = NOISE / rel
            if not path.is_file():
                self.skipTest(f"{rel} not fetched — run noise/scripts/fetch-dpdfnet.py")
            with self.subTest(rel=rel):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(digest, lock()[rel]["sha256"], f"sha256 drift for {rel}")


class ModelSignatureTest(unittest.TestCase):
    """The vendored module and the graph must agree on inputs/outputs. Pure
    protobuf-free sniff: ONNX protobuf stores node names as plain strings."""

    def test_io_names_in_graph(self):
        model = NOISE / MODEL_REL / "model_stateful.onnx"
        if not model.is_file():
            self.skipTest("model not fetched")
        blob = model.read_bytes()
        layout = json.loads((model.parent / "initial_states.json").read_text())
        self.assertIn(b"spec_enhanced", blob)
        self.assertIn(b"lsnr", blob)
        for s in layout:
            self.assertIn(s["name"].encode(), blob)
            self.assertIn((s["name"] + "_out").encode(), blob)


if __name__ == "__main__":
    unittest.main()
