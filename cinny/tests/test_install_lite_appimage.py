#!/usr/bin/env python3
"""Tests for scripts/install-lite-appimage.sh — universal Linux installer for Plotina Lite Desktop.

Покрывает оба пути установщика (по образцу element-desktop/tests/test_install_appimage.py):
  * AppImage в ${PREFIX:-$HOME/.local}: аргумент-путь / аргумент-URL /
    PLOTINA_LITE_APPIMAGE_URL, идемпотентность, содержимое .desktop, иконки из
    --appimage-extract (скип при падающем extract), скачивание с двумя
    попытками, update-desktop-database (есть-ok / падает-ok / отсутствует-ok);
  * .deb: выбор auto при наличии apt-get/dpkg/sudo, fallback dpkg -i +
    apt-get -f install, откат на AppImage без sudo / не-Debian / отказ,
    флаги --deb/--appimage, PLOTINA_LITE_DEB_URL. Реальный apt не вызывается —
    все системные команды это мок в PATH; тестируется разбор аргументов и
    выбор пути, а не работа пакетного менеджера.

Отличие от Element-варианта: Lite Desktop (Cinny/Tauri) НЕ использует схему
io.element.desktop и SSO-колбэк в браузере, поэтому установка СХЕМУ НЕ
РЕГИСТРИРУЕТ — отдельный тест проверяет, что xdg-settings не вызывается даже
когда доступен в PATH.

Реальный AppImage скачивается один раз в фикстуру (кэш
/tmp/plotina-lite-appimage-fixture, переопределяется PLOTINA_LITE_TEST_APPIMAGE /
PLOTINA_LITE_TEST_FIXTURE_DIR); если сети нет — эти тесты пропускаются, а
остальные идут на синтетическом файле (его --appimage-extract падает — это
ровно тот путь «иконки пропущены, установка не сломана»).

    cd cinny && python3 -m unittest discover -s tests -p 'test_install_*' -v
"""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "install-lite-appimage.sh"

# Stable mirror names: /srv/dl is refreshed by pull-release.py, so the script
# must not pin a release tag.
DEFAULT_DEB_URL = "https://plotina.cc/dl/Plotina-Lite-Desktop.deb"
DEFAULT_APPIMAGE_URL = "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage"

FIXTURE_DIR = Path(os.environ.get(
    "PLOTINA_LITE_TEST_FIXTURE_DIR", "/tmp/plotina-lite-appimage-fixture"))

DONE_LINE = "Plotina Lite Desktop установлен"

# ---------------------------------------------------------------- fixtures --
_REAL_APPIMAGE: "Path | None" = None


def real_appimage() -> "Path | None":
    """Кэшированная фикстура настоящего Lite AppImage; None если недоступна."""
    global _REAL_APPIMAGE
    if _REAL_APPIMAGE is not None:
        return _REAL_APPIMAGE
    override = os.environ.get("PLOTINA_LITE_TEST_APPIMAGE")
    if override and Path(override).is_file():
        _REAL_APPIMAGE = Path(override)
        return _REAL_APPIMAGE
    cached = FIXTURE_DIR / "Plotina-Lite-Desktop.AppImage"
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
    if r is not None and r.returncode == 0 and Path(str(cached) + ".part").is_file():
        os.chmod(str(cached) + ".part", 0o755)
        shutil.move(str(cached) + ".part", str(cached))
        _REAL_APPIMAGE = cached
    else:
        Path(str(cached) + ".part").unlink(missing_ok=True)
    return _REAL_APPIMAGE


def make_fake_appimage(directory: Path) -> Path:
    """AppImage-подобный фейк: --appimage-extract на нём падает."""
    p = directory / "Plotina-Lite-Desktop.AppImage"
    p.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--appimage-extract" ]; then echo "AppImage runtime: cannot unpack" >&2; exit 1; fi\n'
        "echo 'fake appimage' >&2; exit 1\n"
    )
    p.chmod(0o755)
    return p


def make_fake_deb(directory: Path) -> Path:
    p = directory / "Plotina-Lite-Desktop.deb"
    p.write_bytes(b"!<arch>\nfake lite deb for installer tests\n")
    return p


