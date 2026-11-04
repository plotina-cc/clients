"""Integration test: brand the real pinned upstream tarball, not a fixture.

Downloads the release tarball named by ``element-call/pins.env``, checks it
against the sha256 pinned there, unpacks it under /tmp, then runs
``inject-noise.py`` and ``branding.py`` over it in the order build.sh does and
asserts the branded result.

~40 MB of download on a cold cache. Set ``EC_TARBALL`` to a local tarball, or
``EC_SKIP_NETWORK=1`` to skip this module entirely.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
EC = HERE.parent
REPO = EC.parent
sys.path.insert(0, str(EC))
sys.path.insert(0, str(HERE))

import branding  # noqa: E402
import fixtures  # noqa: E402

ICONS = REPO / "branding" / "icons"
CACHE = Path(tempfile.gettempdir()) / "ec-branding-integration"


def pins() -> dict[str, str]:
    """The KEY=VALUE lines of pins.env, without sourcing it through bash."""
    out: dict[str, str] = {}
    for line in (EC / "pins.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def fetch(url: str, expected_sha: str) -> Path:
    """The tarball, verified — a cached copy is only trusted if it hashes."""
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / "upstream.tar.gz"
    if target.is_file() and _sha(target) == expected_sha:
        return target
    if os.environ.get("EC_SKIP_NETWORK") == "1":
        raise unittest.SkipTest("EC_SKIP_NETWORK=1 and the tarball is not cached")
    # Ask as curl does: GitHub's CDN is not obliged to answer a bare urllib UA.
    request = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            target.write_bytes(response.read())
    except urllib.error.HTTPError as exc:
        # A moved or renamed release asset is a broken pin, not a network
        # hiccup: fail the run instead of skipping it.
        raise AssertionError(
            f"{url} answered {exc.code} — check EC_REPO/EC_TAG in pins.env"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise unittest.SkipTest(f"cannot fetch {url}: {exc}")
    if _sha(target) != expected_sha:
        target.unlink(missing_ok=True)
        raise AssertionError(
            f"{url} is { _sha(target)} but pins.env says {expected_sha} — "
            "the release asset changed, do not brand it"
        )
    return target


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *argv], capture_output=True, text=True, cwd=REPO, check=False
    )


class TarballBrandingTest(unittest.TestCase):
    """The whole point: the pinned build is what the rule table was written for."""

    @classmethod
    def setUpClass(cls) -> None:
        env = pins()
        cls.tag = env["EC_TAG"]
        cls.sha = env["EC_TARBALL_SHA256"]
        version = cls.tag.lstrip("v")
        url = os.environ.get("EC_TARBALL") or (
            f"{env['EC_REPO'].rstrip('/')}/releases/download/{cls.tag}"
            f"/element-call-{version}.tar.gz"
        )
        if url.startswith("file://"):
            tarball = Path(url.removeprefix("file://"))
        elif url.startswith("/"):
            tarball = Path(url)
        else:
            tarball = fetch(url, cls.sha)
        if _sha(tarball) != cls.sha:
            raise AssertionError(f"{tarball} does not match the sha pinned in pins.env")

        CACHE.mkdir(parents=True, exist_ok=True)
        cls.work = Path(tempfile.mkdtemp(prefix="ec-branding-run-", dir=CACHE))
        with tarfile.open(tarball) as archive:
            archive.extractall(cls.work)
        extracted = cls.work / f"element-call-{cls.tag.lstrip('v')}"
        assert extracted.is_dir(), f"unexpected tarball layout under {cls.work}"
        # A pristine copy: the branding tests rewrite cls.dist in place, and a
        # test must never depend on another one having run first.
        cls.pristine = cls.work / "pristine"
        shutil.copytree(extracted, cls.pristine)
        cls.dist = extracted
        # build.sh patches the noise wrapper in before branding; do the same
        # here so no test depends on another one's order.
        noise = run(str(EC / "inject-noise.py"), str(cls.dist / "index.html"))
        assert noise.returncode == 0, noise.stderr

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "work"):
            shutil.rmtree(cls.work, ignore_errors=True)

    def test_tarball_is_the_pinned_upstream_release(self) -> None:
        self.assertTrue((self.pristine / "index.html").is_file())
        self.assertTrue((self.pristine / "favicon.png").is_file())
        self.assertTrue(list((self.pristine / "assets").glob("index-*.js")))
        # Still upstream's: this is what the rule table was written against.
        html = (self.pristine / "index.html").read_text(encoding="utf-8")
        self.assertIn("<title>Element Call</title>", html)
        self.assertEqual(html.count("Element Call"), 5)
        self.assertNotIn("Plotina", html)

    def test_branding_the_release_bundle(self) -> None:
        """branding.py right after inject-noise.py, the order build.sh runs."""
        first = run(str(EC / "branding.py"), str(self.dist))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        for sub in branding.JS_SUBS + branding.HTML_SUBS:
            self.assertIn(f"{sub.name}={sub.expected}", first.stdout, sub.name)

        check = run(str(EC / "branding.py"), "--check", str(self.dist))
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)

        # Re-running must be a no-op that reports the same counters.
        html = (self.dist / "index.html").read_bytes()
        again = run(str(EC / "branding.py"), str(self.dist))
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual((self.dist / "index.html").read_bytes(), html)
        self.assertEqual(again.stdout.splitlines()[0], first.stdout.splitlines()[0])

    def test_index_html_shell(self) -> None:
        run(str(EC / "branding.py"), str(self.dist))
        html = (self.dist / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("Element Call", html)
        self.assertIn("<title>Plotina Call</title>", html)
        self.assertIn('<meta property="og:title" content="Plotina Call">', html)
        self.assertIn('<meta name="twitter:title" content="Plotina Call">', html)
        self.assertEqual(html.count("You're invited to join a call on Plotina Call"), 2)
        self.assertIn('<meta property="og:image" content="/plotina-512.png">', html)
        self.assertIn('<meta name="twitter:image" content="/plotina-512.png">', html)
        self.assertIn('<link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">', html)
        # The noise wrapper still precedes the module script (build.sh asserts it).
        self.assertLess(html.find('/noise/logic.js'), html.find('type="module"'))

    def test_bundle_literals(self) -> None:
        run(str(EC / "branding.py"), str(self.dist))
        js = (self.dist / "assets" / "index-FUQuguOr.js").read_text(encoding="utf-8")
        self.assertIn("let t=`Plotina Call`;document.title=", js)
        self.assertIn("{productName:`Plotina Call`,version:`v0.26.1`}", js)
        self.assertEqual(js.count("`Failed to ask the host to close Plotina Call`"), 2)
        self.assertEqual(js.count("brand:`Plotina Call`"), 2)
        self.assertIn("F.info(`Plotina Call v0.26.1`)", js)
        self.assertNotIn("Element Call (Beta)", js)
        self.assertNotIn("element.io/privacy", js)
        self.assertNotIn("element.io/cookie-policy", js)
        self.assertNotIn("docs.element.io", js)
        self.assertIn("href:`https://plotina.cc`", js)
        self.assertIn("`https://github.com/plotina-cc/clients`", js)
        # Exactly one occurrence keeps upstream's name: the logo's aria-label.
        self.assertEqual(js.count("Element Call"), branding.KNOWN_LEFTOVERS)
        self.assertIn("Element Call", js)

    def test_icon_files(self) -> None:
        run(str(EC / "branding.py"), str(self.dist))
        self.assertEqual(
            (self.dist / "favicon.png").read_bytes(), (ICONS / "png" / "green-48.png").read_bytes()
        )
        self.assertEqual(
            (self.dist / "plotina-512.png").read_bytes(),
            (ICONS / "png" / "green-512.png").read_bytes(),
        )
        self.assertEqual(
            (self.dist / "plotina-icon.svg").read_bytes(),
            (ICONS / "plotina-green.svg").read_bytes(),
        )

    def test_scope_boundaries_are_respected(self) -> None:
        """Locales and source maps stay upstream's; the table does not reach them."""
        run(str(EC / "branding.py"), str(self.dist))
        en = next(iter((self.dist / "assets").glob("en-app-*.json")))
        self.assertIn("Element Call", en.read_text(encoding="utf-8"))
        maps = sorted((self.dist / "assets").glob("*.map"))
        self.assertTrue(maps, "the release tarball ships no source maps? layout changed")
        for path in maps:
            self.assertNotIn("Plotina Call", path.read_text(encoding="utf-8", errors="replace"))

    def test_check_detects_a_reverted_literal(self) -> None:
        fresh = self.work / "reverted"
        shutil.copytree(self.dist, fresh)
        run(str(EC / "branding.py"), str(fresh))
        # Put one literal back: --check has to name the rule that broke.
        js = fresh / "assets" / "index-FUQuguOr.js"
        js.write_text(
            js.read_text(encoding="utf-8").replace(
                "let t=`Plotina Call`;document.title=",
                "let t=`Element Call`;document.title=",
                1,
            ),
            encoding="utf-8",
        )
        bad = run(str(EC / "branding.py"), "--check", str(fresh))
        self.assertEqual(bad.returncode, 1)
        self.assertIn("document_title", bad.stderr)
        self.assertTrue(any("still matches" in line for line in bad.stderr.splitlines()), bad.stderr)
        # And applying branding over it repairs the literal instead of aborting.
        fixed = run(str(EC / "branding.py"), str(fresh))
        self.assertEqual(fixed.returncode, 0, fixed.stdout + fixed.stderr)


if __name__ == "__main__":
    unittest.main()
