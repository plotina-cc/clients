#!/usr/bin/env python3
"""Tests for element-desktop/build/installer.nsh — the Windows uninstall hook.

Зачем этот файл. Приложение при каждом старте пишет протокольные ассоциации
само (apps/desktop/src/protocol.ts -> app.setAsDefaultProtocolClient()), то есть
ключи появляются в HKCU\\Software\\Classes\\{element,io.element.desktop,
cc.plotina.element} независимо от установщика. NSIS-uninstaller
electron-builder'а снимает только то, что зарегистрировал сам, поэтому после
удаления ключи оставались и указывали в уже удалённый Plotina-Desktop.exe
(Windows QA, проверка `uninstall:registry`: FAIL).

Статические тесты держат то, что нельзя проверить без Windows-сборки:
  * файл вообще подключён к сборке — и в локальном scripts/build.sh, и в CI
    (electron-builder берёт его по умолчанию как build/installer.nsh; ключ
    nsis.include в build.plotina.json не работает — electron-builder.ts
    собирает конфиг по белому списку полей варианта);
  * список схем совпадает с "protocols" в build.plotina.json;
  * единственный DeleteRegKey стоит ПОД проверкой shell\\open\\command на
    $INSTDIR — иначе uninstall чужой копии ломал бы живую ассоциацию;
  * в uninstall-секции нет вызовов installer-функций: `Call` только на `un.*`
    (первая версия хука падала на ${StrContains} из electron-builder с
    «Call must be used with function names starting with "un."»).

Функциональный тест (нужны makensis и wine; иначе skip) собирает драйвер,
который пишет ровно те ключи, что пишет Chromium, запускает uninstall и
читает реестр обратно: ключи, ведущие в $INSTDIR, должны исчезнуть, а чужие
(другая установка, ключ без command) — остаться.

    cd element-desktop && python3 -m unittest discover -s tests -v
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
REPO = DESKTOP.parent
NSH = DESKTOP / "build" / "installer.nsh"
VARIANT = DESKTOP / "build.plotina.json"
BUILD_SH = DESKTOP / "scripts" / "build.sh"
WORKFLOW = REPO / ".github" / "workflows" / "build-element-desktop.yml"

MAKENSIS = shutil.which("makensis")
WINE = shutil.which("wine")


def read(path):
    return path.read_text(encoding="utf-8")


def custom_uninstall_block(text):
    """Тело макроса customUnInstall — только он попадает в uninstall-секцию."""
    assert "!macro customUnInstall" in text, "customUnInstall macro is missing"
    body = text.split("!macro customUnInstall", 1)[1]
    return body.split("\n!macroend", 1)[0]


class InstallerNshContract(unittest.TestCase):
    def setUp(self):
        self.assertTrue(NSH.is_file(), f"{NSH} is missing")
        self.text = read(NSH)

    def test_defines_custom_uninstall_hook(self):
        # electron-builder's uninstaller.nsh inserts this macro if it exists.
        self.assertIn("!macro customUnInstall", self.text)
        self.assertIn("!macroend", self.text)

    def test_covers_every_scheme_declared_in_the_variant(self):
        schemes = json.loads(read(VARIANT))["protocols"]
        self.assertTrue(schemes, "build.plotina.json declares no protocols")
        block = custom_uninstall_block(self.text)
        for scheme in schemes:
            with self.subTest(scheme=scheme):
                self.assertIn(f'Push "{scheme}"', block)

    def test_delete_is_guarded_by_the_install_dir_check(self):
        # Exactly one DeleteRegKey, and it lives inside the branch taken only
        # when shell\open\command contains $INSTDIR. An app reinstalled into a
        # different directory must keep its live association.
        self.assertEqual(self.text.count("DeleteRegKey"), 1, "expected exactly one DeleteRegKey")
        self.assertIn('${If} $2 != ""', self.text)
        guarded = self.text.split('${If} $2 != ""', 1)[1].split("${Else}", 1)[0]
        self.assertIn("DeleteRegKey", guarded)
        self.assertIn('"Software\\Classes\\$PlotinaScheme"', guarded)
        self.assertNotIn("DeleteRegKey", self.text.replace(guarded, ""))

    def test_match_is_case_insensitive(self):
        # Chromium writes the exe path with the casing the process was started
        # with; a case-sensitive compare would silently keep the key.
        self.assertIn("CharLower", self.text)
        lowered = self.text.count("CharLower")
        self.assertGreaterEqual(lowered, 2, "both the install dir and the command must be lowered")

    def test_uninstaller_only_calls_un_functions(self):
        # NSIS rejects `Call Foo` inside an uninstall section when Foo is an
        # installer function, which is why StrContains.nsh (installer-only) is
        # not used here.
        calls = [
            line.strip().split()[1]
            for line in self.text.splitlines()
            if line.strip().startswith("Call ")
        ]
        self.assertTrue(calls, "expected the hook to call its un.* helpers")
        for target in calls:
            with self.subTest(target=target):
                self.assertTrue(target.startswith("un."), f"installer-context call: {target}")
        self.assertNotIn("${StrContains}", self.text)

    def test_reads_the_runtime_command_value(self):
        # The runtime association is a default value of shell\open\command;
        # anything else would compare against the wrong thing.
        self.assertIn(
            'ReadRegStr $PlotinaCommand HKCU "Software\\Classes\\$PlotinaScheme\\shell\\open\\command" ""',
            self.text,
        )


class InstallerNshWiring(unittest.TestCase):
    def test_local_build_copies_the_include(self):
        # electron-builder resolves the default include from the app's build
        # resources dir, which build.sh has to populate.
        self.assertIn('cp "$ROOT/build/installer.nsh" build/installer.nsh', read(BUILD_SH))

    def test_ci_copies_the_include(self):
        self.assertIn(
            "element-desktop/build/installer.nsh\" \"$SRC/apps/desktop/build/installer.nsh",
            read(WORKFLOW),
        )

    def test_variant_does_not_pretend_to_configure_nsis(self):
        # electron-builder.ts builds its config from a whitelist of variant
        # fields; an "nsis" block there would be dead config that reads as if
        # the hook were wired through it.
        variant = json.loads(read(VARIANT))
        self.assertNotIn("nsis", variant)


DRIVER = r"""
; Generated by element-desktop/tests/test_installer_nsh.py
Unicode true
Name "PlotinaNshProbe"
OutFile "probe-installer.exe"
InstallDir "{install_dir}"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!include "LogicLib.nsh"
!include "installer.nsh"

