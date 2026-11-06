"""Unit tests for cinny/scripts/build_config.py and updater_manifest.py
(run: python3 -m unittest discover -s cinny/tests).

These two scripts are the whole updater contract: build_config.py decides the
version every installed app compares against, updater_manifest.py decides what
the update feed tells those apps to download. A silent mistake in either is an
app that never updates, or one that downloads a file whose signature it cannot
verify. So the tests are mostly *negative*: the wrong value must raise, not be
built into a release.

The overlay fixtures are read from the repository's own cinny/tauri.plotina.json
where practical, so a future edit that disables the updater again fails here
instead of in CI.
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "scripts"))

import build_config  # noqa: E402
import updater_manifest  # noqa: E402

OVERLAY = HERE.parent / "tauri.plotina.json"
UPSTREAM_TAG = (HERE.parent / "UPSTREAM_TAG").read_text(encoding="utf-8").strip()

# A structurally real Tauri updater signature. `tauri signer sign` does NOT write
# minisign text: it writes ONE base64 line that *wraps* the minisign document
# (untrusted comment, the 74-byte signature frame, a trusted comment naming the
# file it signed, then the raw 64-byte ed25519 signature). The client base64-
# decodes that and hands the text to minisign_verify, so a fixture that only
# looks like minisign text would be rejected by every real install. The bytes are
# not cryptographically verified here; CI does that in
# `cargo test --test updater_signature` against the built bundle.
KEY_ID = bytes.fromhex("A8F0EF4E176BB29E")


def minisign_frame(magic=b"ED"):
    """The minisign signature frame: magic + key id + 64-byte ed25519 signature."""
    return base64.b64encode(magic + KEY_ID + bytes(range(64))).decode("ascii")


def raw_ed25519():
    return base64.b64encode(bytes(range(64))).decode("ascii")


def wrap_signature(signed_name, magic=b"ED"):
    """The exact content of a .sig file for an artifact called `signed_name`."""
    document = "\n".join([
        "untrusted comment: signature from tauri secret key",
        minisign_frame(magic),
        "trusted comment: timestamp:1793989738\tfile:%s" % signed_name,
        raw_ed25519(),
        "",
    ])
    return base64.b64encode(document.encode("utf-8")).decode("ascii")


def fake_sig(tmp: Path, name: str, signed_name=None) -> Path:
    """Write `<name>` (already ending in .sig) wrapping a signature of `name`."""
    path = tmp / name
    artifact = name[:-4] if name.endswith(".sig") else name
    path.write_text(wrap_signature(signed_name or artifact) + "\n", encoding="utf-8")
    return path


class VersionStampTests(unittest.TestCase):
    def test_release_tag_becomes_patched_numeric_version(self) -> None:
        self.assertEqual(
            build_config.derive_version("v4.12.8-plotina-lite-desktop.18", UPSTREAM_TAG),
            "4.12.818")

    def test_tag_without_a_counter_is_the_base_slot(self) -> None:
        self.assertEqual(
            build_config.derive_version("v4.12.8-plotina-lite-desktop", UPSTREAM_TAG),
            "4.12.800")

    def test_branch_build_uses_the_upstream_tag_base(self) -> None:
        self.assertEqual(build_config.derive_version("feat/lite-updater", "v4.12.8"), "4.12.800")

    def test_successive_builds_are_strictly_increasing(self) -> None:
        previous = None
        for build in range(1, 100):
            version = build_config.stamp((4, 12, 8), build)
            numeric = tuple(int(part) for part in version.split("."))
            if previous is not None:
                self.assertGreater(numeric, previous, version)
            previous = numeric

    def test_counter_never_crosses_a_patch_boundary(self) -> None:
        # The scheme reserves 100 slots per upstream patch release.
        self.assertEqual(build_config.stamp((4, 12, 8), 99), "4.12.899")
        with self.assertRaises(build_config.BuildConfigError):
            build_config.stamp((4, 12, 8), 100)

    def test_next_upstream_base_always_outranks_the_previous_builds(self) -> None:
        self.assertEqual(build_config.stamp((4, 12, 9), 0), "4.12.900")
        self.assertEqual(build_config.stamp((4, 12, 10), 1), "4.12.1001")

    def test_prerelease_versions_are_refused(self) -> None:
        # '-' would break the RPM Version field and split the Debian version.
        for bad in ("4.12.8-plotina-lite-desktop.18", "4.12.8+build.1", "4.12", "v4.12.8", ""):
            with self.assertRaises(build_config.BuildConfigError, msg=bad):
                build_config.validate_version(bad)

    def test_windows_field_overflow_is_refused(self) -> None:
        with self.assertRaises(build_config.BuildConfigError):
            build_config.stamp((4, 12, 700), 1)

    def test_bad_upstream_tag_is_reported(self) -> None:
        with self.assertRaises(build_config.BuildConfigError):
            build_config.derive_version("main", "cinny-4.12")


class OverlayCheckTests(unittest.TestCase):
    def test_repository_overlay_passes(self) -> None:
        self.assertTrue(build_config.check_updater_overlay(json.loads(OVERLAY.read_text())))

    def test_http_endpoint_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["plugins"]["updater"]["endpoints"] = ["http://plotina.cc/dl/lite/latest.json"]
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_foreign_endpoint_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["plugins"]["updater"]["endpoints"] = [
            "https://github.com/cinnyapp/cinny-desktop/releases/download/tauri/release.json"]
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_empty_endpoint_list_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["plugins"]["updater"]["endpoints"] = []
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_missing_pubkey_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        del overlay["plugins"]["updater"]["pubkey"]
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_garbage_pubkey_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["plugins"]["updater"]["pubkey"] = "not-base64-at-all!!!"
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_updater_artifacts_disabled_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["bundle"]["createUpdaterArtifacts"] = "v1Compatible"
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_identifier_drift_is_refused(self) -> None:
        overlay = json.loads(OVERLAY.read_text())
        overlay["identifier"] = "in.cinny.app"
        with self.assertRaises(build_config.BuildConfigError):
            build_config.check_updater_overlay(overlay)

    def test_config_subcommand_stamps_and_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tauri.build.json"
            build_config.write_build_config(OVERLAY, out, "4.12.818")
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["version"], "4.12.818")
            self.assertEqual(data["productName"], "Plotina Lite Desktop")
            self.assertEqual(data["plugins"]["updater"]["endpoints"],
                             ["https://plotina.cc/dl/lite/latest.json"])

    def test_unsigned_local_build_flips_only_the_generated_file(self) -> None:
        # scripts/build.sh NO_UPDATER=1: a developer without the key gets a
        # bundle, and the checked-in overlay is never touched.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tauri.local.json"
            build_config.write_build_config(OVERLAY, out, "4.12.800",
                                            unsigned_local_build=True)
            self.assertFalse(json.loads(out.read_text())["bundle"]["createUpdaterArtifacts"])
            self.assertTrue(json.loads(OVERLAY.read_text())["bundle"]["createUpdaterArtifacts"])

    def test_unsigned_local_build_still_validates_the_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            broken = json.loads(OVERLAY.read_text())
            broken["plugins"]["updater"]["endpoints"] = []
            path = Path(tmp) / "broken-overlay.json"
            path.write_text(json.dumps(broken), encoding="utf-8")
            with self.assertRaises(build_config.BuildConfigError):
                build_config.write_build_config(path, Path(tmp) / "out.json", "4.12.800",
                                                 unsigned_local_build=True)


class ManifestBuildTests(unittest.TestCase):
    def test_two_platform_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            sigs = {
                "linux-x86_64": fake_sig(tmp_path, "Plotina-Lite-Desktop.AppImage.sig"),
                "windows-x86_64": fake_sig(tmp_path, "Plotina-Lite-Desktop-setup.exe.sig"),
            }
            manifest = updater_manifest.build_manifest(
                "4.12.818", {k: str(v) for k, v in sigs.items()},
                pub_date="2026-11-07T18:00:00Z", notes="Plotina Lite Desktop .18")
            self.assertEqual(sorted(manifest["platforms"]), ["linux-x86_64", "windows-x86_64"])
            self.assertEqual(manifest["platforms"]["linux-x86_64"]["url"],
                             "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage")
            self.assertEqual(manifest["platforms"]["windows-x86_64"]["url"],
                             "https://plotina.cc/dl/Plotina-Lite-Desktop-setup.exe")
            self.assertEqual(manifest["version"], "4.12.818")
            self.assertEqual(updater_manifest.validate_manifest(manifest), [])
            out = updater_manifest.write_manifest(manifest, tmp_path / "update-lite-desktop.json")
            self.assertEqual(json.loads(out.read_text()), manifest)

    def test_signature_must_belong_to_the_served_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wrong = fake_sig(tmp_path, "Plotina-Lite-Desktop.deb.sig")
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest(
                    "4.12.818", {"linux-x86_64": str(wrong)}, notes="x")

    def test_plain_minisign_text_is_not_a_tauri_signature(self) -> None:
        # The shape a human pastes from a .sig file after one manual decode. The
        # client base64-decodes the field first, so this fails on every install.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "Plotina-Lite-Desktop.AppImage.sig"
            path.write_text("untrusted comment: signature from tauri secret key\n%s\n"
                            % minisign_frame(), encoding="utf-8")
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest(
                    "4.12.818", {"linux-x86_64": str(path)}, notes="x")

    def test_truncated_and_wrong_length_frames_are_rejected(self) -> None:
        for bad in (base64.b64encode(b"nope").decode("ascii"),
                    wrap_signature("x").replace("=", "", 1),
                    base64.b64encode(("untrusted comment: sig\n%s\n"
                                       % base64.b64encode(b"Z" * 40).decode()).encode()).decode()):
            with self.subTest(bad=bad[:24]):
                with self.assertRaises(updater_manifest.ManifestError):
                    updater_manifest.decode_signature(bad)

    def test_signature_key_id_and_signed_name_are_readable(self) -> None:
        document, frame = updater_manifest.decode_signature(
            wrap_signature("Plotina Lite Desktop_4.12.818_amd64.AppImage"))
        self.assertEqual(updater_manifest.signature_key_id(frame), KEY_ID)
        self.assertEqual(
            updater_manifest.signed_file_name(document),
            "Plotina Lite Desktop_4.12.818_amd64.AppImage")

    def test_the_signed_name_is_the_build_filename_not_the_alias(self) -> None:
        # CI renames to the stable /dl name after signing, so the name inside the
        # signature is reported and never asserted against the URL.
        with tempfile.TemporaryDirectory() as tmp:
            sig = fake_sig(Path(tmp), "Plotina-Lite-Desktop.AppImage.sig",
                           signed_name="Plotina Lite Desktop_4.12.818_amd64.AppImage")
            manifest = updater_manifest.build_manifest(
                "4.12.818", {"linux-x86_64": str(sig)}, notes="x")
            self.assertEqual(manifest["platforms"]["linux-x86_64"]["url"],
                             "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage")
            self.assertIn("Plotina Lite Desktop_4.12.818_amd64.AppImage",
                          updater_manifest.summarise(manifest))

    def test_msi_is_never_publishable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            sig = fake_sig(tmp_path, "Plotina-Lite-Desktop.msi.sig")
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest(
                    "4.12.818", {"windows-x86_64": str(sig)}, notes="x")

    def test_unknown_platform_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            sig = fake_sig(tmp_path, "Plotina-Lite-Desktop.app.tar.gz.sig")
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest("4.12.818", {"darwin-aarch64": str(sig)}, notes="x")

    def test_empty_notes_and_empty_platforms_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sig = str(fake_sig(Path(tmp), "Plotina-Lite-Desktop.AppImage.sig"))
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest("4.12.818", {"linux-x86_64": sig}, notes="  ")
            with self.assertRaises(updater_manifest.ManifestError):
                updater_manifest.build_manifest("4.12.818", {}, notes="x")

    def test_missing_signature_file_is_refused(self) -> None:
        with self.assertRaises(updater_manifest.ManifestError):
            updater_manifest.build_manifest(
                "4.12.818", {"linux-x86_64": "/nowhere/Plotina-Lite-Desktop.AppImage.sig"},
                notes="x")

    def test_non_signature_text_is_refused(self) -> None:
        for junk in ("sha256 abc123", "not base64 at all !!", "", "\n\n"):
            with self.subTest(junk=junk):
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "Plotina-Lite-Desktop.AppImage.sig"
                    path.write_text(junk, encoding="utf-8")
                    with self.assertRaises(updater_manifest.ManifestError):
                        updater_manifest.build_manifest("4.12.818",
                                                        {"linux-x86_64": str(path)}, notes="x")

    def test_bad_pub_date_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sig = str(fake_sig(Path(tmp), "Plotina-Lite-Desktop.AppImage.sig"))
            for bad in ("07/11/2026", "2026-13-40T99:99:99Z", "2026-11-07"):
                with self.assertRaises(updater_manifest.ManifestError, msg=bad):
                    updater_manifest.build_manifest("4.12.818", {"linux-x86_64": sig},
                                                     pub_date=bad, notes="x")

    def test_default_pub_date_is_rfc3339_utc(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sig = str(fake_sig(Path(tmp), "Plotina-Lite-Desktop.AppImage.sig"))
            manifest = updater_manifest.build_manifest("4.12.818", {"linux-x86_64": sig}, notes="x")
            self.assertRegex(manifest["pub_date"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class ManifestValidateTests(unittest.TestCase):
    def valid(self) -> dict:
        return {
            "version": "4.12.818",
            "notes": "Plotina Lite Desktop .18",
            "pub_date": "2026-11-07T18:00:00Z",
            "platforms": {
                "linux-x86_64": {
                    "url": "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage",
                    "signature": wrap_signature("Plotina-Lite-Desktop.AppImage"),
                },
                "windows-x86_64": {
                    "url": "https://plotina.cc/dl/Plotina-Lite-Desktop-setup.exe",
                    "signature": wrap_signature("Plotina-Lite-Desktop-setup.exe"),
                },
            },
        }

    def test_valid_manifest_has_no_errors(self) -> None:
        self.assertEqual(updater_manifest.validate_manifest(self.valid()), [])

    def test_http_url_is_an_error(self) -> None:
        data = self.valid()
        data["platforms"]["linux-x86_64"]["url"] = \
            "http://plotina.cc/dl/Plotina-Lite-Desktop.AppImage"
        self.assertTrue(any("not https" in e for e in updater_manifest.validate_manifest(data)))

    def test_foreign_host_url_is_an_error(self) -> None:
        data = self.valid()
        data["platforms"]["windows-x86_64"]["url"] = "https://example.com/setup.exe"
        self.assertTrue(any("plotina.cc" in e for e in updater_manifest.validate_manifest(data)))

    def test_url_versioned_github_asset_is_an_error(self) -> None:
        # A /releases/download/<tag>/ URL 404s the moment a release is pruned and
        # rate-limits on a busy day: the feed must stay on the stable aliases.
        data = self.valid()
        data["platforms"]["linux-x86_64"]["url"] = (
            "https://github.com/plotina-cc/clients/releases/download/"
            "v4.12.8-plotina-lite-desktop.18/Plotina-Lite-Desktop.AppImage")
        self.assertTrue(updater_manifest.validate_manifest(data))

    def test_signature_as_url_is_an_error(self) -> None:
        data = self.valid()
        data["platforms"]["linux-x86_64"]["signature"] = \
            "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage.sig"
        self.assertTrue(any("signature" in e for e in updater_manifest.validate_manifest(data)))

    def test_signature_as_raw_text_is_an_error(self) -> None:
        data = self.valid()
        data["platforms"]["linux-x86_64"]["signature"] = \
            "untrusted comment: signature from tauri secret key\n" + minisign_frame()
        self.assertTrue(any("signature" in e for e in updater_manifest.validate_manifest(data)))

    def test_deb_and_rpm_are_not_updater_artifacts(self) -> None:
        for name in ("Plotina-Lite-Desktop.deb", "Plotina-Lite-Desktop.rpm"):
            data = self.valid()
            data["platforms"]["linux-x86_64"]["url"] = "https://plotina.cc/dl/" + name
            errors = updater_manifest.validate_manifest(data)
            self.assertTrue(any("stable artifact" in e for e in errors), (name, errors))

    def test_msi_url_is_an_error(self) -> None:
        data = self.valid()
        data["platforms"]["windows-x86_64"]["url"] = "https://plotina.cc/dl/Plotina-Lite-Desktop.msi"
        errors = updater_manifest.validate_manifest(data)
        self.assertTrue(any("not the signed installer" in e for e in errors), errors)

    def test_tar_gz_linux_artifact_is_rejected_by_default(self) -> None:
        # 'v1Compatible' updater artifacts are a *different file* than the /dl
        # AppImage whose bytes the signature covers; the feed must name one
        # artifact per platform and it is the one we mirror.
        data = self.valid()
        data["platforms"]["linux-x86_64"]["url"] = \
            "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage.tar.gz"
        self.assertTrue(any("stable artifact" in e for e in updater_manifest.validate_manifest(data)))

    def test_missing_fields_are_all_reported(self) -> None:
        errors = updater_manifest.validate_manifest({"version": "4.12.818"})
        self.assertGreaterEqual(len(errors), 3)
        self.assertTrue(any("notes" in e for e in errors))
        self.assertTrue(any("pub_date" in e for e in errors))
        self.assertTrue(any("platforms" in e for e in errors))

    def test_prerelease_version_is_an_error(self) -> None:
        data = self.valid()
        data["version"] = "4.12.8-plotina-lite-desktop.18"
        self.assertTrue(any("version" in e for e in updater_manifest.validate_manifest(data)))

    def test_non_object_manifest(self) -> None:
        self.assertTrue(updater_manifest.validate_manifest([]))


if __name__ == "__main__":
    unittest.main()
