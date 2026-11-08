"""Tests for the Electron silent installer (cinny-electron/scripts/install-lite-electron.sh).

Contract (Phase 2 decision): a successful install prints NOTHING (stdout and
stderr both empty) and exits 0; only fatal errors emit output. The AppImage
path must land: bin, .desktop (hyphen-free Exec quoting not required; exact
identity keys), 8 hicolor icon sizes, and a MIME type line registering both
schemes so cc.plotina.chat:// and matrix: links work.

The --dev channel tests run entirely on local fixtures: an electron-builder
style latest-lite-linux-dev.yml and stub artifacts served from a temp HTTP
server (PLOTINA_LITE_DEV_YAML_URL override). The dev artifact must match the
yml's sha512 (base64 or hex) AND size before anything installs; mismatches
are fatal with no fallback to stable. apt/dpkg/sudo/gpg/xdg-mime are PATH
mocks, never the real thing.

Run the installer against a locally built AppImage:

    APPIMAGE=/path/to/Plotina-Lite-Desktop-*.AppImage \
    python3 -m unittest cinny/tests/test_install_lite_electron.py -v
"""
import base64
import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO / "cinny-electron" / "scripts" / "install-lite-electron.sh"
CANDIDATES = sorted((REPO / "cinny-electron" / "dist").glob("*.AppImage"))
APPIMAGE = (os.environ.get("APPIMAGE") or (str(CANDIDATES[0]) if CANDIDATES else "")) or None

DEV_YML_DEFAULT = "https://plotina.cc/dl/dev/lite/latest-lite-linux-dev.yml"


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


# ---------------------------------------------------------------- fixtures --
# --appimage-extract-able stub: writes the hicolor layout named in $ICON_SIZES
# under the names the Lite installer looks for (plotina-lite-desktop.png).
FAKE_EXTRACT_APPIMAGE = """#!/bin/sh
if [ "$1" = "--appimage-extract" ]; then
    python3 - <<'PYEOF'
import os
root = "squashfs-root"
os.makedirs(root, exist_ok=True)
for s in os.environ.get("ICON_SIZES", "").split():
    d = os.path.join(root, "usr/share/icons/hicolor", s + "x" + s, "apps")
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "plotina-lite-desktop.png"), "wb").write(b"PNG-fake")
PYEOF
    exit 0
fi
echo "fake: not an appimage" >&2
exit 1
"""

# ------------------------------------------------------------- mock tools --
MOCK_SUDO = """#!/bin/sh
if [ "$1" = "-n" ]; then
    echo "sudo -n true" >> "$MOCK_LOG"
    [ "${SUDO_N_FAIL:-0}" = 1 ] && exit 1
    exit 0
fi
if [ "$1" = "-v" ]; then echo "sudo -v" >> "$MOCK_LOG"; exit "${SUDO_V_FAIL:-1}"; fi
echo "sudo $*" >> "$MOCK_LOG"
exec env "$@"
"""
MOCK_APT_GET = """#!/bin/sh
echo "apt-get $*" >> "$MOCK_LOG"
exit 0
"""
MOCK_DPKG = """#!/bin/sh
echo "dpkg $*" >> "$MOCK_LOG"
exit 0
"""
MOCK_GPG_OK = """#!/bin/sh
echo "gpg $*" >> "$MOCK_LOG"
echo 'pub:-:4096:1:148192C8CB33A1BA:20240101T000000::::::'
exit 0
"""
MOCK_XDG_MIME = """#!/bin/sh
echo "xdg-mime $*" >> "$MOCK_LOG"
exit 0
"""
MOCK_UPDATE_DESKTOP_DB = """#!/bin/sh
echo "update-desktop-database $*" >> "$MOCK_LOG"
exit 0
"""

CORE_TOOLS = ["bash", "sh", "cat", "chmod", "cp", "curl", "env", "grep", "id", "install",
              "mkdir", "mktemp", "mv", "rm", "dirname", "basename", "python3", "sha512sum", "wc"]

FULL_MOCKS = {
    "sudo": MOCK_SUDO,
    "apt-get": MOCK_APT_GET,
    "dpkg": MOCK_DPKG,
    "gpg": MOCK_GPG_OK,
    "xdg-mime": MOCK_XDG_MIME,
    "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
}


