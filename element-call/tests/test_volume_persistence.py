"""Tests for patches/0004-plotina-persistent-volume.patch (persistent volume).

Two things are checked, independently of a browser or a build:

* ``PatchTests`` reads the patch itself and asserts the shape we rely on: the
  store is a new file, both remote media ViewModels wire it in, the store has
  no runtime imports, and upstream's ``VolumeControls`` is left untouched so a
  participant nobody has adjusted still plays at 1.0.
* ``StoreLogicTests`` runs the store straight out of the patch under node
  (``tests/volume_store_probe.mjs``): merging two devices' maps, the 500-entry
  limit, damaged JSON, "no account data", and the restart case. No node_modules
  are needed — that is why the store has no runtime imports.
* ``PatchAppliesToPinnedTagTests`` applies every patch, in filename order, to
  the upstream source of the tag pinned in ``pins.env``, the way
  ``build.py --mode source`` does before it builds. It downloads ~6 MB on a cold
  cache; ``EC_SKIP_NETWORK=1`` skips it while the archive is not cached.

Run: python3 -m unittest discover -s element-call/tests
"""

from __future__ import annotations

import os
import re
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
PATCH = EC / "patches" / "0004-plotina-persistent-volume.patch"
STORE = "src/state/PersistentVolume.ts"
USER_MEDIA = "src/state/media/RemoteUserMediaViewModel.ts"
SCREEN_SHARE = "src/state/media/RemoteScreenShareViewModel.ts"

SOURCE_CACHE = Path(tempfile.gettempdir()) / "ec-source-cache"
NODE = shutil.which("node")

DIFF_RE = re.compile(r"^diff --git a/(\S+) b/(\S+)$", re.MULTILINE)


