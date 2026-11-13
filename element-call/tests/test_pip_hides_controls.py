"""Our own chrome goes away in an Android picture-in-picture window (t_dba1710e).

An Android PiP window is the call's WebView resized down to a floating window a
few hundred px on its longest side. There is no call UI to press in it, yet two
of our controls were painted on top of the shared video and swallowed touches:
the noise capsule (``noise/plotina-panel.js``) and the corner eye that hides a
stream (``patches/0005-plotina-stream-video-toggle.patch``). They also
disagreed — shrinking the window lost the capsule and kept the eye — because
each one decided on its own.

The fix is one rule, keyed on the viewport rather than the platform: below
``PIP_MAX`` on *both* sides, both controls are ``display: none``. This module is
what keeps them together:

* ``RuleTests`` reads the two shipped artifacts and asserts they carry the same
  query, that it hides exactly the two controls, and that nothing else about
  them moved (the capsule keeps its place in a normal call; nothing sniffs a UA
  or a platform).
* ``BrowserTests`` renders both controls from those artifacts in headless
  chromium at the sizes that matter (a phone upright and sideways, a desktop
  window, a 320x180 PiP window, the widest PiP window we expect) and asserts
  what the user sees: both visible and touchable in a call, both gone and the
  stream reachable in PiP. It also proves the check is not decoration: with the
  query mutated so it never fires — or so it fires for only one of the two
  controls, which is the bug this card is about — the same check fails.

The whole thing skips cleanly when no chromium is installed (the CI runners do
not all have one); the rule assertions above still run there.

Run: python3 -m unittest discover -s element-call/tests -p 'test_*.py'
"""

from __future__ import annotations

import contextlib
import functools
import http.server
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EC = HERE.parent
ROOT = EC.parent
PATCH = EC / "patches" / "0005-plotina-stream-video-toggle.patch"
PANEL = ROOT / "noise" / "plotina-panel.js"
HARNESS = HERE / "pip_hides_controls_harness.html"
PROBE = HERE / "pip_hides_controls_probe.html"

TILE_CSS = "src/tile/SpotlightTile.module.css"
TILE_TSX = "src/tile/SpotlightTile.tsx"

# The one number both artifacts are written against: a viewport this small on
# both sides is a PiP window. A phone cannot be this small in a full-screen call
# (portrait is ~360-430 wide and ~600+ tall, landscape is ~360+ tall and ~700+
# wide), and a desktop window is bigger still.
PIP_MAX = 480
PIP_QUERY = f"(max-width: {PIP_MAX}px) and (max-height: {PIP_MAX}px)"

# The class the patch's tile stylesheet hides, and the base rule of the capsule
# this card must leave exactly where it is.
PIP_CLASS = ".pipHidden"
NOISE_BASE = (
    "#plotina-noise-panel{position:fixed;"
    "right:calc(12px + env(safe-area-inset-right,0px));"
    "bottom:calc(140px + env(safe-area-inset-bottom,0px));"
)

CHROME = next(
    (
        found
        for found in (
            shutil.which("chromium"),
            shutil.which("chromium-browser"),
            shutil.which("google-chrome"),
        )
        if found
    ),
    None,
)

# A parallel card removes the floating capsule altogether and moves the level
# into the Audio menu. This card only stops the capsule from being painted over
# a picture-in-picture window, so the capsule half of the rule is checked while
# the file exists and skipped once it is gone — not carried as dead code.
HAS_PANEL = PANEL.is_file()

DIFF_RE = re.compile(r"^diff --git a/(\S+) b/(\S+)$", re.MULTILINE)
CASE_RE = re.compile(
    r"case (?P<name>\S+) (?P<asked>\d+x\d+) viewport=(?P<viewport>\d+x\d+) "
    r"noise=(?P<noise>\S+) eye=(?P<eye>\S+) "
    r"noiseHit=(?P<noise_hit>\S+) eyeHit=(?P<eye_hit>\S+) "
    r"cardOpen=(?P<card_open>\S+)"
)


def sections() -> dict[str, str]:
    """The patch split per file, keyed by the b/ path."""
    text = PATCH.read_text(encoding="utf-8")
    matches = list(DIFF_RE.finditer(text))
    out: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        out[match.group(2)] = text[match.start() : end]
    return out


def added_text(path: str) -> str:
    """What the patch adds to one file, as text."""
    section = sections()[path]
    return "\n".join(
        line[1:]
        for line in section.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    )