def dev_b64_sha512(data: bytes) -> str:
    """sha512 in electron-builder's yml form: base64 of the raw digest."""
    return base64.b64encode(hashlib.sha512(data).digest()).decode()


def dev_yml_text(url: str, sha: str, size: int) -> str:
    """Exactly the shape of latest-lite-linux-dev.yml, including the
    top-level duplicates the parser must not confuse with files:[0]."""
    return (
        "version: 4.12.8-plotina.24-dev.42\n"
        "files:\n"
        f"  - url: {url}\n"
        f"    sha512: {sha}\n"
        f"    size: {size}\n"
        f"path: {url}\n"
        f"sha512: {sha}\n"
        "releaseDate: '2026-11-08T10:07:18.662Z'\n"
    )


class InstallerCase(unittest.TestCase):
    """Shared infra: temp HOME/PREFIX, minimal PATH (core tools + mocks),
    a local HTTP server rooted at tmp for fixture metadata and artifacts."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lite-dev-inst-"))
        self.home = self.tmp / "home"
        self.prefix = self.tmp / "prefix"
        self.home.mkdir()
        self.log = self.tmp / "mock.log"
        core = self.tmp / "corebin"
        core.mkdir()
        for tool in CORE_TOOLS:
            src = shutil.which(tool)
            if src:
                os.symlink(src, str(core / tool))
        self.core = core
        self.srv = None

    def tearDown(self):
        if self.srv is not None:
            self.srv.shutdown()
            self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def serve(self, directory: Path) -> str:
        self.srv = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            partial(
                type("Q", (SimpleHTTPRequestHandler,), {"log_message": lambda s, *a: None}),
                directory=str(directory),
            ),
        )
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.srv.server_address[1]}"

    def run_installer(self, args=(), *, mocks=None, extra_env=None):
        env = {"HOME": str(self.home), "PREFIX": str(self.prefix), "MOCK_LOG": str(self.log)}
        if mocks is not None:
            mockdir = self.tmp / "mockbin"
            mockdir.mkdir(exist_ok=True)
            for name, body in mocks.items():
                p = mockdir / name
                p.write_text(body)
                p.chmod(0o755)
            env["PATH"] = os.pathsep.join([str(mockdir), str(self.core)])
        else:
            env["PATH"] = str(self.core)
        env.update(extra_env or {})
        return subprocess.run(
            ["bash", str(SCRIPT), *args], env=env, cwd=str(self.tmp),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
            text=True, timeout=300,
        )

    def mock_log_lines(self):
        return self.log.read_text().splitlines() if self.log.exists() else []


class TestDevChannel(InstallerCase):
    """--dev: verified dev-channel AppImage from latest-lite-linux-dev.yml.
    Nothing is installed unless BOTH sha512 and size match; no apt, no
    GitHub; success stays silent like every other path of this installer."""

    def setUp(self):
        super().setUp()
        self.artifact = self.tmp / "Plotina-Lite-Desktop-4.12.8-plotina.24-dev.42-x86_64.AppImage"
        self.artifact.write_text(FAKE_EXTRACT_APPIMAGE)
        self.artifact.chmod(0o755)
        self.base = self.serve(self.tmp)
        self.xdg_mocks = {"xdg-mime": MOCK_XDG_MIME,
                          "update-desktop-database": MOCK_UPDATE_DESKTOP_DB}

    def write_yml(self, url=None, sha=None, size=None, name="latest-lite-linux-dev.yml"):
        data = self.artifact.read_bytes()
        p = self.tmp / name
        p.write_text(dev_yml_text(
            url if url is not None else f"{self.base}/{self.artifact.name}",
            sha if sha is not None else dev_b64_sha512(data),
            size if size is not None else len(data),
        ))
        return f"{self.base}/{name}"

    # ----- success: the dev artifact lands via the existing AppImage path ----

    def test_dev_installs_verified_artifact_silently(self):
        yml = self.write_yml()
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": yml,
                                          "ICON_SIZES": "16 24 32 48 64 128 256 512"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertEqual(r.stderr, "", "success must print nothing")
        binp = self.prefix / "bin" / "plotina-lite-desktop"
        self.assertTrue(binp.is_file() and os.access(binp, os.X_OK))
        desktop = (self.prefix / "share" / "applications" / "plotina-lite-desktop.desktop").read_text()
        self.assertIn(f'Exec="{binp}"', desktop)
        self.assertIn("Icon=plotina-lite-desktop", desktop)
        self.assertIn("x-scheme-handler/cc.plotina.chat", desktop)
        self.assertIn("x-scheme-handler/matrix", desktop)
        icons = list((self.prefix / "share" / "icons" / "hicolor").glob("*/apps/plotina-lite-desktop.png"))
        self.assertEqual(len(icons), 8, icons)

    def test_dev_never_touches_apt_even_when_repo_is_available(self):
        yml = self.write_yml()
        r = self.run_installer(["--dev"], mocks=FULL_MOCKS,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": yml})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite-desktop").is_file())
        for line in self.mock_log_lines():
            self.assertNotIn("apt-get", line)
            self.assertNotIn("dpkg", line)

    def test_dev_hex_sha512_and_relative_url_accepted(self):
        yml = self.write_yml(url=self.artifact.name,
                             sha=hashlib.sha512(self.artifact.read_bytes()).hexdigest())
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": yml})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite-desktop").is_file())

    # ----- refusals: mismatch means nothing installed, no stable fallback ----

    def _assert_refused(self, r, needle):
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ERROR:", r.stderr)
        self.assertIn(needle, r.stderr)
        self.assertFalse((self.prefix / "bin" / "plotina-lite-desktop").exists(),
                         "a refused dev artifact must not install or fall back")

    def test_dev_sha512_mismatch_refused(self):
        yml = self.write_yml(sha=dev_b64_sha512(b"tampered-bytes"))
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": yml})
        self._assert_refused(r, "sha512 mismatch")

    def test_dev_size_mismatch_refused(self):
        yml = self.write_yml(size=self.artifact.stat().st_size + 1)
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": yml})
        self._assert_refused(r, "size")

    def test_dev_yml_without_complete_entry_refused(self):
        p = self.tmp / "broken.yml"
        p.write_text("version: 1.0\npath: x.AppImage\n")
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": f"{self.base}/broken.yml"})
        self._assert_refused(r, "files:")

    def test_dev_metadata_download_failure_refused(self):
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": "http://127.0.0.1:1/latest-lite-linux-dev.yml"})
        self._assert_refused(r, "download failed")

    # ----- flag conflicts -----

    def test_dev_and_deb_rejected_in_both_orders(self):
        for args in (["--dev", "--deb"], ["--deb", "--dev"]):
            r = self.run_installer(args, mocks=FULL_MOCKS, extra_env={})
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn("--dev and --deb", r.stderr)

    def test_dev_with_positional_file_rejected(self):
        r = self.run_installer(["--dev", str(self.artifact)], mocks=self.xdg_mocks)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("positional", r.stderr)

    def test_dev_with_lite_appimage_url_rejected(self):
        r = self.run_installer(["--dev"], mocks=self.xdg_mocks,
                               extra_env={"PLOTINA_LITE_APPIMAGE_URL": f"{self.base}/{self.artifact.name}"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PLOTINA_LITE_APPIMAGE_URL", r.stderr)

    # ----- stable path untouched: without --dev the yml is never fetched -----

    def test_stable_appimage_ignores_dev_yml(self):
        r = self.run_installer(["--appimage", str(self.artifact)], mocks=FULL_MOCKS,
                               extra_env={"PLOTINA_LITE_DEV_YAML_URL": "http://127.0.0.1:1/never-fetched.yml"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite-desktop").is_file())


@unittest.skipUnless(os.path.exists(SCRIPT), "installer script missing")
class TestDevChannelContract(unittest.TestCase):
    """Constants and help text for the dev channel."""

    def test_dev_constants_and_help(self):
        text = SCRIPT.read_text()
        self.assertIn(f'DEV_YAML_URL="${{PLOTINA_LITE_DEV_YAML_URL:-{DEV_YML_DEFAULT}}}"', text)
        self.assertIn("--dev)", text)
        self.assertIn("PLOTINA_LITE_DEV_YAML_URL", text)
        self.assertIn("sha512", text)

    def test_installer_never_references_github(self):
        self.assertNotIn("github.com", SCRIPT.read_text().lower())


if __name__ == "__main__":
    unittest.main()
