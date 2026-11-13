"""Tests for patches/0005-plotina-stream-video-toggle.patch (hide a stream).

Three things are checked, independently of a browser, an SFU or a build:

* ``PatchTests`` reads the patch itself and asserts the shape we rely on: the
  viewer's choice is a new ``videoVisible$`` on the screen share ViewModel (so
  ``videoEnabled$`` keeps meaning "the publisher is sharing"), the track is
  taken out of the subscription with ``setSubscribed``, and the tile gets a
  menu item next to the existing volume button. It also asserts the things that
  must *not* be there: a global "hide every stream" toggle, or changes to
  upstream's ``VolumeControls``/LiveKit configuration.
* ``StoreLogicTests`` runs the store the whole patch series produces under node
  (``tests/stream_visibility_probe.mjs``): the visibility entries, the
  default of "show", restarts, two devices, and that a visibility entry is
  never read back as a volume. No node_modules are needed.
* ``AppliedSourceTests`` applies every patch, in filename order, to the
  upstream source of the tag pinned in ``pins.env`` — the way
  ``build.py --mode source`` does before it builds — and runs the probe against
  the file that lands there.

Run: python3 -m unittest discover -s element-call/tests
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
EC = HERE.parent
PATCH = EC / "patches" / "0005-plotina-stream-video-toggle.patch"
PROBE = HERE / "stream_visibility_probe.mjs"

STORE = "src/state/PersistentVolume.ts"
SCREEN_SHARE = "src/state/media/RemoteScreenShareViewModel.ts"
SCREEN_SHARE_TEST = "src/state/media/RemoteScreenShareViewModel.test.ts"
TILE = "src/tile/SpotlightTile.tsx"
TILE_TEST = "src/tile/SpotlightTile.test.tsx"
TEST_MOCKS = "src/utils/test.ts"
LOCALE_EN = "locales/en/app.json"
LOCALE_RU = "locales/ru/app.json"

TOUCHED = {
    STORE,
    SCREEN_SHARE,
    SCREEN_SHARE_TEST,
    TILE,
    TILE_TEST,
    TEST_MOCKS,
    LOCALE_EN,
    LOCALE_RU,
}

# Never ours to change: audio controls, the SFU client/options, dependencies.
OFF_LIMITS = (
    "src/state/VolumeControls.ts",
    "src/livekit/",
    "src/state/CallViewModel/",
    "package.json",
    "pnpm-lock.yaml",
)

VISIBILITY_KEYS = ("screen_share_visibility", "show_stream", "stream_hidden")

# The single-item menu this patch used to have; the button replaced it and its
# label has no other reader, so it must not come back.
RETIRED_KEYS = ("hide_stream",)

# How the tile refers to them in the source.
VISIBILITY_REFS = tuple(f"video_tile.{key}" for key in VISIBILITY_KEYS)

SOURCE_CACHE = Path(tempfile.gettempdir()) / "ec-source-cache"
NODE = shutil.which("node")
GIT = shutil.which("git")

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


def added_lines(section: str) -> list[str]:
    return [
        line[1:]
        for line in section.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]


def added_file(path: str) -> str:
    """The contents of a file the patch adds, rebuilt from its + lines."""
    return "\n".join(added_lines(sections()[path])) + "\n"


class PatchTests(unittest.TestCase):
    def test_patch_touches_only_what_it_says(self) -> None:
        self.assertEqual(TOUCHED, set(sections()))

    def test_store_gains_a_visibility_entry(self) -> None:
        section = sections()[STORE]
        added = "\n".join(added_lines(section))
        self.assertIn('STREAM_VIDEO_KEY_SUFFIX = "#screenshare-video"', added)
        self.assertIn("export function streamVideoKey", added)
        self.assertIn("public getStreamVisible", added)
        self.assertIn("public setStreamVisible", added)
        # The 500-entry / 500 ms budget the volume patch promised still holds.
        self.assertNotIn("-export const MAX_ENTRIES", section)
        self.assertNotIn("-export const WRITE_DEBOUNCE_MS", section)

    def test_stream_is_unsubscribed_not_merely_hidden(self) -> None:
        added = "\n".join(added_lines(sections()[SCREEN_SHARE]))
        self.assertIn("setSubscribed(visible)", added)
        self.assertIn("Track.Source.ScreenShare)", added)
        # Keyed by MXID plus source, in the same store the volume patch added.
        self.assertIn("streamVideoKey(inputs.userId)", added)
        self.assertIn("persistentVolumeStore()", added)
        self.assertIn("store.getStreamVisible(videoKey) ?? true", added)

    def test_the_publishers_state_is_not_reused_as_the_viewers_choice(self) -> None:
        section = sections()[SCREEN_SHARE]
        self.assertIn("+  videoVisible$: Behavior<boolean>;", section)
        # videoEnabled$ is only mentioned as context, never removed or rewired.
        self.assertNotIn("-    videoEnabled$:", section)
        self.assertNotIn("-      pretendToBeDisconnected$.pipe", section)
        tile = "\n".join(added_lines(sections()[TILE]))
        self.assertIn("videoEnabled && videoVisible", tile)
        self.assertIn("video={videoVisible ? props.video : undefined}", tile)

    def test_the_ui_is_a_bare_toggle_not_a_menu(self) -> None:
        tile = "\n".join(added_lines(sections()[TILE]))
        # A plain button: the click itself is the action.
        self.assertIn("onClick={onToggle}", tile)
        self.assertIn("vm.setVideoVisible(!vm.videoVisible$.value)", tile)
        # The state is readable without hovering or opening anything.
        self.assertIn("aria-pressed={!videoVisible}", tile)
        for key in VISIBILITY_REFS:
            self.assertIn(key, tile)
        # ...and the eye follows it.
        self.assertIn(
            "const Icon = videoVisible ? VisibilityOnIcon : VisibilityOffIcon;",
            tile,
        )
        # It sits next to the existing volume button, in the same corner.
        self.assertIn("ScreenShareVisibilityButton", tile)
        self.assertIn("ScreenShareVolumeButton", sections()[TILE])
        # Nothing left of the one-item menu it used to be.
        for gone in ("<Menu", "<ToggleMenuItem", "menuitemcheckbox"):
            self.assertNotIn(gone, tile)
        ui_test = "\n".join(added_lines(sections()[TILE_TEST]))
        self.assertNotIn('"menuitemcheckbox"', ui_test)
        self.assertIn('"aria-pressed"', ui_test)
        self.assertIn('"Show screen share"', ui_test)

    def test_a_viewer_choice_is_remembered_per_mxid(self) -> None:
        added = "\n".join(added_lines(sections()[SCREEN_SHARE_TEST]))
        self.assertIn("streamVideoKey(ALICE)", added)
        self.assertIn("screenShare(second.publication, BOB)", added)
        # Restart and reconnect are both exercised.
        self.assertIn("survives a restart", added)
        self.assertIn("reconnect", added)

    def test_no_global_hide_everything_toggle(self) -> None:
        text = PATCH.read_text(encoding="utf-8").lower()
        for word in ("hide_all", "hideall", "hide_all_streams", "hideevery"):
            self.assertNotIn(word, text)

    def test_the_audio_controls_and_the_sfu_are_untouched(self) -> None:
        for path in sections():
            for off_limits in OFF_LIMITS:
                self.assertFalse(
                    path.startswith(off_limits),
                    f"{path} is out of scope for this patch",
                )

    def test_locales_are_not_touched_by_the_global_toggle(self) -> None:
        # The strings are checked in the applied tree; here it is enough that
        # the patch does not invent a "hide everything" label.
        text = PATCH.read_text(encoding="utf-8").lower()
        for word in ("hide all", "hide every", "all streams"):
            self.assertNotIn(word, text)


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


@unittest.skipUnless(NODE, "node is not installed")
class StoreLogicTests(unittest.TestCase):
    """Runs the store the patch series produces, under node, with no browser."""

    expected = (
        "the stream visibility key is the mxid plus the source",
        "a stream is shown until the viewer says otherwise",
        "hiding a stream is remembered",
        "showing a stream again is remembered",
        "a visibility entry is not read back as a volume",
        "the microphone, the share's audio and its video are separate keys",
        "a hidden stream survives a restart",
        "the choice is in both layers",
        "an unchanged choice is neither cached nor synced again",
        "a visibility change from another device reaches a running call",
        "a newer change from another device wins",
        "an older change from another device does not overwrite ours",
        "choices for different people are merged, not replaced",
        "what one device hides is hidden on the other device's next start",
        "a visibility entry without a boolean is junk",
        "keys that are not a Matrix user id are not stored",
        "the microphone's key cannot be used to hide a stream",
        "without an account nothing is remembered",
    )

    results: dict[str, str] = {}
    stdout = ""
    stderr = ""
    returncode = -1
    source = ""

    @classmethod
    def setUpClass(cls) -> None:
        if not GIT:
            raise unittest.SkipTest("git is not installed")
        assert NODE is not None
        archive = source_archive()
        cls.tmp = tempfile.TemporaryDirectory(prefix="ec-stream-")
        root = Path(cls.tmp.name)
        with tarfile.open(archive) as tar:
            tar.extractall(root, filter="data")
        roots = sorted(path for path in root.iterdir() if path.is_dir())
        assert len(roots) == 1, roots
        source_root = roots[0]
        for patch in sorted((EC / "patches").glob("*.patch")):
            applied = subprocess.run(
                ["git", "apply", str(patch)],
                cwd=source_root,
                capture_output=True,
                text=True,
            )
            assert applied.returncode == 0, f"{patch.name}: {applied.stderr}"
        cls.source = (source_root / STORE).read_text(encoding="utf-8")

        probe_root = root / "probe"
        probe_root.mkdir()
        (probe_root / "PersistentVolume.ts").write_text(cls.source, encoding="utf-8")
        shutil.copy(PROBE, probe_root)
        # `node <file>` rather than `--test`: the probe has its own runner so
        # that the output is one line per case on every node 22+.
        completed = subprocess.run(
            [NODE, "stream_visibility_probe.mjs"],
            cwd=probe_root,
            capture_output=True,
            text=True,
            timeout=180,
        )
        cls.stdout = completed.stdout
        cls.stderr = completed.stderr
        cls.returncode = completed.returncode
        cls.results = {}
        for line in completed.stdout.splitlines():
            if line.startswith("PASS "):
                cls.results[line[len("PASS ") :]] = "PASS"
            elif line.startswith("FAIL "):
                name, _, reason = line[len("FAIL ") :].partition(": ")
                cls.results[name] = f"FAIL: {reason}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_probe_is_green(self) -> None:
        self.assertEqual(
            0,
            self.returncode,
            "the stream visibility probe failed:\n"
            + self.stdout
            + self.stderr,
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

    def test_the_store_keeps_its_no_runtime_import_rule(self) -> None:
        runtime_imports = [
            line
            for line in self.source.splitlines()
            if line.startswith("import ") and not line.startswith("import type ")
        ]
        self.assertEqual([], runtime_imports)


@unittest.skipUnless(GIT, "git is not installed")
class AppliedSourceTests(unittest.TestCase):
    """The whole series applies to the pinned tag and produces what we expect."""

    root: Path
    tmp: tempfile.TemporaryDirectory

    @classmethod
    def setUpClass(cls) -> None:
        archive = source_archive()
        cls.tmp = tempfile.TemporaryDirectory(prefix="ec-stream-applied-")
        root = Path(cls.tmp.name)
        with tarfile.open(archive) as tar:
            tar.extractall(root, filter="data")
        roots = sorted(path for path in root.iterdir() if path.is_dir())
        assert len(roots) == 1, roots
        cls.root = roots[0]
        for patch in sorted((EC / "patches").glob("*.patch")):
            applied = subprocess.run(
                ["git", "apply", str(patch)],
                cwd=cls.root,
                capture_output=True,
                text=True,
            )
            assert applied.returncode == 0, f"{patch.name}: {applied.stderr}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def read(self, path: str) -> str:
        return (self.root / path).read_text(encoding="utf-8")

    def test_the_series_applies_in_filename_order(self) -> None:
        names = [p.name for p in sorted((EC / "patches").glob("*.patch"))]
        self.assertIn(PATCH.name, names)
        self.assertEqual(names, sorted(names))
        self.assertTrue((self.root / SCREEN_SHARE).is_file())

    def test_the_view_model_unsubscribes_and_resubscribes(self) -> None:
        source = self.read(SCREEN_SHARE)
        self.assertIn("setSubscribed(visible)", source)
        self.assertIn("videoVisible$", source)
        self.assertIn("store.setStreamVisible(videoKey, visible)", source)
        self.assertIn("store.getStreamVisible(videoKey) ?? true", source)

    def test_the_tile_hides_the_track_not_just_the_pixels(self) -> None:
        source = self.read(TILE)
        self.assertIn("video={videoVisible ? props.video : undefined}", source)
        self.assertIn("aria-pressed={!videoVisible}", source)
        self.assertNotIn("<ToggleMenuItem", source)

    def test_upstream_audio_controls_are_byte_identical(self) -> None:
        # Compare with the same file in the untouched archive.
        pristine = self.root.parent / "pristine"
        if not pristine.exists():
            archive = source_archive()
            pristine.mkdir()
            with tarfile.open(archive) as tar:
                tar.extractall(pristine, filter="data")
        original = next(pristine.iterdir()) / "src/state/VolumeControls.ts"
        self.assertEqual(
            original.read_text(encoding="utf-8"),
            self.read("src/state/VolumeControls.ts"),
        )

    def test_locales_have_the_same_video_tile_keys(self) -> None:
        en = json.loads(self.read(LOCALE_EN))["video_tile"]
        ru = json.loads(self.read(LOCALE_RU))["video_tile"]
        self.assertEqual(set(en), set(ru))
        for key in VISIBILITY_KEYS:
            self.assertIn(key, en)
            self.assertIn(key, ru)
        # No dead keys: the retired menu label has no reader left in the tree.
        source = "\n".join(
            self.read(path) for path in (SCREEN_SHARE, TILE)
        )
        for key in RETIRED_KEYS:
            self.assertNotIn(key, en, f"{key} is still in the English catalog")
            self.assertNotIn(key, ru, f"{key} is still in the Russian catalog")
            self.assertNotIn(
                f"video_tile.{key}", source, f"{key} is still referenced"
            )


if __name__ == "__main__":
    unittest.main()