def media_blocks(text: str) -> list[tuple[str, str]]:
    """Every ``@media <condition> { ... }`` in CSS *or* in a JS string literal.

    The capsule's stylesheet lives in a JS array of strings, so the same parser
    has to read both. Comments and string quoting are not interpreted: only the
    braces are counted, which is enough for rules this shallow.
    """
    blocks: list[tuple[str, str]] = []
    for match in re.finditer(r"@media\s+", text):
        brace = text.find("{", match.end())
        if brace < 0:
            continue
        condition = normalise_condition(text[match.end() : brace])
        depth = 0
        for index in range(brace, len(text)):
            char = text[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    blocks.append((condition, text[brace + 1 : index]))
                    break
    return blocks


def normalise_condition(condition: str) -> str:
    return re.sub(r"\s+", " ", condition).strip()


def normalise_rule(body: str) -> str:
    """A rule body without comments, whitespace or optional semicolons."""
    without_comments = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    return re.sub(r"\s+", "", without_comments).replace(";}", "}").rstrip(";")


def expect_hidden(width: int, height: int) -> bool:
    """What the rule says for a viewport, independent of what it does."""
    return width <= PIP_MAX and height <= PIP_MAX


class RuleTests(unittest.TestCase):
    """The two artifacts carry one and the same rule."""

    @unittest.skipUnless(HAS_PANEL, "the noise capsule was removed (t_a543a391)")
    def test_the_noise_capsule_is_hidden_by_a_viewport_query(self) -> None:
        blocks = media_blocks(PANEL.read_text(encoding="utf-8"))
        hiding = [(cond, body) for cond, body in blocks if "#plotina-noise-panel" in body]
        self.assertEqual(
            1,
            len(hiding),
            "plotina-panel.js must hide the capsule with exactly one media block",
        )
        condition, body = hiding[0]
        self.assertEqual(PIP_QUERY, condition)
        # The whole host goes, not one of its children: a hidden pill with a
        # visible card under it would still be an overlay on the stream.
        self.assertEqual(
            "#plotina-noise-panel{display:none}", normalise_rule(body)
        )

    def test_the_eye_is_hidden_by_the_same_query(self) -> None:
        css = added_text(TILE_CSS)
        hiding = [
            (cond, body) for cond, body in media_blocks(css) if PIP_CLASS in body
        ]
        self.assertEqual(
            1,
            len(hiding),
            f"the tile stylesheet must hide {PIP_CLASS} with exactly one media block",
        )
        condition, body = hiding[0]
        self.assertEqual(PIP_QUERY, condition)
        self.assertEqual(f"{PIP_CLASS}{{display:none}}", normalise_rule(body))

    @unittest.skipUnless(HAS_PANEL, "the noise capsule was removed (t_a543a391)")
    def test_both_controls_obey_one_rule(self) -> None:
        """The card's point: one rule, so they cannot disagree again."""
        noise = [c for c, b in media_blocks(PANEL.read_text(encoding="utf-8")) if "noise" in b]
        css = [c for c, b in media_blocks(added_text(TILE_CSS)) if PIP_CLASS in b]
        self.assertEqual(noise, css)
        self.assertEqual([PIP_QUERY], noise)

    def test_the_eye_button_carries_the_class(self) -> None:
        tsx = added_text(TILE_TSX)
        start = tsx.index("const ScreenShareVisibilityButton")
        end = tsx.index("\n};", start)
        button = tsx[start:end]
        self.assertIn(
            "className={classNames(styles.expand, styles.pipHidden)}", button
        )
        # The eye only: the volume button next to it keeps working as it did.
        self.assertEqual(1, tsx.count("styles.pipHidden"))

    def test_only_the_two_controls_are_hidden(self) -> None:
        blocks = [b for c, b in media_blocks(added_text(TILE_CSS)) if PIP_CLASS in b]
        self.assertEqual(1, len(blocks))
        rules = [rule for rule in re.split(r"\}", blocks[0]) if rule.strip()]
        self.assertEqual(1, len(rules), rules)
        # Nothing reaching for the whole corner group, which would take the
        # volume and fullscreen buttons with it.
        for selector in (".bottomRightButtons", ".expand {", ".tile {"):
            self.assertNotIn(selector, blocks[0])

    @unittest.skipUnless(HAS_PANEL, "the noise capsule was removed (t_a543a391)")
    def test_the_capsule_keeps_its_place_in_a_full_screen_call(self) -> None:
        """This card hides it in PiP; where it sits in a call is somebody else's."""
        text = PANEL.read_text(encoding="utf-8")
        self.assertEqual(1, text.count(NOISE_BASE), "the capsule base rule moved")
        for rule in ('"#plotina-noise-panel[hidden]{display:none}"',):
            self.assertEqual(1, text.count(rule))

    def test_the_mode_is_not_the_platform(self) -> None:
        """A viewport query, not a UA string and not a JS size check.

        The capsule script does sniff a UA elsewhere — it decides whether an
        Element X WebView gets a panel at all — so only the hiding rule is
        checked here: its condition must be a pair of viewport bounds, and there
        must be no second, scripted way to hide either control.
        """
        sources = [(added_text(TILE_CSS), PIP_CLASS)]
        if HAS_PANEL:
            sources.append((PANEL.read_text(encoding="utf-8"), "#plotina-noise-panel"))
        for text, needle in sources:
            hiding = [(cond, body) for cond, body in media_blocks(text) if needle in body]
            self.assertEqual(1, len(hiding))
            condition, body = hiding[0]
            self.assertRegex(
                condition, r"^\(max-width: \d+px\) and \(max-height: \d+px\)$"
            )
            for sniff in ("userAgent", "navigator", "platform", "Android"):
                self.assertNotIn(sniff, condition + body)
        tile = added_text(TILE_TSX)
        for sniff in ("userAgent", "innerWidth", "matchMedia", "navigator"):
            self.assertNotIn(sniff, tile)

    def test_a_phone_and_a_desktop_window_stay_outside_the_rule(self) -> None:
        for width, height in ((390, 844), (844, 390), (430, 932), (932, 430), (1280, 800)):
            self.assertFalse(expect_hidden(width, height), (width, height))
        for width, height in ((320, 180), (480, 270), (346, 195)):
            self.assertTrue(expect_hidden(width, height), (width, height))


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002,A003
        pass


@contextlib.contextmanager
def serve(directory: Path):
    handler = functools.partial(_Quiet, directory=str(directory))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def build_site(root: Path, css_query: str = PIP_QUERY, panel_query: str = PIP_QUERY) -> Path:
    """A throwaway site: the real artifacts, plus the two probe pages."""
    site = root / "site"
    (site / "room").mkdir(parents=True)
    (site / "noise").mkdir()
    css = added_text(TILE_CSS)
    if css_query != PIP_QUERY:
        css = css.replace(PIP_QUERY, css_query)
    (site / "tile.css").write_text(css, encoding="utf-8")
    if HAS_PANEL:
        panel = PANEL.read_text(encoding="utf-8")
        if panel_query != PIP_QUERY:
            panel = panel.replace(PIP_QUERY, panel_query)
        (site / "noise" / "plotina-panel.js").write_text(panel, encoding="utf-8")
    shutil.copy(PROBE, site / "room" / "index.html")
    shutil.copy(HARNESS, site / "pip_hides_controls_harness.html")
    return site


def run_harness(site: Path, profile: Path) -> str:
    """Renders the harness in headless chromium and returns the dumped DOM."""
    assert CHROME is not None
    with serve(site) as base:
        completed = subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--window-size=1400,1000",
                "--virtual-time-budget=8000",
                f"--user-data-dir={profile}",
                "--dump-dom",
                f"{base}/pip_hides_controls_harness.html",
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
    return completed.stdout


def harness_output(dump: str) -> str:
    """The text the harness published in its <pre>, without the surrounding DOM."""
    marker = 'id="out">'
    start = dump.find(marker)
    if start < 0:
        return ""
    text = dump[start + len(marker) :]
    end = text.find("</pre>")
    return text[:end] if end >= 0 else text


def reports(dump: str) -> dict[str, dict[str, str]]:
    """The per-case facts the harness published, keyed by case name."""
    out: dict[str, dict[str, str]] = {}
    for match in CASE_RE.finditer(harness_output(dump)):
        out[match.group("name")] = match.groupdict()
    return out


def failures(found: dict[str, dict[str, str]], expect_noise: bool = True) -> list[str]:
    """Everything the rendered page does that the rule says it must not.

    This is the check itself, so the same function has to fail for a page with
    no rule at all and for a page where only one of the two controls obeys it.
    """
    problems: list[str] = []
    expected_cases = 5
    if len(found) != expected_cases:
        problems.append(
            f"the harness reported {len(found)} of {expected_cases} windows: "
            + (", ".join(sorted(found)) or "none")
        )
    for name, case in sorted(found.items()):
        width, height = (int(part) for part in case["asked"].split("x"))
        viewport = case["viewport"]
        if viewport != case["asked"]:
            problems.append(f"{name}: measured {viewport} in an iframe of {case['asked']}")
            continue
        hidden = expect_hidden(width, height)
        controls = [("eye", case["eye"], case["eye_hit"])]
        if expect_noise:
            controls.insert(0, ("noise", case["noise"], case["noise_hit"]))
        for control, display, hit in controls:
            if hidden and display != "none":
                problems.append(
                    f"{name}: {control} is still rendered in a {width}x{height} window "
                    f"(display: {display})"
                )
                continue
            if not hidden and display == "none":
                problems.append(
                    f"{name}: {control} disappeared from a {width}x{height} window"
                )
                continue
            # Rendered: a touch there belongs to the control. Hidden: it must
            # reach the stream underneath instead of being swallowed.
            if hidden and hit != "stage":
                problems.append(
                    f"{name}: a touch in the {control} corner hits {hit}, not the stream"
                )
            if not hidden and hit != control:
                problems.append(
                    f"{name}: the {control} control is not reachable at its own corner "
                    f"(touch hits {hit})"
                )
        # "Still there" is not enough for the capsule in a call: it has to keep
        # working, which one click shows (it opens its slider card).
        if expect_noise and not hidden and case["card_open"] != "true":
            problems.append(f"{name}: the capsule does not open its card when clicked")
    return problems


@unittest.skipUnless(CHROME, "no chromium binary to render the controls in")
class BrowserTests(unittest.TestCase):
    """What the user actually sees, at the sizes that matter."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(prefix="ec-pip-")
        cls.root = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def rendered(self, css_query: str = PIP_QUERY, panel_query: str = PIP_QUERY) -> dict:
        run = self.root / f"run{len(list(self.root.iterdir()))}"
        run.mkdir()
        site = build_site(run, css_query=css_query, panel_query=panel_query)
        dump = run_harness(site, run / "profile")
        self.assertIn("case ", dump, "the harness did not report a single window")
        return reports(dump)

    def test_a_call_keeps_both_controls_and_a_pip_window_hides_them(self) -> None:
        found = self.rendered()
        problems = failures(found, expect_noise=HAS_PANEL)
        self.assertEqual([], problems, "\n".join(problems))
        # Spelled out, so a run that silently stops measuring is not a pass.
        for name in ("phone-portrait", "phone-landscape", "desktop-window"):
            self.assertNotEqual("none", found[name]["eye"], name)
            if HAS_PANEL:
                self.assertNotEqual("none", found[name]["noise"], name)
                # A click still opens the capsule's card in a call: it stayed a
                # working control, not just a visible one.
                self.assertEqual("true", found[name]["card_open"], name)
        for name in ("pip-window", "tablet-pip"):
            self.assertEqual("none", found[name]["eye"], name)
            self.assertEqual("stage", found[name]["eye_hit"], name)
            if HAS_PANEL:
                self.assertEqual("none", found[name]["noise"], name)
                self.assertEqual("stage", found[name]["noise_hit"], name)

    @unittest.skipUnless(HAS_PANEL, "the noise capsule was removed (t_a543a391)")
    def test_both_controls_agree_in_every_window(self) -> None:
        """The owner's report: the capsule went, the eye stayed."""
        found = self.rendered()
        for name, case in sorted(found.items()):
            self.assertEqual(
                case["noise"] == "none",
                case["eye"] == "none",
                f"{name}: noise display {case['noise']}, eye display {case['eye']}",
            )

    def test_the_check_rejects_a_rule_that_never_fires(self) -> None:
        """Negative control: no rule anywhere, so the PiP window passes a touch
        to our controls — which is exactly what the harness has to refuse."""
        found = self.rendered(
            css_query="(max-width: 1px) and (max-height: 1px)",
            panel_query="(max-width: 1px) and (max-height: 1px)",
        )
        problems = failures(found, expect_noise=HAS_PANEL)
        self.assertTrue(problems, "a page with no rule at all was accepted")
        self.assertTrue(
            any("pip-window" in problem and "eye" in problem for problem in problems),
            problems,
        )
        if HAS_PANEL:
            self.assertTrue(
                any("pip-window" in problem and "noise" in problem for problem in problems),
                problems,
            )

    def test_the_check_rejects_the_eye_that_forgot_the_rule(self) -> None:
        """Negative control for the exact bug: the capsule obeys the rule, the
        eye does not, and the two controls disagree in a PiP window."""
        found = self.rendered(css_query="(max-width: 1px) and (max-height: 1px)")
        problems = failures(found, expect_noise=HAS_PANEL)
        self.assertTrue(
            any("pip-window" in problem and "eye" in problem for problem in problems),
            problems,
        )
        if HAS_PANEL:
            self.assertFalse(
                any("pip-window" in problem and "noise" in problem for problem in problems),
                problems,
            )


if __name__ == "__main__":
    unittest.main()
