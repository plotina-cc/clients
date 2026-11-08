#!/usr/bin/env python3
"""Tests for scripts/install-appimage.sh — universal Linux installer (deb + AppImage).

Покрывает оба пути установщика:
  * AppImage в ${PREFIX:-$HOME/.local}: аргумент-путь / аргумент-URL /
    PLOTINA_APPIMAGE_URL, идемпотентность, содержимое .desktop, регистрация
    схемы (xdg-settings есть-ok / падает-ok / отсутствует-ok), скачивание с
    двумя попытками, скип иконок когда --appimage-extract падает;
  * apt-репозиторий: auto/--deb на Debian с sudo подписывают систему на
    signed apt-репозиторий Plotina (keyring + /etc/apt/sources.list.d,
    apt-get update + install plotina-desktop); при отказе ключа/apt/sudo —
    откат на AppImage. keyring, sources-list и URL ключа в тестах
    перенаправлены в tmp/локальный сервер; реальный apt не вызывается —
    apt/dpkg/sudo/gpg это моки в PATH. Позиционный .deb и PLOTINA_DEB_URL —
    устаревшая установка конкретного файла (apt-get, fallback dpkg -i +
    apt-get -f install) БЕЗ подписки на репозиторий.

Реальный AppImage скачивается один раз в фикстуру (кэш
/tmp/plotina-appimage-fixture, переопределяется PLOTINA_TEST_APPIMAGE /
PLOTINA_TEST_FIXTURE_DIR); если сети нет — эти тесты пропускаются, а
остальные идут на синтетическом файле (его --appimage-extract падает —
это ровно тот путь «иконки пропущены, установка не сломана»).

    cd element-desktop && python3 -m unittest discover -s tests -v
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "install-appimage.sh"

# Stable mirror name for the AppImage fallback: /srv/dl is refreshed by
# pull-release.py, so the script must not pin a release tag. The .deb is no
# longer downloaded from /dl by default — apt-repo install replaced it.
DEFAULT_APPIMAGE_URL = "https://plotina.cc/dl/Plotina-Desktop.AppImage"

# Exact source line from https://plotina.cc/apt/README.md
APT_SOURCES_LINE = "deb [signed-by=/usr/share/keyrings/plotina.gpg] https://plotina.cc/apt ./"

FAKE_APT_KEY = b"FAKE-PLOTINA-APT-KEY-BYTES\n"

FIXTURE_DIR = Path(os.environ.get("PLOTINA_TEST_FIXTURE_DIR", "/tmp/plotina-appimage-fixture"))

SSO_LINE = "Вход через SSO из браузера теперь открывается в Plotina Desktop."

# ---------------------------------------------------------------- fixtures --
_REAL_APPIMAGE: "Path | None" = None


def real_appimage() -> "Path | None":
    """Кэшированная фикстура настоящего AppImage; None если недоступна."""
    global _REAL_APPIMAGE
    if _REAL_APPIMAGE is not None:
        return _REAL_APPIMAGE
    override = os.environ.get("PLOTINA_TEST_APPIMAGE")
    if override and Path(override).is_file():
        _REAL_APPIMAGE = Path(override)
        return _REAL_APPIMAGE
    cached = FIXTURE_DIR / "Plotina-Desktop.AppImage"
    if cached.is_file() and cached.stat().st_size > 10_000_000:
        _REAL_APPIMAGE = cached
        return _REAL_APPIMAGE
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(
            ["curl", "-fsSL", "--retry", "2", "-o", str(cached) + ".part", DEFAULT_APPIMAGE_URL],
            timeout=900, capture_output=True,
        )
    except (subprocess.TimeoutExpired, OSError):
        r = None
    if r is not None and r.returncode == 0 and cached.with_suffix(".AppImage.part").is_file():
        os.chmod(str(cached) + ".part", 0o755)
        shutil.move(str(cached) + ".part", str(cached))
        _REAL_APPIMAGE = cached
    else:
        Path(str(cached) + ".part").unlink(missing_ok=True)
    return _REAL_APPIMAGE


def make_fake_appimage(directory: Path) -> Path:
    """AppImage-подобный фейк: --appimage-extract на нём падает."""
    p = directory / "Plotina-Desktop.AppImage"
    p.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--appimage-extract" ]; then echo "AppImage runtime: cannot unpack" >&2; exit 1; fi\n'
        "echo 'fake appimage' >&2; exit 1\n"
    )
    p.chmod(0o755)
    return p


def make_fake_deb(directory: Path) -> Path:
    p = directory / "Plotina-Desktop.deb"
    p.write_bytes(b"!<arch>\nfake deb for installer tests\n")
    return p


# ------------------------------------------------------------- icon helpers --
BRAND_RGB = (23, 121, 90)  # #17795a — Plotina green


def solid_png(path, size, rgb=BRAND_RGB):
    """Minimal 8-bit RGB PNG (filter 0), so tests need no Pillow."""
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    )


def png_decode(path):
    """Return (w, h, center_pixel_rgb) for 8-bit RGB/RGBA PNGs, all filters."""
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w, h, depth, ctype = 8, b"", None, None, None, None
    while pos + 8 <= len(data):
        (ln,) = struct.unpack(">I", data[pos:pos + 4])
        tag, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + ln
    assert depth == 8 and ctype in (2, 6), f"unsupported png depth={depth} color={ctype}"
    bpp = 3 if ctype == 2 else 4
    scan = zlib.decompress(idat)
    stride = w * bpp

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    prev, off = bytearray(stride), 0
    for y in range(h):
        f = scan[off]
        off += 1
        line = bytearray(scan[off:off + stride])
        off += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + prev[x]) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
            elif f == 4:
                line[x] = (line[x] + paeth(a, prev[x], c)) & 255
        if y == h // 2:
            i = (w // 2) * bpp
            return w, h, tuple(line[i:i + 3])
        prev = line
    raise AssertionError("PNG rows shorter than IHDR height")


# --appimage-extract-able fake: writes the hicolor layout named in $ICON_SIZES.
FAKE_EXTRACT_APPIMAGE = """#!/bin/sh
if [ "$1" = "--appimage-extract" ]; then
    python3 - <<'PYEOF'
