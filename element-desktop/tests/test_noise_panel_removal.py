#!/usr/bin/env python3
"""The floating noise panel is gone from every Desktop path (EC .17).

Element Call .17 moved the suppression level into its own Settings -> Audio row
and deleted ``noise/plotina-panel.js``. Desktop is assembled in three places and
each of them still expected the panel, so the release build died in the webapp
job on a ``cp`` of a file that no longer exists::

    cp: cannot stat '.../noise/plotina-panel.js': No such file or directory

Two things are asserted here, both of which were red before the fix:

* the layer ``prepare-webapp.sh`` copies (and then asserts with ``test -s``) is
  exactly what the repo's ``noise/`` directory holds -- a deleted file has to
  fail here, in a unit test, not 40 s into a CI job;
* the widget the shell ships must not load the panel it can no longer serve, and
  the assembler must reject a widget that still references it (negative
  control: the same check has to fail on a document that carries the tag).

    cd element-desktop && python3 -m unittest discover -s tests -p 'test_noise_panel*.py'

stdlib only; no new dependencies.
"""
from __future__ import annotations

import importlib.util
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
REPO = DESKTOP.parent
PREPARE = DESKTOP / "scripts" / "prepare-webapp.sh"
NOISE = REPO / "noise"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader, f"missing {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ecw = _load("element_call_widget", DESKTOP / "scripts" / "element-call-widget.py")
apply_noise = _load("apply_noise", DESKTOP / "apply-noise.py")

# `cp "$REPO_ROOT/noise/logic.js" "$REPO_ROOT/noise/boot.js" ... "$NOISE/"` spans
# lines with trailing backslashes; the source side is always $REPO_ROOT/<path>.
COPY_SOURCE = re.compile(r"\$REPO_ROOT/(noise/[A-Za-z0-9_.\-/]+)")
# `test -s "$DEST/noise/<name>"` asserts the assembled copy is non-empty.
ASSEMBLED_DEST = re.compile(r'test -s "\$DEST/(noise/[A-Za-z0-9_.\-/]+)"')


class PrepareWebappNoiseTest(unittest.TestCase):
    """The assembly script must not copy or assert a file noise/ does not have."""

    def setUp(self) -> None:
        self.script = PREPARE.read_text(encoding="utf-8")

    def test_every_copied_noise_file_exists_in_the_repo(self) -> None:
        raw = set(COPY_SOURCE.findall(self.script))
        # `cp -a "$REPO_ROOT/noise/vendor/." "$NOISE/"` names a directory by its
        # trailing "/.", so that one entry is checked as a directory.
        dirs = {p.rstrip("/").removesuffix("/.") for p in raw if p.endswith("/.")}
        files = {p for p in raw if not p.endswith("/.")}
        self.assertTrue(files, "prepare-webapp.sh copies no noise file at all?")
        missing = [p for p in sorted(files) if not (REPO / p).is_file()]
        missing += [p for p in sorted(dirs) if not (REPO / p).is_dir()]
        self.assertEqual(
            missing, [],
            f"prepare-webapp.sh copies paths that do not exist in the repo: {missing}",
        )

    def test_every_asserted_noise_file_exists_in_the_repo(self) -> None:
        asserted = sorted(set(ASSEMBLED_DEST.findall(self.script)))
        self.assertTrue(asserted, "prepare-webapp.sh asserts no assembled noise file?")
        missing = [p for p in asserted if not (NOISE / Path(p).name).is_file()]
        self.assertEqual(
            missing, [],
            f"prepare-webapp.sh asserts files noise/ does not hold: {missing}",
        )


class WidgetPanelTest(unittest.TestCase):
    """The shipped widget document must not reference the removed panel."""

    def setUp(self) -> None:
        sys.path.insert(0, str(HERE))
        from test_element_call_widget import make_archive, make_webapp

        self.make_archive, self.make_webapp = make_archive, make_webapp

    def test_the_installed_widget_does_not_load_the_panel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = self.make_webapp(root)
            ecw.install_widget(self.make_archive(root), webapp)
            html = (webapp / ecw.MOUNT / "index.html").read_text(encoding="utf-8")
            self.assertNotIn("plotina-panel", html)
            self.assertIn('src="../../noise/plotina-dfn.js"', html)

    def test_the_assembler_rejects_a_widget_that_loads_the_panel(self) -> None:
        """Negative control: the check must be able to fail.

        Everything else about this widget passes (it is the fixture the rest of
        the suite installs), so the panel tag has to be the only reason.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            webapp = self.make_webapp(root)
            ecw.install_widget(self.make_archive(root), webapp)
            widget = webapp / ecw.MOUNT
            index = widget / "index.html"
            dfn = '<script src="../../noise/plotina-dfn.js"></script>'
            index.write_text(
                index.read_text(encoding="utf-8").replace(
                    dfn, dfn + '<script src="../../noise/plotina-panel.js"></script>', 1
                ),
                encoding="utf-8",
            )
            failures = ecw.check_widget(widget)
            self.assertTrue(
                any("plotina-panel" in f for f in failures),
                f"check_widget accepted a widget loading the panel: {failures}",
            )
            self.assertEqual(
                len(failures), 1, f"the panel tag is the only fault, got {failures}"
            )


class ApplyNoisePanelTest(unittest.TestCase):
    """apply-noise.py must refuse a widget document that still loads the panel."""

    def test_patch_widget_rejects_the_panel_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            widget = Path(tmp) / "index.html"
            widget.write_text(
                "<html><head><script>window.__plotinaEc=true;</script>"
                + "".join(apply_noise.WIDGET_TAGS)
                + '<script src="../../noise/plotina-panel.js"></script>'
                + "</head><body></body></html>",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit) as ctx:
                apply_noise.patch_widget(widget)
            self.assertNotEqual(ctx.exception.code, 0)

    def test_no_widget_tag_points_at_the_panel(self) -> None:
        for tag in apply_noise.WIDGET_TAGS:
            self.assertNotIn("plotina-panel", tag)
        for tag in ecw.WIDGET_NOISE_TAGS:
            self.assertNotIn("plotina-panel", tag)


if __name__ == "__main__":
    unittest.main()
