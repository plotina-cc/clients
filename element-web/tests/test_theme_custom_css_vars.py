#!/usr/bin/env python3
"""No custom property may be used in the custom-theme sheets without a definition.

Why this exists
---------------
``theme-{light,dark}-custom.css`` are *generated* by the upstream element-web
build from ``apps/web/res/themes/light-custom/css/_custom.pcss``. They are not
in git, so every upstream bump silently regenerates them — and the upstream
generated sheets use a set of legacy, pre-Compound custom properties that no
stylesheet in the shipped webapp defines:

    --primary-color            --roomlist-background-color
    --sidebar-color            --roomlist-highlights-color
    --timeline-text-color      --roomlist-separator-color
    ... (19 names, see SHIPPED_LEGACY_VARS)

A browser substitutes the *empty* value for an undefined custom property with
no fallback, so ``color:var(--primary-color)`` computes to invalid at
computed-value time and inherits something else: washed-out text, missing
shadows, collapsed spacing. Only ``--timeline-text-color`` is already covered
in our overlay (webapp_fixes.patch_theme_css adds a
``var(--cpd-color-text-primary)`` fallback); the rest are fixed in
``webapp_fixes``/``branding`` too, which is why this test polices the *final*
CSS rather than the source.

The check is deliberately general: it compares *every* bare ``var(--x)`` use in
the custom sheets against *every* ``--x:`` definition in the webapp's CSS. A new
undefined variable introduced by a future upstream (or by our own overlay)
fails here without anyone having to add it to a list. ``SHIPPED_LEGACY_VARS``
is used only as explicit test cases in the fixture-based tests below — never as
an allowlist, and never consulted by the artifact check.

Where the artifact comes from
-----------------------------
The generated tree only exists inside a built webapp (docker image / desktop
build), so the artifact test skips — loudly, naming what it looked for and how
to point it at a tree — when none is present. In CI, after the image is built,
set ``PLOTINA_WEBAPP_ROOT`` to the extracted ``/app`` (path-separator list is
accepted) and ``PLOTINA_THEME_CSS_STRICT=1`` to turn "no artifact" into a
failure instead of a skip.

Reproduce by hand::

    # unit + fixture tests only (what element-web/tests/run.sh runs)
    python3 -m unittest discover -s element-web/tests -p '*test*.py'

    # against a real generated tree; prints a table, exits 1 on findings
    python3 element-web/tests/test_theme_custom_css_vars.py --root /path/to/app

Counts behind SHIPPED_LEGACY_VARS: 19 distinct names, each used bare in *both*
generated sheets (19 x 2 = the "38 undefined properties" from the original
report), measured against element-web v1.12.32 bundle
81bff4fd060173d686ec / 7fef2be0ae8530458db3.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent                 # element-web/
REPO = WEBAPP.parent                 # repository root
FIXTURES = HERE / "fixtures" / "theme-css"

# The legacy properties the upstream generated sheets use without defining them
# (v1.12.32). Explicit fixture cases, NOT an allowlist: the artifact check below
# does not import this list.
SHIPPED_LEGACY_VARS = (
    "--accent-color-1000",
    "--accent-color-300",
    "--accent-color-400",
    "--bgColor-danger-muted",
    "--borderColor-accent-emphasis",
    "--borderColor-muted",
    "--fgColor-danger",
    "--primary-color",
    "--roomlist-background-color",
    "--roomlist-highlights-color",
    "--roomlist-separator-color",
    "--secondary-hairline-color",
    "--sidebar-color",
    "--sidebar-color-50pct",
    "--timeline-background-color-50pct",
    "--timeline-highlights-color",
    "--timeline-text-color",
    "--timeline-text-color-50pct",
    "--timeline-text-secondary-color",
)

# Both sheets are generated from the same source; each carries every name.
CUSTOM_SHEET_NAMES = ("theme-light-custom.css", "theme-dark-custom.css")

_ROOT_ENV = "PLOTINA_WEBAPP_ROOT"
_STRICT_ENV = "PLOTINA_THEME_CSS_STRICT"
# Bundle hash of the fixture trees (the shipped v1.12.32 bundle).
FIXTURE_BUNDLE = "7fef2be0ae8530458db3"

# Searched when PLOTINA_WEBAPP_ROOT is unset. A built webapp is not in git; a
# developer who has one of these laying around gets the real check for free.
DEFAULT_ROOTS = (
    "/app",                                                     # inside the image
    REPO / "element-desktop" / ".build" / "webapp",             # desktop release
    REPO / "element-desktop" / ".build" / "element-web" / "apps" / "desktop" / "webapp",
    REPO / "element-desktop" / ".build" / "element-web" / "apps" / "web",
    REPO / "element-web" / "build",
)

_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
# A custom property named at the head of a var() call.
_VAR_HEAD_RE = re.compile(r"\s*(--[A-Za-z0-9_-]+)")
# A declaration of a custom property: `--x:` not preceded by an identifier char.
_DEFINITION_RE = re.compile(r"(?<![\w-])(--[A-Za-z0-9_-]+)\s*:")
_VAR_CALL_RE = re.compile(r"var\(", re.I)


@dataclass(frozen=True)
class VarUse:
    """One ``var(--name)`` occurrence in a sheet."""

    name: str
    has_fallback: bool
    offset: int


@dataclass(frozen=True)
class UndefinedVar:
    """A custom property used without fallback and defined nowhere we looked."""

    name: str
    sheet: Path
    uses: int
    context: str

    def describe(self, root: Path | None = None) -> str:
        where = self.sheet
        if root is not None:
            try:
                where = self.sheet.relative_to(root)
            except ValueError:
                pass
        return f"{self.name} — {self.uses} use(s) in {where} at {self.context}"


def strip_comments(css: str) -> str:
    """Drop /* ... */ so a commented-out use or definition cannot count."""
    return _COMMENT_RE.sub("", css)


def iter_var_uses(css: str) -> list[VarUse]:
    """Every ``var(--name)`` with whether a fallback follows it.

    Nesting is honoured: in ``var(--a, var(--b))`` the outer call has a fallback
    and the inner one does not, and the inner ``--b`` is genuinely bare (if
    ``--a`` is undefined a bare inner var still yields the empty value).
    """
    uses: list[VarUse] = []
    for match in _VAR_CALL_RE.finditer(css):
        start = match.end()
        depth = 1
        pos = start
        has_fallback = False
        while pos < len(css) and depth:
            char = css[pos]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    break
            elif char == "," and depth == 1:
                has_fallback = True
            pos += 1
        head = _VAR_HEAD_RE.match(css[start:pos])
        if head:
            uses.append(VarUse(head.group(1), has_fallback, match.start()))
    return uses


def defined_names(css: str) -> set[str]:
    """Custom properties declared in ``css`` (``--x: value``)."""
    return set(_DEFINITION_RE.findall(css))


def _context(css: str, offset: int, width: int = 70) -> str:
    """``selector › declaration`` around ``offset``.

    The shipped sheets are minified onto one line, so a line number would point
    at the whole file; the selector plus the property being set is what a human
    needs to find the rule.
    """
    rule_start = css.rfind("}", 0, offset) + 1
    brace = css.find("{", rule_start, offset)
    selector = css[rule_start:brace].strip() if brace != -1 else ""
    delim = max(rule_start - 1,
                max(css.rfind(ch, rule_start, offset) for ch in ";{}"))
    declaration = css[delim + 1:offset].strip()
    if len(selector) > width:
        selector = "…" + selector[-width:]
    if len(declaration) > width:
        declaration = declaration[-width:]
    if not selector and not declaration:
        return "file start"
    if selector and declaration:
        return f"{selector} › {declaration}"
    return selector or declaration


def read(path: Path) -> str:
    return strip_comments(path.read_text(encoding="utf-8", errors="replace"))


def collect_defined(root: Path) -> set[str]:
    """Every custom property defined by any stylesheet under ``root``.

    Custom properties cascade across all stylesheets on the page, so a sheet may
    legitimately use a property another sheet defines; only properties defined
    *nowhere* in the tree are broken.
    """
    defined: set[str] = set()
    for sheet in root.rglob("*.css"):
        defined |= defined_names(read(sheet))
    return defined


def find_custom_sheets(root: Path) -> list[Path]:
    """``**/bundles/*/theme-{light,dark}-custom.css``, web and desktop layouts.

    The desktop release unpacks the webapp one level deeper than the image
    (``.build/element-web/apps/desktop/webapp/bundles/...``), so discovery is by
    name anywhere under the root rather than by a fixed path.
    """
    return sorted(p for p in root.rglob("theme-*-custom.css")
                  if p.name in CUSTOM_SHEET_NAMES and p.is_file())


def analyze(root: Path) -> list[UndefinedVar]:
    """Every bare use of a custom property that nothing under ``root`` defines."""
    defined = collect_defined(root)
    findings: list[UndefinedVar] = []
    for sheet in find_custom_sheets(root):
        css = read(sheet)
        counts: dict[str, int] = {}
        first_offset: dict[str, int] = {}
        for use in iter_var_uses(css):
            if use.has_fallback or use.name in defined:
                continue
            counts[use.name] = counts.get(use.name, 0) + 1
            first_offset.setdefault(use.name, use.offset)
        for name in sorted(counts):
            findings.append(UndefinedVar(name, sheet, counts[name],
                                         _context(css, first_offset[name])))
    return findings


def describe_findings(findings: list[UndefinedVar], root: Path | None = None) -> str:
    lines = [f"  {finding.describe(root)}" for finding in findings]
    return "\n".join(lines)


def bundle_dirs_missing_sheets(root: Path) -> list[Path]:
    """Bundle dirs that carry only one of the two custom sheets.

    A half-copied tree would make the scan pass by looking at fewer sheets, so
    the artifact check refuses that shape instead of reporting a clean result.
    """
    by_dir: dict[Path, set[str]] = {}
    for sheet in find_custom_sheets(root):
        by_dir.setdefault(sheet.parent, set()).add(sheet.name)
    return sorted(d for d, names in by_dir.items() if names != set(CUSTOM_SHEET_NAMES))


def discover_roots() -> tuple[list[Path], list[str]]:
    """Return (roots carrying custom sheets, every path that was considered)."""
    override = os.environ.get(_ROOT_ENV, "").strip()
    candidates: list[Path] = (
        [Path(part).expanduser() for part in override.split(os.pathsep) if part.strip()]
        if override else [Path(p) for p in DEFAULT_ROOTS]
    )
    tried: list[str] = []
    found: list[Path] = []
    for candidate in candidates:
        tried.append(str(candidate))
        if candidate.is_dir() and find_custom_sheets(candidate):
            found.append(candidate)
    return found, tried


# --------------------------------------------------------------------------
# Parser semantics: the rules that decide what counts as a finding.
# --------------------------------------------------------------------------
class VarParsingTest(unittest.TestCase):
    def test_bare_use_is_bare(self) -> None:
        uses = iter_var_uses(".a{color:var(--x)}")
        self.assertEqual(uses, [VarUse("--x", False, 9)])

    def test_use_with_fallback_is_not_bare(self) -> None:
        uses = iter_var_uses(".a{color:var(--x,#fff)}")
        self.assertEqual([(u.name, u.has_fallback) for u in uses], [("--x", True)])

    def test_whitespace_and_nested_fallback(self) -> None:
        uses = iter_var_uses(".a{color:var( --outer , var(--inner) )}")
        self.assertEqual([(u.name, u.has_fallback) for u in uses],
                         [("--outer", True), ("--inner", False)])

    def test_function_name_is_case_insensitive(self) -> None:
        self.assertEqual([u.name for u in iter_var_uses(".a{color:VAR(--x)}")], ["--x"])

    def test_definitions_are_recognised(self) -> None:
        self.assertEqual(defined_names(":root{--x:1px;--y: var(--z)}"), {"--x", "--y"})

    def test_use_position_is_not_a_definition(self) -> None:
        # `.a{border:1px solid var(--x)}` must not count as defining --x.
        self.assertEqual(defined_names(".a{border:1px solid var(--x)}"), set())

    def test_commented_out_code_is_ignored(self) -> None:
        css = strip_comments("/* .a{color:var(--x)} :root{--y:1} */ .a{color:var(--z)}")
        self.assertEqual([u.name for u in iter_var_uses(css)], ["--z"])
        self.assertEqual(defined_names(css), set())


