"""inject-noise.py against the shapes of index.html that exist in the wild.

Three of them matter:

* a pristine upstream index.html — the ordinary case, and the one that must not
  grow a floating level panel any more;
* a bundle that still carries the panel from the releases before the setting
  moved into Settings → Audio: patching it has to take the tag out;
* a bundle that was patched by a newer build and advertises `/noise/plotina-panel.js`
  that the bundle does not ship (the panel file is gone from noise/), which
  `--check` must refuse.
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

EC = Path(__file__).resolve().parent.parent
SCRIPT = EC / "inject-noise.py"

PANEL_TAG = '<script src="/noise/plotina-panel.js"></script>'

FRESH = (
    "<!doctype html><html><head>"
    "<script>window.global = window;</script>"
    '<script type="module" crossorigin src="/assets/index-AAAA.js"></script>'
    "</head><body><div id=\"root\"></div></body></html>"
)


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True
    )


class InjectNoiseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.index = Path(self.td.name) / "index.html"

    def write(self, html: str) -> Path:
        self.index.write_text(html, encoding="utf-8")
        return self.index

    def read(self) -> str:
        return self.index.read_text(encoding="utf-8")

    def test_fresh_injection_carries_no_level_panel(self) -> None:
        self.write(FRESH)
        result = run(str(self.index))
        self.assertEqual(result.returncode, 0, result.stderr)

        html = self.read()
        for tag in ("logic.js", "plotina-dfn.js", "boot.js", "source-link.js"):
            self.assertIn(f'src="/noise/{tag}"', html)
        self.assertNotIn("plotina-panel", html)
        self.assertNotIn("plotina-noise-panel", html)
        # The wrapper still has to run before the bundle that calls it.
        self.assertLess(html.find("/noise/logic.js"), html.find('type="module"'))

    def test_check_accepts_a_freshly_patched_bundle(self) -> None:
        self.write(FRESH)
        self.assertEqual(run(str(self.index)).returncode, 0)
        check = run("--check", str(self.index))
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_upgrade_strips_the_panel_from_an_older_bundle(self) -> None:
        self.write(
            FRESH.replace(
                "<head>",
                "<head>"
                "<script>window.__plotinaEc=true;</script>"
                '<script src="/noise/logic.js"></script>'
                '<script src="/noise/plotina-dfn.js"></script>'
                '<script src="/noise/boot.js"></script>'
                + PANEL_TAG,
            )
        )
        result = run(str(self.index))
        self.assertEqual(result.returncode, 0, result.stderr)

        html = self.read()
        self.assertNotIn("plotina-panel", html)
        # Everything the old bundle already had stays, exactly once.
        for tag in ("logic.js", "plotina-dfn.js", "boot.js"):
            self.assertEqual(html.count(f'src="/noise/{tag}"'), 1, tag)

    def test_check_rejects_a_bundle_that_still_advertises_the_panel(self) -> None:
        self.write(FRESH)
        self.assertEqual(run(str(self.index)).returncode, 0)
        self.write(self.read().replace("</head>", PANEL_TAG + "</head>"))

        check = run("--check", str(self.index))
        self.assertNotEqual(check.returncode, 0)
        self.assertIn("panel", (check.stderr + check.stdout).lower())


if __name__ == "__main__":
    unittest.main()