Section "install"
  ; what Chromium writes for the schemes in build.plotina.json
  WriteRegStr HKCU "Software\Classes\element" "" "URL:element protocol"
  WriteRegStr HKCU "Software\Classes\element\URL Protocol" "" ""
  WriteRegStr HKCU "Software\Classes\element\shell\open\command" "" '"$INSTDIR\Plotina-Desktop.exe" "%1"'
  ; different capitalisation on purpose: the guard must be case-insensitive
  WriteRegStr HKCU "Software\Classes\io.element.desktop" "" "URL:io.element.desktop protocol"
  WriteRegStr HKCU "Software\Classes\io.element.desktop\shell\open\command" "" '"c:\plotina-desktop\plotina-desktop.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\cc.plotina.element" "" "URL:cc.plotina.element protocol"
  WriteRegStr HKCU "Software\Classes\cc.plotina.element\shell\open\command" "" '"$INSTDIR\Plotina-Desktop.exe" -- "%1"'
  ; a live association of another installation: must survive
  WriteRegStr HKCU "Software\Classes\outside\shell\open\command" "" '"C:\Other\Plotina-Desktop.exe" "%1"'
  ; no command at all: nothing to compare, leave it untouched
  WriteRegStr HKCU "Software\Classes\nocommand" "" "URL:nocommand protocol"

  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninst.exe"
SectionEnd

Section "Uninstall"
  !insertmacro customUnInstall
  Delete "$INSTDIR\uninst.exe"
  RMDir "$INSTDIR"
SectionEnd
"""


def wine_env(prefix):
    env = dict(os.environ)
    env.update(
        WINEPREFIX=str(prefix),
        WINEARCH="win64",
        WINEDEBUG="-all",
        WINEDLLOVERRIDES="mscoree,mshtml=",
    )
    return env


def wine(env, *args, timeout=120):
    return subprocess.run(
        [WINE, *args], env=env, capture_output=True, text=True, timeout=timeout
    )


def registry_has_key(env, scheme):
    proc = wine(env, "reg", "query", rf"HKCU\Software\Classes\{scheme}")
    return proc.returncode == 0


@unittest.skipUnless(MAKENSIS, "makensis is not installed")
@unittest.skipUnless(WINE, "wine is not installed")
class InstallerNshBehaviour(unittest.TestCase):
    """Real install/uninstall of a driver that uses the hook, under wine."""

    def test_uninstall_removes_only_the_keys_of_this_install(self):
        with tempfile.TemporaryDirectory(prefix="plotina-nsh-") as tmp:
            tmp = Path(tmp)
            (tmp / "installer.nsh").write_text(read(NSH), encoding="utf-8")
            script = tmp / "probe.nsi"
            script.write_text(
                "!addincludedir \"%s\"\n" % tmp.as_posix()
                + DRIVER.replace("{install_dir}", r"C:\Plotina-NshProbe"),
                encoding="utf-8",
            )
            build = subprocess.run(
                [MAKENSIS, "-V2", str(script)],
                cwd=tmp, capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(build.returncode, 0, build.stdout + build.stderr)

            env = wine_env(tmp / "prefix")
            wine(env, "wineboot", "-i", timeout=300)
            install = wine(env, str(tmp / "probe-installer.exe"), "/S", timeout=300)
            self.assertEqual(install.returncode, 0, install.stderr)

            # Capability probe: a wine that cannot run the PE leaves no keys at
            # all, and then there is nothing to assert about.
            if not registry_has_key(env, "element"):
                self.skipTest("wine cannot run the probe installer on this host")

            installed = str(tmp / "prefix" / "drive_c" / "Plotina-NshProbe")
            self.assertTrue(Path(installed).is_dir(), "the probe installer did not install")

            uninstaller = Path(installed) / "uninst.exe"
            self.assertTrue(uninstaller.is_file(), "the probe installer wrote no uninstaller")
            wine(env, r"C:\Plotina-NshProbe\uninst.exe", "/S", timeout=300)

            # The silent uninstaller relaunches itself from %TEMP%; wait for
            # the install directory to go away before reading the registry.
            deadline = time.time() + 60
            while Path(installed).is_dir() and time.time() < deadline:
                time.sleep(1)

            for scheme in ("element", "io.element.desktop", "cc.plotina.element"):
                with self.subTest(scheme=scheme):
                    self.assertFalse(
                        registry_has_key(env, scheme),
                        f"{scheme} still points into the removed install",
                    )
            self.assertTrue(
                registry_has_key(env, r"outside\shell\open\command"),
                "the association of another install was deleted",
            )
            self.assertTrue(
                registry_has_key(env, "nocommand"),
                "a scheme key without a command was deleted",
            )


if __name__ == "__main__":
    unittest.main()