# ------------------------------------------------------------- mock tools --
MOCK_SUDO = """#!/bin/sh
if [ "$1" = "-n" ]; then
    echo "sudo -n true" >> "$MOCK_LOG"
    [ "${SUDO_N_FAIL:-0}" = 1 ] && exit 1
    exit 0
fi
if [ "$1" = "-v" ]; then echo "sudo -v" >> "$MOCK_LOG"; exit "${SUDO_V_FAIL:-1}"; fi
echo "sudo $*" >> "$MOCK_LOG"
exec "$@"
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
exit 0
"""
MOCK_UPDATE_DESKTOP_DB = """#!/bin/sh
echo "update-desktop-database $*" >> "$MOCK_LOG"
[ "${UDB_FAIL:-0}" = 1 ] && exit 5
exit 0
"""

CORE_TOOLS = ["bash", "sh", "cat", "curl", "id", "install", "mkdir", "mktemp", "rm", "dirname"]


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

    def assert_done_footer(self, proc):
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        self.assertTrue(lines, "пустой stdout")
        self.assertIn("Plotina Lite Desktop", lines[-1])
        self.assertIn("установлен", lines[-1])

    def assert_no_scheme_registration(self):
        for line in self.mock_log_lines():
            self.assertNotIn("default-url-scheme-handler", line,
                             "Lite-установщик не должен регистрировать URL-схемы")