# --------------------------------------------------------------------------
# Fixture tests: the shipped legacy set as explicit cases, plus the regression
# shape. These run everywhere — they do not need a built webapp.
# --------------------------------------------------------------------------
class FixtureRegressionTest(unittest.TestCase):
    """``fixtures/theme-css/before`` is a trimmed slice of the *shipped*
    v1.12.32 sheets (real selectors and declarations, one bundle directory with
    bundle.css defining the Compound tokens they resolve against)."""

    BEFORE = FIXTURES / "before"
    AFTER = FIXTURES / "after"

    def test_fixture_shape(self) -> None:
        for root in (self.BEFORE, self.AFTER):
            self.assertEqual(len(find_custom_sheets(root)),
                             len(CUSTOM_SHEET_NAMES),
                             msg=f"{root} must carry both custom sheets")
            self.assertEqual(bundle_dirs_missing_sheets(root), [])

    def test_before_reports_exactly_the_shipped_legacy_vars(self) -> None:
        findings = analyze(self.BEFORE)
        self.assertEqual({f.name for f in findings}, set(SHIPPED_LEGACY_VARS),
                         msg="the fixture must reproduce the shipped defect "
                             "exactly; a drifted list means the test no longer "
                             "describes the real artifact")

    def test_before_reports_each_var_in_both_sheets(self) -> None:
        """19 names x 2 sheets = the 38 undefined properties of the report."""
        findings = analyze(self.BEFORE)
        per_name: dict[str, set[str]] = {}
        for finding in findings:
            per_name.setdefault(finding.name, set()).add(finding.sheet.name)
        self.assertEqual(len(findings), 2 * len(SHIPPED_LEGACY_VARS))
        for name, sheets in per_name.items():
            with self.subTest(var=name):
                self.assertEqual(sheets, set(CUSTOM_SHEET_NAMES))

    def test_every_finding_names_its_file(self) -> None:
        for finding in analyze(self.BEFORE):
            with self.subTest(var=finding.name):
                self.assertIn(finding.sheet.name, CUSTOM_SHEET_NAMES)
                self.assertGreater(finding.uses, 0)
                # The context points at a real rule, not just the property name.
                self.assertIn("›", finding.context)
                self.assertTrue(finding.context.strip())

    def test_after_is_clean(self) -> None:
        self.assertEqual(analyze(self.AFTER), [],
                         msg="the fixed fixture must produce no findings")

    def test_injected_undefined_variable_fails(self) -> None:
        """The regression the task asks for: one new bare name, no definition."""
        with tempfile.TemporaryDirectory(prefix="theme-css-probe-") as tmp:
            probe_root = Path(tmp) / "app"
            shutil.copytree(self.AFTER, probe_root)
            probe = "var(--plotina-regression-probe)"
            sheet = probe_root / "bundles" / FIXTURE_BUNDLE / "theme-dark-custom.css"
            sheet.write_text(sheet.read_text(encoding="utf-8")
                             + f".mx_Probe{{color:{probe}}}\n", encoding="utf-8")

            findings = analyze(probe_root)
            self.assertEqual([f.name for f in findings], ["--plotina-regression-probe"])
            self.assertEqual(findings[0].sheet.name, "theme-dark-custom.css")
            self.assertEqual(findings[0].uses, 1)

    def test_fallback_rescues_an_undefined_name(self) -> None:
        with tempfile.TemporaryDirectory(prefix="theme-css-fallback-") as tmp:
            probe_root = Path(tmp) / "app"
            shutil.copytree(self.BEFORE, probe_root)
            sheet = probe_root / "bundles" / FIXTURE_BUNDLE / "theme-light-custom.css"
            sheet.write_text(
                sheet.read_text(encoding="utf-8").replace(
                    "var(--primary-color)", "var(--primary-color,var(--cpd-color-text-action-accent))"),
                encoding="utf-8")
            names = {(f.name, f.sheet.name) for f in analyze(probe_root)}
            # The fallback silences the name in the patched sheet only; the
            # sibling sheet still carries the bare use and must still be named.
            self.assertNotIn(("--primary-color", "theme-light-custom.css"), names)
            self.assertIn(("--primary-color", "theme-dark-custom.css"), names)
            self.assertIn(("--sidebar-color", "theme-light-custom.css"), names)


