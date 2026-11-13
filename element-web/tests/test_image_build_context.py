"""The Web image's build context must be complete before docker builds it.

A COPY source that left the tree, or a ``test -s`` on a file nothing COPYied, is
invisible to every other test and to review: it fails inside ``docker build``
with "failed to calculate checksum … not found", which is how Element Call .17
(``noise/plotina-panel.js`` deleted with the floating noise capsule) broke the
Web image on 2026-11-13.  ``element-web/scripts/check-build-context.py`` is the
checker; these tests run it on the real Dockerfile and, with fixtures, prove it
still rejects the two ways the context can go incomplete.
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent
REPO = WEBAPP.parent
CHECKER = WEBAPP / "scripts" / "check-build-context.py"
DOCKERFILE = WEBAPP / "Dockerfile"
WIDGET_CORE = WEBAPP / "scripts" / "element-call-widget-core.py"
WORKFLOW = REPO / ".github" / "workflows" / "build-element-web.yml"


def checker_module():
    spec = importlib.util.spec_from_file_location("check_build_context", CHECKER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CHECKER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RealDockerfileTest(unittest.TestCase):
    """The tree as it is: nothing to fix, nothing missing."""

    def setUp(self) -> None:
        self.checker = checker_module()
        self.text = DOCKERFILE.read_text(encoding="utf-8")

    def test_every_copy_source_exists_in_the_build_context(self) -> None:
        self.assertEqual(
            self.checker.missing_sources(self.text, WEBAPP, REPO),
            [],
            "docker build fails on these with 'failed to calculate checksum'",
        )

    def test_existence_assertions_agree_with_copy(self) -> None:
        self.assertEqual(self.checker.assertion_problems(self.text), [])

    def test_widget_noise_tags_name_files_the_overlay_carries(self) -> None:
        self.assertEqual(self.checker.widget_noise_problems(WIDGET_CORE, REPO), [])

    def test_the_checker_passes_on_the_committed_tree(self) -> None:
        self.assertEqual(self.checker.main(["--web-dir", str(WEBAPP), "--repo-root", str(REPO)]), 0)

    def test_ci_stages_the_trees_the_checker_reads(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('cp -a element-web/. "$context"/', workflow)
        self.assertIn('cp -a noise "$context/noise"', workflow)


class CheckerRejectsIncompleteContextTest(unittest.TestCase):
    """Negative controls: a gate that cannot fail is decoration."""

    def setUp(self) -> None:
        self.checker = checker_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.web = self.root / "element-web"
        (self.web / "scripts").mkdir(parents=True)
        (self.root / "noise").mkdir()
        (self.root / "noise" / "present.js").write_text("// present\n", encoding="utf-8")
        (self.web / "present.txt").write_text("present\n", encoding="utf-8")
        (self.web / "scripts" / "element-call-widget-core.py").write_text(
            'TAGS = (\'<script src="../../noise/present.js"></script>\',)\n', encoding="utf-8")

    def check(self, dockerfile_text: str) -> int:
        dockerfile = self.web / "Dockerfile"
        dockerfile.write_text(dockerfile_text, encoding="utf-8")
        return self.checker.main(["--web-dir", str(self.web), "--repo-root", str(self.root),
                                  "--widget-core", str(self.web / "scripts" / "element-call-widget-core.py")])

    def test_accepts_a_complete_context(self) -> None:
        self.assertEqual(self.check("COPY present.txt /app/present.txt\n"
                                    "COPY noise/present.js /app/noise/present.js\n"
                                    "RUN test -s /app/noise/present.js\n"), 0)

    def test_rejects_a_copy_source_that_left_the_tree(self) -> None:
        self.assertEqual(self.check("COPY present.txt /app/present.txt\n"
                                    "COPY noise/plotina-panel.js /app/noise/plotina-panel.js\n"), 1)

    def test_rejects_an_existence_assertion_nothing_copies(self) -> None:
        self.assertEqual(self.check("COPY present.txt /app/present.txt\n"
                                    "RUN test -s /app/noise/plotina-dfn.js\n"), 1)

    def test_rejects_an_absence_assertion_a_copy_contradicts(self) -> None:
        self.assertEqual(self.check("COPY noise/present.js /app/noise/present.js\n"
                                    "RUN ! test -e /app/noise/present.js\n"), 1)

    def test_rejects_a_widget_noise_tag_the_overlay_cannot_satisfy(self) -> None:
        (self.web / "scripts" / "element-call-widget-core.py").write_text(
            'TAGS = (\'<script src="../../noise/plotina-panel.js"></script>\',)\n', encoding="utf-8")
        self.assertEqual(self.check("COPY present.txt /app/present.txt\n"), 1)

    def test_rejects_a_copy_shape_it_does_not_model(self) -> None:
        with self.assertRaises(ValueError):
            self.checker.copy_sources("COPY --from=builder /x /y\n")


if __name__ == "__main__":
    unittest.main()
