"""Tests for the Electron silent installer (cinny-electron/scripts/install-lite-electron.sh).

Contract (Phase 2 decision): a successful install prints NOTHING (stdout and
stderr both empty) and exits 0; only fatal errors emit output. The AppImage
path must land: bin, .desktop (hyphen-free Exec quoting not required; exact
identity keys), 8 hicolor icon sizes, and a MIME type line registering both
schemes so cc.plotina.chat:// and matrix: links work.

Run the installer against a locally built AppImage:

    APPIMAGE=/path/to/Plotina-Lite-Desktop-*.AppImage \
    python3 -m unittest cinny/tests/test_install_lite_electron.py -v
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO / "cinny-electron" / "scripts" / "install-lite-electron.sh"
CANDIDATES = sorted((REPO / "cinny-electron" / "dist").glob("*.AppImage"))
APPIMAGE = (os.environ.get("APPIMAGE") or (str(CANDIDATES[0]) if CANDIDATES else "")) or None


@unittest.skipUnless(APPIMAGE and Path(APPIMAGE).exists(),
                     "set APPIMAGE=/path/to/built.AppImage to run")
@unittest.skipUnless(os.path.exists(SCRIPT), "installer script missing")
class InstallElectronTests(unittest.TestCase):
    def setUp(self):
        self.prefix = tempfile.mkdtemp(prefix="lite-inst-prefix-")

    def _run(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PREFIX=self.prefix)
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            capture_output=True, text=True, env=env, timeout=300,
        )

    def test_appimage_install_is_silent_and_lands_files(self):
        r = self._run("--appimage", APPIMAGE)
        self.assertEqual(r.returncode, 0, msg=f"installer failed: {r.stderr[-2000:]}")
        self.assertEqual(r.stdout, "", msg="success must print nothing to stdout")
        self.assertEqual(r.stderr, "", msg="success must print nothing to stderr")

        prefix = Path(self.prefix)
        binp = prefix / "bin" / "plotina-lite-desktop"
        desktop = prefix / "share" / "applications" / "plotina-lite-desktop.desktop"
        self.assertTrue(binp.exists() and os.access(binp, os.X_OK))
        self.assertTrue(desktop.exists())

        text = desktop.read_text()
        self.assertIn("Name=Plotina Lite Desktop", text)
        self.assertIn("Icon=plotina-lite-desktop", text)
        self.assertIn("StartupWMClass=plotina-lite-desktop", text)
        self.assertIn("x-scheme-handler/cc.plotina.chat", text)
        self.assertIn("x-scheme-handler/matrix", text)
        self.assertIn(f'Exec="{binp}"', text)

        icons = list((prefix / "share" / "icons" / "hicolor").glob("*/apps/plotina-lite-desktop.png"))
        self.assertGreaterEqual(len(icons), 8, msg=f"only {len(icons)} hicolor icons")

    def test_bad_file_is_fatal_and_named(self):
        r = self._run("--appimage", "/nonexistent/Plotina.AppImage")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ERROR:", r.stderr)  # a single error line, nothing else

    def test_unknown_flag_dies(self):
        r = self._run("--turbo")
        self.assertEqual(r.returncode, 1)
        self.assertIn("ERROR:", r.stderr)


if __name__ == "__main__":
    unittest.main()