# --------------------------------------------------------------------------
# The artifact check. Skipped (loudly) when no generated tree is available.
# --------------------------------------------------------------------------
class GeneratedWebappTest(unittest.TestCase):
    def setUp(self) -> None:
        roots, tried = discover_roots()
        if not roots:
            message = (
                "no generated webapp tree found — nothing to check. Looked for "
                f"theme-light-custom.css / theme-dark-custom.css under:\n    "
                + "\n    ".join(tried)
                + f"\n  Point {_ROOT_ENV} at a built webapp (e.g. the element-web "
                  "image's /app, or element-desktop/.build/webapp). The fixture "
                  "tests above still validate the checker itself."
            )
            if os.environ.get(_STRICT_ENV) == "1":
                self.fail(f"{_STRICT_ENV}=1 but {message}")
            self.skipTest(message)
        self.roots = roots

    def test_every_bundle_has_both_custom_sheets(self) -> None:
        for root in self.roots:
            with self.subTest(root=str(root)):
                self.assertEqual(
                    bundle_dirs_missing_sheets(root), [],
                    msg=f"{root}: a bundle directory carries only one of "
                        f"{CUSTOM_SHEET_NAMES}; the tree is incomplete")

    def test_no_undefined_custom_properties(self) -> None:
        total = 0
        for root in self.roots:
            findings = analyze(root)
            total += len(findings)
            with self.subTest(root=str(root)):
                self.assertEqual(
                    findings, [],
                    msg=(f"{len(findings)} custom property use(s) in the custom "
                         f"theme sheets have no definition anywhere in "
                         f"{root}:\n" + describe_findings(findings, root)
                         + "\n  Define them in the element-web overlay "
                           "(webapp_fixes.py / branding.py) or drop the use."))
        self.assertEqual(total, 0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=
                                     "Report custom properties used in the generated custom-theme "
                                     "sheets but defined nowhere in the webapp CSS.")
    parser.add_argument("--root", action="append", metavar="DIR",
                        help="built webapp root; repeatable. Overrides autodiscovery.")
    args = parser.parse_args(argv)

    if args.root:
        roots = [Path(r) for r in args.root]
    else:
        roots, tried = discover_roots()
        if not roots:
            print("no generated webapp tree; looked for:", file=sys.stderr)
            for path in tried:
                print(f"  {path}", file=sys.stderr)
            return 2

    status = 0
    for root in roots:
        sheets = find_custom_sheets(root)
        findings = analyze(root)
        print(f"{root}: {len(sheets)} custom sheet(s), {len(findings)} undefined use(s)")
        if findings:
            print(describe_findings(findings, root))
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())