import os, struct, zlib
def solid_png(path, size):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    raw = b"".join(b"\\x00" + bytes((23, 121, 90)) * size for _ in range(size))
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
root = "squashfs-root"
os.makedirs(root, exist_ok=True)
for s in os.environ.get("ICON_SIZES", "").split():
    d = os.path.join(root, "usr/share/icons/hicolor", s + "x" + s, "apps")
    os.makedirs(d, exist_ok=True)
    solid_png(os.path.join(d, "plotina-desktop.png"), int(s))
extra = os.environ.get("EXTRA_ROOT_PNG", "")
if extra:
    solid_png(os.path.join(root, extra), 512)
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
if [ "$1" = "install" ] && [ "${APT_INSTALL_FAIL:-0}" = 1 ]; then exit 100; fi
if [ "${APT_ALWAYS_FAIL:-0}" = 1 ]; then exit 100; fi
exit 0
"""
MOCK_DPKG = """#!/bin/sh
echo "dpkg $*" >> "$MOCK_LOG"
[ "${DPKG_FAIL:-0}" = 1 ] && exit 1
exit 0
"""
MOCK_XDG_SETTINGS = """#!/bin/sh
echo "xdg-settings $*" >> "$MOCK_LOG"
[ "${XDG_SETTINGS_FAIL:-0}" = 1 ] && exit 3
exit 0
"""
MOCK_UPDATE_DESKTOP_DB = """#!/bin/sh
echo "update-desktop-database $*" >> "$MOCK_LOG"
[ "${UDB_FAIL:-0}" = 1 ] && exit 5
exit 0
"""
MOCK_GPG_OK = """#!/bin/sh
echo "gpg $*" >> "$MOCK_LOG"
echo 'pub:-:4096:1:148192C8CB33A1BA:20240101T000000::::::'
exit 0
"""
MOCK_GPG_BAD = """#!/bin/sh
echo "gpg $*" >> "$MOCK_LOG"
echo 'no public key found'
exit 0
"""

CORE_TOOLS = ["bash", "sh", "cat", "chmod", "cp", "curl", "env", "grep", "id", "install",
              "mkdir", "mktemp", "mv", "rm", "dirname", "python3"]


def make_core_bin(directory: Path) -> Path:
    """Минимальный PATH без apt/dpkg/sudo/xdg — детерминированные прогоны."""
    d = directory / "corebin"
    d.mkdir(parents=True, exist_ok=True)
    for tool in CORE_TOOLS:
        src = shutil.which(tool)
        if src:
            os.symlink(src, str(d / tool))
    return d


def make_mock_bin(directory: Path, mocks: "dict[str, str]") -> Path:
    d = directory / "mockbin"
    d.mkdir(parents=True, exist_ok=True)
    for name, body in mocks.items():
        p = d / name
        p.write_text(body)
        p.chmod(0o755)
    return d


FULL_MOCKS = {
    "sudo": MOCK_SUDO,
    "apt-get": MOCK_APT_GET,
    "dpkg": MOCK_DPKG,
    "gpg": MOCK_GPG_OK,
    "xdg-settings": MOCK_XDG_SETTINGS,
    "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
}


class InstallerCase(unittest.TestCase):
    """Общая инфраструктура: temp HOME/PREFIX, мок-PATH, лог мок-вызовов."""

    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.home = self.tmp / "home"
        self.prefix = self.tmp / "prefix"
        self.home.mkdir()
        self.log = self.tmp / "mock.log"
        self.core = make_core_bin(self.tmp)

    def tearDown(self):
        if hasattr(self, "srv"):
            self.srv.shutdown()
            self.srv.server_close()

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

    def run_installer(self, args=(), *, mocks=None, extra_env=None, stdin_null=True,
                      unset=()):
        env = {
            "HOME": str(self.home),
            "PREFIX": str(self.prefix),
            "MOCK_LOG": str(self.log),
        }
        mockdir = None
        if mocks is not None:
            mockdir = make_mock_bin(self.tmp, mocks)
            env["PATH"] = os.pathsep.join([str(mockdir), str(self.core)])
        else:
            env["PATH"] = str(self.core)
        env.update(extra_env or {})
        for key in unset:
            env.pop(key, None)
        stdin = subprocess.DEVNULL if stdin_null else sys.stdin
        proc = subprocess.run(
            [str(SCRIPT), *args], env=env, cwd=str(self.tmp),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=stdin, text=True, timeout=300,
        )
        return proc

    def mock_log_lines(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def assert_sso_footer(self, proc):
        # The installer is deliberately silent on success: users see no
        # internal paths, package names or step-by-step comments.
        self.assertEqual("", proc.stdout.strip())


class TestAppImageIcons(InstallerCase):
    """Иконки AppImage-пути: hicolor-раскладка из squashfs-root должна
    устанавливаться ВСЕМИ размерами в PREFIX/share/icons/hicolor (KDE/Breeze
    выбирает нужный; один 512x512 в .36/.37 и поиск только по
    squashfs-root/*.png давали '?' в лончере)."""

    def setUp(self):
        super().setUp()
        self.xdg_mocks = {
            "xdg-settings": MOCK_XDG_SETTINGS,
            "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
        }

    def fake_extract_appimage(self):
        p = self.tmp / "Plotina-Desktop-Icons.AppImage"
        p.write_text(FAKE_EXTRACT_APPIMAGE)
        p.chmod(0o755)
        return p

    def install_with_sizes(self, sizes, extra_env=None):
        env = {"ICON_SIZES": " ".join(sizes)}
        if extra_env:
            env.update(extra_env)
        proc = self.run_installer([str(self.fake_extract_appimage())], mocks=self.xdg_mocks,
                                  extra_env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc

    def test_all_hicolor_sizes_installed_with_brand_pixels(self):
        sizes = ["16", "24", "32", "48", "64", "128", "256", "512"]
        self.install_with_sizes(sizes)
        icon_dir = self.prefix / "share" / "icons" / "hicolor"
        for s in sizes:
            png = icon_dir / f"{s}x{s}" / "apps" / "plotina-desktop.png"
            self.assertTrue(png.is_file(), f"missing installed icon {s}x{s}")
            w, h, px = png_decode(png)
            self.assertEqual((w, h), (int(s), int(s)), f"icon {s}x{s} decoded as {w}x{h}")
            self.assertEqual(px, BRAND_RGB, f"icon {s}x{s} is not brand green, got {px}")

    def test_desktop_entry_wired_to_installed_icon(self):
        self.install_with_sizes(["128", "512"])
        desktop = (self.prefix / "share" / "applications" / "plotina-desktop.desktop").read_text()
        self.assertIn("Icon=plotina-desktop", desktop)
        self.assertIn("StartupWMClass=plotina-desktop", desktop)

    def test_old_layout_fallback_root_png_only(self):
        # <= .36 manually-laid images: single plain png in squashfs-root.
        self.install_with_sizes([], extra_env={"EXTRA_ROOT_PNG": "plotina-desktop.png"})
        png = self.prefix / "share" / "icons" / "hicolor" / "512x512" / "apps" / "plotina-desktop.png"
        self.assertTrue(png.is_file(), "root png must fall back to 512x512")
        w, h, px = png_decode(png)
        self.assertEqual((w, h), (512, 512))
        self.assertEqual(px, BRAND_RGB)

    def test_real_appimage_installs_512_brand_icon(self):
        app = real_appimage()
        if app is None:
            self.skipTest("real AppImage fixture unavailable (offline?)")
        proc = self.run_installer([str(app)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        icon_dir = self.prefix / "share" / "icons" / "hicolor"
        installed = sorted(d.name for d in icon_dir.iterdir()
                           if (d / "apps" / "plotina-desktop.png").is_file())
        self.assertTrue(installed, f"no icons installed from real AppImage: {proc.stdout}")
        self.assertIn("512x512", installed, installed)
        w, h, px = png_decode(icon_dir / "512x512" / "apps" / "plotina-desktop.png")
        self.assertEqual((w, h), (512, 512))
        # /dl may serve any recent build; every Plotina icon is a saturated
        # green glyph field — exact #17795a is asserted in the synthetic test.
        r, g, b = px
        self.assertTrue(g > r and g > b and g >= 90,
                        f"installed 512x512 icon is not green, got {px}")



class TestScriptContract(InstallerCase):
    """Пункт 1/5 из ТЗ: константы, strict mode, self-contained запуск."""

    def test_strict_mode_and_optional_arg(self):
        text = SCRIPT.read_text()
        self.assertIn("set -euo pipefail", text)
        self.assertNotIn("${1:?", text, "аргумент больше не обязателен")

    def test_release_url_constants(self):
        text = SCRIPT.read_text()
        self.assertIn(f'DEFAULT_APPIMAGE_URL="{DEFAULT_APPIMAGE_URL}"', text)
        self.assertIn("curl -fsSL https://plotina.cc/dl/Plotina-Desktop-install.sh | bash", text)
        self.assertNotIn("DEFAULT_DEB_URL", text,
                         "deb-download default removed: apt-repo install replaced it")

    def test_apt_repo_constants_match_readme(self):
        """Подписка на репозиторий ровно по /apt/README.md: ключ, список,
        строка sources и имя пакета не должны уплыть в другие значения."""
        text = SCRIPT.read_text()
        self.assertIn(f"APT_SOURCES_LINE='{APT_SOURCES_LINE}'", text)
        self.assertIn('APT_KEYRING="${PLOTINA_APT_KEYRING:-/usr/share/keyrings/plotina.gpg}"', text)
        self.assertIn('APT_LIST="${PLOTINA_APT_LIST:-/etc/apt/sources.list.d/plotina.list}"', text)
        self.assertIn('APT_KEY_URL="${PLOTINA_APT_KEY_URL:-https://plotina.cc/apt/key.gpg}"', text)
        self.assertIn('APT_PACKAGE="plotina-desktop"', text)

    def test_env_overrides_supported(self):
        text = SCRIPT.read_text()
        self.assertIn("PLOTINA_DEB_URL", text)   # deprecated, but still honoured
        self.assertIn("PLOTINA_APPIMAGE_URL", text)
        self.assertIn("PLOTINA_APT_KEYRING", text)
        self.assertIn("PLOTINA_APT_LIST", text)
        self.assertIn("PLOTINA_APT_KEY_URL", text)


class TestAppImagePath(InstallerCase):
    """AppImage-путь (нет apt-get/sudo в PATH → auto всегда идёт в AppImage)."""

    def setUp(self):
        super().setUp()
        self.xdg_mocks = {
            "xdg-settings": MOCK_XDG_SETTINGS,
            "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
        }
        self.fake = make_fake_appimage(self.tmp)

    def test_install_from_path_arg(self):
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        binp = self.prefix / "bin" / "plotina-desktop"
        self.assertTrue(binp.is_file() and os.access(binp, os.X_OK))
        desktop = (self.prefix / "share" / "applications" / "plotina-desktop.desktop").read_text()
        self.assertIn(f'Exec="{binp}"', desktop)
        self.assertIn("Icon=plotina-desktop", desktop)
        self.assertIn("Name=Plotina Desktop", desktop)
        self.assertIn("Comment=", desktop)
        self.assertIn("MimeType=x-scheme-handler/io.element.desktop;", desktop)
        self.assertTrue(any(l.endswith("set default-url-scheme-handler io.element.desktop "
                                        "plotina-desktop.desktop") for l in self.mock_log_lines()),
                        self.mock_log_lines())
        self.assert_sso_footer(proc)

    def test_default_prefix_uses_home(self):
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks, unset=("PREFIX",))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.home / ".local" / "bin" / "plotina-desktop").is_file())

    def test_idempotent_second_run(self):
        first = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        second = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())
        self.assert_sso_footer(second)

    def test_env_url_override_downloads_without_args(self):
        url = self.serve(self.tmp) + "/Plotina-Desktop.AppImage"
        proc = self.run_installer(mocks=self.xdg_mocks, extra_env={"PLOTINA_APPIMAGE_URL": url})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual("", proc.stdout.strip())
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())
        self.assert_sso_footer(proc)

    def test_url_argument_downloads(self):
        url = self.serve(self.tmp) + "/Plotina-Desktop.AppImage"
        proc = self.run_installer([url], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_missing_path_arg_fails(self):
        proc = self.run_installer(["/nonexistent/Plotina-Desktop.AppImage"], mocks=self.xdg_mocks)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("файл не найден", proc.stderr)

    def test_download_failure_warns_two_attempts_and_fails(self):
        proc = self.run_installer(
            mocks=self.xdg_mocks,
            extra_env={"PLOTINA_APPIMAGE_URL": "http://127.0.0.1:1/Plotina-Desktop.AppImage"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("ОШИБКА", proc.stderr)
        self.assertNotIn("попытка", proc.stderr)
        self.assertIn("не удалось скачать", proc.stderr)

    def test_fake_appimage_extract_failure_skips_icons_but_installs(self):
        # --appimage-extract на фейке падает — установка не должна роняться.
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("не удалось извлечь иконки", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())
        self.assertTrue((self.prefix / "share" / "applications" / "plotina-desktop.desktop").is_file())
        self.assertFalse((self.prefix / "share" / "icons").exists())

    def test_registration_called_when_xdg_settings_present(self):
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("Схема", proc.stdout)
        self.assertIn("update-desktop-database", "\n".join(self.mock_log_lines()))

    def test_xdg_settings_failing_does_not_kill_install(self):
        mocks = {"xdg-settings": MOCK_XDG_SETTINGS, "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
                 "sudo": "exit 1\n", "apt-get": "exit 1\n", "dpkg": "exit 1\n"}
        proc = self.run_installer(
            [str(self.fake)], mocks=mocks, extra_env={"XDG_SETTINGS_FAIL": "1", "UDB_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("xdg-settings", proc.stderr)
        self.assertNotIn("update-desktop-database", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_xdg_tools_missing_does_not_kill_install(self):
        proc = self.run_installer([str(self.fake)])  # PATH=core: нет xdg-утилит
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("xdg-settings", proc.stderr)
        self.assertNotIn("update-desktop-database", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_force_appimage_flag_ignores_deb_env(self):
        proc = self.run_installer(["--appimage", str(self.fake)], mocks=FULL_MOCKS)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())
        for line in self.mock_log_lines():
            self.assertNotIn("apt-get", line)


@unittest.skipIf(os.geteuid() == 0, "нужен non-root, чтобы мок-sudo имел значение")
class TestDebPath(InstallerCase):
    """apt-путь: auto и --deb ставят plotina-desktop из подписанного
    apt-репозитория Plotina (keyring + sources-list + apt-get update/
    install), а НЕ из скачанного .deb. Keyring/sources-list/URL ключа
    перенаправлены в tmp и локальный сервер, поэтому настоящие /etc и
    /usr/share не трогаются; apt/dpkg/sudo/gpg в PATH — моки, тестируется
    разбор аргументов и выбор пути, а не работа пакетного менеджера.
    Позиционный .deb и PLOTINA_DEB_URL — устаревшая установка конкретного
    файла (без подписки на репозиторий)."""

    def setUp(self):
        super().setUp()
        self.deb = make_fake_deb(self.tmp)
        self.fake = make_fake_appimage(self.tmp)
        (self.tmp / "key.gpg").write_bytes(FAKE_APT_KEY)
        self.base = self.serve(self.tmp)
        self.keyring = self.tmp / "keyrings" / "plotina.gpg"
        self.list_file = self.tmp / "sources.list.d" / "plotina.list"
        self.env = {
            "PLOTINA_APPIMAGE_URL": f"{self.base}/Plotina-Desktop.AppImage",
            "PLOTINA_APT_KEY_URL": f"{self.base}/key.gpg",
            "PLOTINA_APT_KEYRING": str(self.keyring),
            "PLOTINA_APT_LIST": str(self.list_file),
        }

    def repo_install_attempted(self):
        return any(l == "apt-get install -y plotina-desktop" for l in self.mock_log_lines())

    # ----- подписка на репозиторий (default для auto и --deb) -----

    def test_auto_subscribes_repo_and_installs_package(self):
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.mock_log_lines()
        self.assertIn("apt-get update", lines)
        self.assertIn("apt-get install -y plotina-desktop", lines)
        self.assertEqual(self.keyring.read_bytes(), FAKE_APT_KEY)
        self.assertEqual(self.list_file.read_text(), APT_SOURCES_LINE + "\n")
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists(),
                         "apt-путь не должен катать AppImage")
        self.assert_sso_footer(proc)

    def test_repo_existing_keyring_and_list_are_not_touched(self):
        self.keyring.parent.mkdir(parents=True, exist_ok=True)
        self.keyring.write_bytes(b"ADMIN-KEY")
        self.list_file.parent.mkdir(parents=True, exist_ok=True)
        self.list_file.write_text("deb http://internal-mirror/apt ./\n")
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.keyring.read_bytes(), b"ADMIN-KEY")
        self.assertEqual(self.list_file.read_text(), "deb http://internal-mirror/apt ./\n")
        self.assertIn("apt-get install -y plotina-desktop", self.mock_log_lines())

    def test_repo_idempotent_second_run(self):
        first = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        second = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.list_file.read_text(), APT_SOURCES_LINE + "\n")
        self.assert_sso_footer(second)

    def test_repo_bad_key_is_not_written_and_falls_back(self):
        mocks = {**FULL_MOCKS, "gpg": MOCK_GPG_BAD}
        proc = self.run_installer(mocks=mocks, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.keyring.exists(), "неразбираемый ключ не должен попасть в keyring")
        self.assertFalse(self.repo_install_attempted())
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_repo_key_download_failure_falls_back_to_appimage(self):
        env = {**self.env, "PLOTINA_APT_KEY_URL": "http://127.0.0.1:1/key.gpg"}
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.keyring.exists())
        self.assertFalse(self.repo_install_attempted())
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_repo_unwritable_target_falls_back_to_appimage(self):
        ro = self.tmp / "ro"
        ro.mkdir()
        ro.chmod(0o500)  # каталог внутри создать нельзя — apt-путь обязан отвалиться чисто
        env = {**self.env, "PLOTINA_APT_KEYRING": str(ro / "keyrings" / "plotina.gpg")}
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(any(l == "apt-get update" for l in self.mock_log_lines()))
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_repo_apt_install_failure_falls_back_to_appimage(self):
        proc = self.run_installer(mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_INSTALL_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(self.repo_install_attempted())
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_repo_apt_total_failure_falls_back_to_appimage(self):
        proc = self.run_installer(mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_ALWAYS_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_scheme_registered_in_repo_path(self):
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.mock_log_lines()
        self.assertTrue(any(l.endswith("set default-url-scheme-handler io.element.desktop "
                                        "plotina-desktop.desktop") for l in lines), lines)
        self.assertTrue(any(l.startswith("update-desktop-database /usr/share/applications")
                            for l in lines), lines)

    def test_no_sudo_falls_back_to_appimage(self):
        mocks = {k: v for k, v in FULL_MOCKS.items() if k != "sudo"}
        proc = self.run_installer(mocks=mocks, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())
        self.assertFalse(any("apt-get install" in l for l in self.mock_log_lines()))

    def test_sudo_denied_noninteractive_falls_back_to_appimage(self):
        proc = self.run_installer(mocks=FULL_MOCKS,
                                  extra_env={**self.env, "SUDO_N_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_not_debian_falls_back_to_appimage(self):
        mocks = {k: v for k, v in FULL_MOCKS.items() if k not in ("apt-get", "dpkg")}
        proc = self.run_installer(mocks=mocks, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    # ----- флаг --deb: только репозиторий -----

    def test_force_deb_flag_installs_from_repo(self):
        proc = self.run_installer(["--deb"], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(self.repo_install_attempted())
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists())

    def test_force_deb_install_failure_dies(self):
        proc = self.run_installer(["--deb"], mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_INSTALL_FAIL": "1"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("выбран --deb", proc.stderr)
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists())

    def test_force_deb_without_env_fails(self):
        proc = self.run_installer(["--deb"], mocks={k: v for k, v in FULL_MOCKS.items()
                                                    if k not in ("apt-get", "dpkg")},
                                  extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("выбран --deb", proc.stderr)
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists())

    def test_force_deb_with_positional_deb_rejected(self):
        proc = self.run_installer(["--deb", str(self.deb)], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--deb означает установку из apt-репозитория", proc.stderr)

    def test_conflicting_flags_fail(self):
        proc = self.run_installer(["--deb", "--appimage"], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)

    def test_appimage_flag_with_deb_arg_fails(self):
        proc = self.run_installer(["--appimage", str(self.deb)], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)

    # ----- устаревшая файловая установка (позиционный .deb / PLOTINA_DEB_URL) -----

    def test_deprecated_deb_file_arg_installs_without_repo(self):
        proc = self.run_installer([str(self.deb)], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = "\n".join(self.mock_log_lines())
        self.assertIn(f"apt-get install -y {self.deb}", lines)
        self.assertNotIn("apt-get update", lines)
        self.assertFalse(self.keyring.exists() or self.list_file.exists(),
                         "файловая установка не подписывает систему на репозиторий")
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists())

    def test_deb_file_apt_failure_falls_back_to_dpkg(self):
        proc = self.run_installer([str(self.deb)], mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_INSTALL_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.mock_log_lines()
        i_apt = next(i for i, l in enumerate(lines) if l.startswith("apt-get install -y"))
        i_dpkg = next(i for i, l in enumerate(lines) if l.startswith("dpkg -i"))
        i_fix = next(i for i, l in enumerate(lines) if l.startswith("apt-get -f install -y"))
        self.assertLess(i_apt, i_dpkg)
        self.assertLess(i_dpkg, i_fix)

    def test_deb_file_total_failure_falls_back_to_appimage(self):
        proc = self.run_installer([str(self.deb)], mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_ALWAYS_FAIL": "1", "DPKG_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-desktop").is_file())

    def test_deprecated_deb_url_env_is_file_override(self):
        env = dict(self.env)
        env["PLOTINA_DEB_URL"] = f"{self.base}/Plotina-Desktop.deb"
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = "\n".join(self.mock_log_lines())
        self.assertIn("apt-get install -y ", lines)
        self.assertIn("Plotina-Desktop.deb", lines)
        self.assertNotIn("apt-get install -y plotina-desktop", lines)
        self.assertFalse(self.keyring.exists() or self.list_file.exists())
        self.assertFalse((self.prefix / "bin" / "plotina-desktop").exists())


class TestRealAppImage(InstallerCase):
    """Прогон против настоящего релизного AppImage (кэш-фикстура)."""

    def setUp(self):
        super().setUp()
        app = real_appimage()
        if app is None:
            self.skipTest("реальный AppImage недоступен (нет сети) — см. докстринг")
        self.appimage = app
        self.xdg_mocks = {"xdg-settings": MOCK_XDG_SETTINGS,
                          "update-desktop-database": MOCK_UPDATE_DESKTOP_DB}

    def test_real_appimage_installs_icons_and_fields(self):
        proc = self.run_installer([str(self.appimage)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        icons = list((self.prefix / "share" / "icons" / "hicolor").glob("*/apps/plotina-desktop.png"))
        self.assertTrue(icons, f"иконки не установлены: {proc.stderr}")
        desktop = (self.prefix / "share" / "applications" / "plotina-desktop.desktop").read_text()
        for field in ("Exec=", "Icon=plotina-desktop", "Name=", "Comment=",
                      "x-scheme-handler/io.element.desktop"):
            self.assertIn(field, desktop)
        self.assert_sso_footer(proc)

    def test_real_appimage_idempotent(self):
        first = self.run_installer([str(self.appimage)], mocks=self.xdg_mocks)
        second = self.run_installer([str(self.appimage)], mocks=self.xdg_mocks)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assert_sso_footer(second)


if __name__ == "__main__":
    unittest.main()