class TestScriptContract(InstallerCase):
    """Пункты ТЗ: константы, strict mode, self-contained запуск, НЕТ SSO-схемы."""

    def test_strict_mode_and_optional_arg(self):
        text = SCRIPT.read_text()
        self.assertIn("set -euo pipefail", text)
        self.assertNotIn("${1:?", text, "аргумент не обязателен (curl | bash)")

    def test_release_url_constants(self):
        text = SCRIPT.read_text()
        self.assertIn(f'DEFAULT_DEB_URL="{DEFAULT_DEB_URL}"', text)
        self.assertIn(f'DEFAULT_APPIMAGE_URL="{DEFAULT_APPIMAGE_URL}"', text)
        self.assertIn("curl -fsSL https://plotina.cc/dl/Plotina-Lite-Desktop-install.sh | bash",
                      text)

    def test_env_overrides_supported(self):
        text = SCRIPT.read_text()
        self.assertIn("PLOTINA_LITE_DEB_URL", text)
        self.assertIn("PLOTINA_LITE_APPIMAGE_URL", text)

    def test_no_sso_scheme_registration_anywhere(self):
        # Отличие от Element-варианта: схему не регистрируем вообще.
        text = SCRIPT.read_text()
        self.assertNotIn("io.element.desktop", text)
        self.assertNotIn("default-url-scheme-handler", text)
        self.assertNotIn("x-scheme-handler", text)


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
        binp = self.prefix / "bin" / "plotina-lite"
        self.assertTrue(binp.is_file() and os.access(binp, os.X_OK))
        desktop = (self.prefix / "share" / "applications" / "plotina-lite.desktop").read_text()
        self.assertIn(f'Exec="{binp}"', desktop)
        self.assertIn("Icon=plotina-lite", desktop)
        self.assertIn("Name=Plotina Lite Desktop", desktop)
        self.assertIn("Comment=", desktop)
        self.assertNotIn("MimeType", desktop, "Lite не регистрирует SSO-схему в .desktop")
        self.assertIn("update-desktop-database", "\n".join(self.mock_log_lines()))
        self.assert_done_footer(proc)

    def test_default_prefix_uses_home(self):
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks, unset=("PREFIX",))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.home / ".local" / "bin" / "plotina-lite").is_file())

    def test_idempotent_second_run(self):
        first = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        second = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        self.assert_done_footer(second)

    def test_env_url_override_downloads_without_args(self):
        url = self.serve(self.tmp) + "/Plotina-Lite-Desktop.AppImage"
        proc = self.run_installer(mocks=self.xdg_mocks,
                                  extra_env={"PLOTINA_LITE_APPIMAGE_URL": url})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Установлен бинарник", proc.stdout)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        self.assert_done_footer(proc)

    def test_url_argument_downloads(self):
        url = self.serve(self.tmp) + "/Plotina-Lite-Desktop.AppImage"
        proc = self.run_installer([url], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())

    def test_missing_path_arg_fails(self):
        proc = self.run_installer(["/nonexistent/Plotina-Lite-Desktop.AppImage"],
                                  mocks=self.xdg_mocks)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("файл не найден", proc.stderr)

    def test_download_failure_warns_two_attempts_and_fails(self):
        proc = self.run_installer(
            mocks=self.xdg_mocks,
            extra_env={"PLOTINA_LITE_APPIMAGE_URL": "http://127.0.0.1:1/Plotina-Lite-Desktop.AppImage"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("попытка 1/2", proc.stderr)
        self.assertIn("попытка 2/2", proc.stderr)
        self.assertIn("не удалось скачать", proc.stderr)

    def test_fake_appimage_extract_failure_skips_icons_but_installs(self):
        # --appimage-extract на фейке падает — установка не должна роняться.
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("не удалось извлечь иконки", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        self.assertTrue((self.prefix / "share" / "applications" / "plotina-lite.desktop").is_file())
        self.assertFalse((self.prefix / "share" / "icons").exists())

    def test_xdg_settings_present_but_never_called(self):
        # Ключевое отличие от Element: даже когда xdg-settings доступен,
        # Lite-установщик не трогает URL-схемы.
        proc = self.run_installer([str(self.fake)], mocks=self.xdg_mocks)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_no_scheme_registration()
        for line in self.mock_log_lines():
            self.assertNotIn("xdg-settings", line)
        self.assertNotIn("Схема", proc.stdout)

    def test_update_desktop_database_failing_does_not_kill_install(self):
        mocks = {"xdg-settings": MOCK_XDG_SETTINGS,
                 "update-desktop-database": MOCK_UPDATE_DESKTOP_DB,
                 "sudo": "exit 1\n", "apt-get": "exit 1\n", "dpkg": "exit 1\n"}
        proc = self.run_installer([str(self.fake)], mocks=mocks,
                                  extra_env={"UDB_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("update-desktop-database завершился с кодом 5", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())

    def test_xdg_tools_missing_does_not_kill_install(self):
        proc = self.run_installer([str(self.fake)])  # PATH=core: нет xdg-утилит
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("update-desktop-database не найден", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())

    def test_force_appimage_flag_ignores_deb_env(self):
        proc = self.run_installer(["--appimage", str(self.fake)], mocks=FULL_MOCKS)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        for line in self.mock_log_lines():
            self.assertNotIn("apt-get", line)


@unittest.skipIf(os.geteuid() == 0, "нужен non-root, чтобы мок-sudo имел значение")
class TestDebPath(InstallerCase):
    """deb-путь: только разбор аргументов и выбор пути на моках apt/dpkg/sudo."""

    def setUp(self):
        super().setUp()
        self.deb = make_fake_deb(self.tmp)
        self.fake = make_fake_appimage(self.tmp)
        base = self.serve(self.tmp)
        self.env = {
            "PLOTINA_LITE_DEB_URL": f"{base}/Plotina-Lite-Desktop.deb",
            "PLOTINA_LITE_APPIMAGE_URL": f"{base}/Plotina-Lite-Desktop.AppImage",
        }

    def test_auto_installs_deb_when_apt_and_sudo_available(self):
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.mock_log_lines()
        self.assertTrue(any(l.startswith("sudo apt-get install -y ") and l.endswith("Plotina-Lite-Desktop.deb")
                             for l in lines), lines)
        self.assertFalse((self.prefix / "bin" / "plotina-lite").exists(),
                         "deb-путь не должен катать AppImage")
        self.assert_done_footer(proc)

    def test_missing_desktop_in_deb_is_warn_not_fail(self):
        # Мок apt ничего не кладёт в /usr/share/applications — проверочный
        # шаг должен предупредить, но не сломать установку.
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(".desktop", proc.stderr)

    def test_apt_dep_failure_falls_back_to_dpkg(self):
        proc = self.run_installer(mocks=FULL_MOCKS,
                                  extra_env={**self.env, "APT_INSTALL_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = self.mock_log_lines()
        i_apt = next(i for i, l in enumerate(lines) if l.startswith("apt-get install -y"))
        i_dpkg = next(i for i, l in enumerate(lines) if l.startswith("dpkg -i"))
        i_fix = next(i for i, l in enumerate(lines) if l.startswith("apt-get -f install -y"))
        self.assertLess(i_apt, i_dpkg)
        self.assertLess(i_dpkg, i_fix)
        self.assertIn("dpkg -i", proc.stderr)

    def test_deb_install_total_failure_falls_back_to_appimage(self):
        proc = self.run_installer(
            mocks=FULL_MOCKS,
            extra_env={**self.env, "APT_ALWAYS_FAIL": "1", "DPKG_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("перехожу на AppImage", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        self.assert_done_footer(proc)

    def test_no_sudo_falls_back_to_appimage_with_warning(self):
        mocks = {k: v for k, v in FULL_MOCKS.items() if k != "sudo"}
        proc = self.run_installer(mocks=mocks, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("не ставлю .deb", proc.stderr)
        self.assertIn("sudo", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())
        self.assertFalse(any("apt-get install" in l for l in self.mock_log_lines()))

    def test_sudo_denied_noninteractive_falls_back_to_appimage(self):
        proc = self.run_installer(mocks=FULL_MOCKS,
                                  extra_env={**self.env, "SUDO_N_FAIL": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("не ставлю .deb", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())

    def test_not_debian_falls_back_to_appimage(self):
        mocks = {k: v for k, v in FULL_MOCKS.items() if k not in ("apt-get", "dpkg")}
        proc = self.run_installer(mocks=mocks, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("apt-get/dpkg не найдены", proc.stderr)
        self.assertTrue((self.prefix / "bin" / "plotina-lite").is_file())

    def test_force_deb_without_env_fails(self):
        proc = self.run_installer(["--deb"], mocks={k: v for k, v in FULL_MOCKS.items()
                                                    if k not in ("apt-get", "dpkg")},
                                  extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("выбран --deb", proc.stderr)
        self.assertFalse((self.prefix / "bin" / "plotina-lite").exists())

    def test_deb_path_arg_used_as_is(self):
        proc = self.run_installer(["--deb", str(self.deb)], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"sudo apt-get install -y {self.deb}", self.mock_log_lines())
        self.assertNotIn(f"Скачиваю: {self.env['PLOTINA_LITE_DEB_URL']}", proc.stdout)

    def test_dotdeb_argument_routes_to_deb_in_auto_mode(self):
        proc = self.run_installer([str(self.deb)], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"sudo apt-get install -y {self.deb}", self.mock_log_lines())

    def test_conflicting_flags_fail(self):
        proc = self.run_installer(["--deb", "--appimage"], mocks=FULL_MOCKS, extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)

    def test_appimage_flag_with_deb_arg_fails(self):
        proc = self.run_installer(["--appimage", str(self.deb)], mocks=FULL_MOCKS,
                                  extra_env=self.env)
        self.assertNotEqual(proc.returncode, 0)

    def test_deb_path_never_registers_scheme(self):
        proc = self.run_installer(mocks=FULL_MOCKS, extra_env=self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assert_no_scheme_registration()


class TestRealAppImage(InstallerCase):
    """Прогон против настоящего релизного Lite AppImage (кэш-фикстура)."""

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
        icons = list((self.prefix / "share" / "icons" / "hicolor").glob("*/apps/plotina-lite.png"))
        self.assertTrue(icons, f"иконки не установлены: {proc.stderr}")
        desktop = (self.prefix / "share" / "applications" / "plotina-lite.desktop").read_text()
        for field in ("Exec=", "Icon=plotina-lite", "Name=", "Comment="):
            self.assertIn(field, desktop)
        self.assertNotIn("x-scheme-handler", desktop)
        self.assert_done_footer(proc)

    def test_real_appimage_idempotent(self):
        first = self.run_installer([str(self.appimage)], mocks=self.xdg_mocks)
        second = self.run_installer([str(self.appimage)], mocks=self.xdg_mocks)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assert_done_footer(second)


if __name__ == "__main__":
    unittest.main()