def pins() -> dict[str, str]:
    """The KEY=VALUE lines of pins.env, without sourcing it through bash."""
    out: dict[str, str] = {}
    for line in (EC / "pins.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            out[key.strip()] = value.strip()
    return out


def sections() -> dict[str, str]:
    """The patch split per file, keyed by the b/ path."""
    text = PATCH.read_text(encoding="utf-8")
    matches = list(DIFF_RE.finditer(text))
    out: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        out[match.group(2)] = text[match.start() : end]
    return out


def added_file(path: str) -> str:
    """The contents of a file the patch adds, rebuilt from its + lines."""
    lines = [
        line[1:]
        for line in sections()[path].splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]
    return "\n".join(lines) + "\n"


class PatchTests(unittest.TestCase):
    def test_patch_adds_the_store(self) -> None:
        section = sections()[STORE]
        self.assertIn("new file mode", section)
        self.assertIn("export class PersistentVolumeStore", section)
        self.assertIn("export function rememberParticipantVolume", section)

    def test_patch_touches_only_what_it_says(self) -> None:
        self.assertEqual(
            {
                STORE,
                "src/state/PersistentVolume.test.ts",
                USER_MEDIA,
                SCREEN_SHARE,
            },
            set(sections()),
        )

    def test_user_media_remembers_by_mxid(self) -> None:
        self.assertIn(
            "+  rememberParticipantVolume(scope, inputs.userId, volumeControls);",
            sections()[USER_MEDIA],
        )

    def test_screen_share_remembers_by_mxid_and_source(self) -> None:
        self.assertIn(
            "+    screenShareVolumeKey(inputs.userId),",
            sections()[SCREEN_SHARE],
        )

    def test_account_data_shape_is_the_one_we_documented(self) -> None:
        source = added_file(STORE)
        self.assertIn('"cc.plotina.voice_volumes"', source)
        self.assertIn('"plotina_voice_volumes_v1"', source)
        self.assertIn('"#screenshare"', source)

    def test_store_has_no_runtime_imports(self) -> None:
        # This is what lets tests/volume_store_probe.mjs import the file under
        # plain node with no node_modules, so it is a rule, not a coincidence.
        lines = added_file(STORE).splitlines()
        runtime_imports = [
            line
            for line in lines
            if line.startswith("import ") and not line.startswith("import type ")
        ]
        self.assertEqual([], runtime_imports)
        # Only the type-only ones are left, and those are erased.
        self.assertIn('import type { Observable } from "rxjs";', lines)

    def test_upstream_volume_controls_are_untouched(self) -> None:
        # Nobody adjusted must still play at 1.0 with upstream's own semantics;
        # the patch restores values through adjust/commit/toggle instead.
        self.assertNotIn("src/state/VolumeControls.ts", sections())
        self.assertIn(
            "  controls.adjustPlaybackVolume(saved.volume);", added_file(STORE)
        )
        self.assertIn("controls.togglePlaybackMuted();", added_file(STORE))


@unittest.skipUnless(NODE, "node is not installed")
class StoreLogicTests(unittest.TestCase):
    """Runs the store the patch adds, under node, with no browser."""

    expected = (
        "an unadjusted participant has no saved volume",
        "a saved volume survives a restart",
        "muting keeps the level to unmute to",
        "volumes outside 0..1 are clamped",
        "junk volumes are rejected",
        "keys that are not Matrix user ids are not stored",
        "the screen share key is the mxid plus the source",
        "a participant's mic and screen share are remembered separately",
        "a newer value from another device wins",
        "an older value from another device does not overwrite",
        "keys only one device knows about are merged in, not dropped",
        "the other device's value reaches a running call",
        "switching accounts drops the previous account's volumes",
        "what one device saves is there on the other device's next start",
        "at most 500 entries are kept, oldest evicted",
        "corrupt cached JSON is a cold start, not a crash",
        "junk in account data is ignored and the good entries survive",
        "the cache works when the server has no account data",
        "a failed account data write does not lose the cached value",
        "account data is written once the slider settles",
        "the debounce is 500 ms",
        "an unchanged value is not written again",
        "without an account nothing is remembered",
        "a restored volume is applied the way a user would set it",
        "nothing is applied when the participant was never adjusted",
    )

    results: dict[str, str] = {}
    stdout = ""
    stderr = ""
    returncode = -1

    @classmethod
    def setUpClass(cls) -> None:
        assert NODE is not None  # guaranteed by the skipUnless above
        cls.results = {}
        with tempfile.TemporaryDirectory(prefix="ec-volume-") as tmp:
            root = Path(tmp)
            (root / "PersistentVolume.ts").write_text(
                added_file(STORE), encoding="utf-8"
            )
            shutil.copy(HERE / "volume_store_probe.mjs", root)
            # `node <file>` rather than `--test`: the probe has its own runner so
            # that the output is one line per case on every node 22+.
            completed = subprocess.run(
                [NODE, "volume_store_probe.mjs"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=180,
            )
        cls.stdout = completed.stdout
        cls.stderr = completed.stderr
        cls.returncode = completed.returncode
        for line in completed.stdout.splitlines():
            if line.startswith("PASS "):
                cls.results[line[len("PASS ") :]] = "PASS"
            elif line.startswith("FAIL "):
                name, _, reason = line[len("FAIL ") :].partition(": ")
                cls.results[name] = f"FAIL: {reason}"

    def test_probe_is_green(self) -> None:
        self.assertEqual(
            0,
            self.returncode,
            "the store probe failed:\n" + self.stdout + self.stderr,
        )

    def test_probe_covers_the_rules_we_promise(self) -> None:
        missing = [name for name in self.expected if name not in self.results]
        self.assertEqual([], missing, self.stdout)
        failed = {
            name: result
            for name, result in self.results.items()
            if result != "PASS"
        }
        self.assertEqual({}, failed)

    def test_limit_is_the_documented_one(self) -> None:
        source = added_file(STORE)
        self.assertIn("export const MAX_ENTRIES = 500;", source)
        self.assertIn("export const WRITE_DEBOUNCE_MS = 500;", source)


def source_archive() -> Path:
    """The upstream source tarball for the pinned tag, cached under /tmp."""
    conf = pins()
    tag = conf["EC_TAG"]
    owner_repo = conf["EC_REPO"].rstrip("/").split("github.com/", 1)[1]
    target = SOURCE_CACHE / f"{tag}.tar.gz"
    if target.is_file() and target.stat().st_size > 0:
        return target
    if os.environ.get("EC_SKIP_NETWORK") == "1":
        raise unittest.SkipTest(f"EC_SKIP_NETWORK=1 and {target} is not cached")
    SOURCE_CACHE.mkdir(parents=True, exist_ok=True)
    url = f"https://codeload.github.com/{owner_repo}/tar.gz/refs/tags/{tag}"
    # Ask as curl does: GitHub's CDN is not obliged to answer a bare urllib UA.
    request = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            target.write_bytes(response.read())
    except urllib.error.HTTPError as exc:
        raise AssertionError(
            f"{url} answered {exc.code} — check EC_REPO/EC_TAG in pins.env"
        ) from exc
    return target


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class PatchAppliesToPinnedTagTests(unittest.TestCase):
    """The patches apply to the upstream source, in filename order."""

    def test_every_patch_applies_to_the_pinned_tag_in_order(self) -> None:
        archive = source_archive()
        with tempfile.TemporaryDirectory(prefix="ec-source-") as tmp:
            with tarfile.open(archive) as tar:
                tar.extractall(tmp, filter="data")
            roots = sorted(path for path in Path(tmp).iterdir() if path.is_dir())
            self.assertEqual(1, len(roots), roots)
            root = roots[0]
            patches = sorted((EC / "patches").glob("*.patch"))
            self.assertIn(PATCH.name, [patch.name for patch in patches])
            for patch in patches:
                check = subprocess.run(
                    ["git", "apply", "--check", str(patch)],
                    cwd=root,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    0, check.returncode, f"{patch.name}: {check.stderr}"
                )
                applied = subprocess.run(
                    ["git", "apply", str(patch)],
                    cwd=root,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    0, applied.returncode, f"{patch.name}: {applied.stderr}"
                )
            # …and the store 0004 promised is still there. Later patches in the
            # series extend the same file (0005 adds the stream-visibility
            # entries), so this is a containment check rather than equality.
            applied_store = (root / STORE).read_text(encoding="utf-8")
            for marker in (
                'export const LOCAL_STORAGE_KEY = "plotina_voice_volumes_v1";',
                'export const ACCOUNT_DATA_TYPE = "cc.plotina.voice_volumes";',
                "export class PersistentVolumeStore",
                "export function rememberParticipantVolume",
            ):
                self.assertIn(marker, applied_store)


if __name__ == "__main__":
    unittest.main()