#!/usr/bin/env python3
"""Android versionCode for Plotina Mobile releases (updater contract).

Two numbers matter, and they are not the same one:

1. the **build number** handed to `flutter build apk --build-number`:

       versionName = major.minor.patch   (pubspec.yaml `version:`)
       build       = N                   (the release tag suffix,
                                          v2.11.3-plotina-mobile.N)
       base        = major * 1_000_000 + minor * 10_000 + patch * 100 + N

       2.11.3 + build 22 -> 2110322
       2.11.3 + build 23 -> 2110323

2. the **versionCode inside the built APK**. We build with `--split-per-abi`
   (one fat APK is about twice the size), and Flutter's Gradle plugin then
   overrides the version code per split instead of using the base as it is:

       versionCodeOverride = abi * 1000 + base
       # packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt,
       # FlutterPluginConstants.ABI_VERSION = armeabi-v7a 1, arm64-v8a 2,
       # x86_64 4 (3 was retired with x86)

       arm64 build 23 -> 2112323, armv7 build 23 -> 2111323

   `apk_version_code()` below is the only place that knows this. The updater
   compares its own PackageManager versionCode (which carries the ABI digit)
   with `update-mobile.json`, so the manifest must publish the *APK* number, not
   the base. CI therefore reads the number back out of the finished APK with
   aapt/apkanalyzer, fails if it is not what this file predicts, and writes the
   read-back value into the manifest: a Flutter change to that offset then
   breaks the build instead of silently publishing a manifest that no installed
   app can match.

Ordering stays monotonic within a device family because the offset is constant
per ABI: every build of arm64 is below the next build of arm64, and 32-bit
devices are pointed at the armv7 APK by hand (patch 0016), so the two families
never compare against each other.

Limits, checked on purpose: minor < 100, patch < 10, 0 <= N < 100. That keeps
patch * 100 + N <= 999, so the base can never carry into the ABI digit. If
upstream ever ships 2.11.10, widen the formula *here* (and only here) before
tagging a release.

A build number of 0 is used by untagged local/CI test builds; it collides with
the `.0` release of the same patch, which is intentionally never tagged.

Dev update channel (Settings -> "Канал обновлений" in the app, patch 0016):

    tag        v2.11.3-plotina-mobile.28-dev.1
    base       2.11.3, build number 28  -> versionCode EXACTLY that of the
               published stable .28 (2110328; arm64 APK 2112328). Android
               permits reinstalling an equal versionCode (checkDowngrade
               rejects only lower codes); same package, same signing key, so
               a dev build replaces the stable install in place and the next
               stable (.29 -> 2112329) is a normal upgrade back.
    versionName 2.11.3-dev.1  (flutter `--build-name`); the app parses the
               `-dev.<M>` suffix of its own versionName as `devBuild` M and
               compares M dev-to-dev, because the versionCode is equal.
    feed       update-mobile-dev.json on the GitHub `dev-latest` release,
               never plotina.cc/dl; it carries the same versionCode plus
               "devBuild": M.

A dev build must be based on the *latest published stable*, never an
unreleased future one: `--check-dev-base` validates the tag against the list
of remote tags before CI spends 30 minutes building.

Usage:

    version-code.py 2.11.3 23               -> 2110323   # --build-number
    version-code.py 2.11.3 23 arm64-v8a     -> 2112323   # what the APK holds
    version-code.py --parse-ref v2.11.3-plotina-mobile.28-dev.1
        -> shell lines: base=2.11.3 build=28 dev=1 version_name=2.11.3-dev.1
           code=2110328 arm64_version_code=2112328 armv7_version_code=2111328
    version-code.py --check-dev-base v2.11.3-plotina-mobile.28-dev.1 tags.txt
        -> ok / fatal; tags.txt is `git ls-remote --tags` output (or one tag
           per line) listing what is published

Used by .github/workflows/build-fluffychat.yml and scripts/build-android.sh so
the CI APK, the local APK and update-mobile.json always agree on the number.
"""

import re
import sys

# Flutter's FlutterPluginConstants.ABI_VERSION, repeated here on purpose: it is
# what turns `--build-number` into the versionCode that ends up in the APK.
ABI_OFFSET = {"armeabi-v7a": 1, "arm64-v8a": 2, "x86_64": 4}


def _split(version_name: str, build: str) -> tuple[int, int, int, int]:
    parts = version_name.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        sys.exit(
            f"version-code: versionName must be major.minor.patch, got {version_name!r}"
        )
    major, minor, patch = (int(p) for p in parts)
    try:
        n = int(build)
    except ValueError:
        sys.exit(f"version-code: build must be an integer, got {build!r}")
    if minor >= 100:
        sys.exit(f"version-code: {version_name} exceeds the 2-digit minor slot")
    if patch >= 10:
        sys.exit(
            f"version-code: {version_name} needs a 1-digit patch: patch*100 + build "
            "must stay below 1000 so it cannot carry into Flutter's ABI digit"
        )
    if not 0 <= n < 100:
        sys.exit(f"version-code: build {n} outside 0..99 (next release bumps the version)")
    return major, minor, patch, n


def version_code(version_name: str, build: str) -> int:
    """The number handed to `flutter build apk --build-number`."""
    major, minor, patch, n = _split(version_name, build)
    return major * 1_000_000 + minor * 10_000 + patch * 100 + n


def apk_version_code(version_name: str, build: str, abi: str) -> int:
    """The versionCode `--split-per-abi` writes into the APK of that ABI."""
    if abi not in ABI_OFFSET:
        sys.exit(
            f"version-code: unknown ABI {abi!r}, known: {', '.join(sorted(ABI_OFFSET))}"
        )
    base = version_code(version_name, build)
    # The slots keep the 10^3 digit of the base at 0; if that ever stops being
    # true, the ABI digit would be added to a nonzero digit and the number
    # stops meaning what the docstring says.
    if base % 10_000 >= 1000:
        sys.exit(
            f"version-code: base {base} already occupies the ABI digit "
            f"({base % 10_000} >= 1000); widen the formula deliberately, not by accident"
        )
    return ABI_OFFSET[abi] * 1000 + base


# v2.11.3-plotina-mobile.23            (stable)
# v2.11.3-plotina-mobile.28-dev.1      (dev build 1 of the published .28)
REF_RE = re.compile(
    r"^v(?P<base>\d+\.\d+\.\d+)-plotina-mobile\.(?P<build>\d+)"
    r"(?:-dev\.(?P<dev>\d+))?$"
)


def parse_ref(ref_name: str):
    """Split a Plotina Mobile release tag into (base, build, dev_or_None).

    Stable tags parse exactly as before; the optional `-dev.<M>` suffix marks
    a dev-channel build of the *same* base and build number. Exit (not raise)
    on anything that is not our tag shape, mirroring the formula errors.
    """
    match = REF_RE.match(ref_name.strip())
    if not match:
        sys.exit(
            f"version-code: {ref_name!r} is not v<base>-plotina-mobile.<N>"
            "[-dev.<M>]"
        )
    dev = match.group("dev")
    return match.group("base"), int(match.group("build")), int(dev) if dev else None


def dev_version_name(base: str, dev: int) -> str:
    """The `--build-name` a dev APK carries: 2.11.3 + 1 -> '2.11.3-dev.1'.

    The app parses this suffix back into its devBuild number (patch 0016), so
    the format is part of the updater contract, not a cosmetic choice.
    """
    return f"{base}-dev.{dev}"


def tag_names(refs) -> list[str]:
    """Tag names from `git ls-remote --tags` output or plain lines.

    Skips peeled `^{}` lines and non-tag refs; accepts `refs/tags/v...` and
    bare `v...`.
    """
    names = []
    for raw in refs:
        parts = raw.strip().split()
        if not parts:
            continue
        # ls-remote lines are "<sha>\t<ref>"; plain lists carry just the tag.
        line = parts[-1]
        if line.endswith("^{}"):
            continue
        if line.startswith("refs/tags/"):
            line = line[len("refs/tags/"):]
        if line.startswith("v"):
            names.append(line)
    return names


def published_stable_codes(refs) -> dict[int, str]:
    """versionCode -> tag, for every *published stable* mobile tag in refs.

    Dev tags are excluded on purpose: they reuse their base's code and are
    not stable revisions.
    """
    codes: dict[int, str] = {}
    for name in tag_names(refs):
        base, build, dev = _parse_ref_or_none(name)
        if dev is not None or base is None:
            continue
        codes[version_code(base, str(build))] = name
    return codes


def _parse_ref_or_none(ref_name: str):
    try:
        match = REF_RE.match(ref_name.strip())
        if not match:
            return None, None, None
        dev = match.group("dev")
        return (
            match.group("base"),
            int(match.group("build")),
            int(dev) if dev else None,
        )
    except Exception:
        return None, None, None


def check_dev_base(dev_ref: str, refs) -> str:
    """Validate a dev tag against what is actually published.

    The rule (approved design): a dev build is cut on top of the latest
    published stable revision - never on a future, unreleased one. Both
    halves are checked:

    1. the stable tag `v<base>-plotina-mobile.<N>` must exist, otherwise the
       dev tag references a release that was never published;
    2. no published stable may have a greater versionCode, otherwise this dev
       build is based on an outdated revision and the dev feed would offer
       stale code (tag the dev against the current stable instead).

    Returns a human 'ok' line; exits non-zero with the reason otherwise.
    """
    base, build, dev = parse_ref(dev_ref)
    if dev is None:
        sys.exit(f"version-code: {dev_ref!r} is not a -dev.<M> tag")
    codes = published_stable_codes(refs)
    my_code = version_code(base, str(build))
    if my_code not in codes:
        sys.exit(
            f"version-code: {dev_ref!r} is based on "
            f"v{base}-plotina-mobile.{build}, which is not a published stable "
            "tag; dev builds must sit on the latest published stable"
        )
    highest = max(codes)
    if highest > my_code:
        sys.exit(
            f"version-code: {dev_ref!r} is based on {codes[my_code]} "
            f"(versionCode {my_code}), but the published stable "
            f"{codes[highest]} (versionCode {highest}) is newer; cut the dev "
            "tag against the current stable instead"
        )
    return (
        f"ok: {dev_ref!r} is based on the latest published stable "
        f"{codes[my_code]} (versionCode {my_code})"
    )


def emit_parse_ref(ref_name: str) -> None:
    """Print the parsed tag as shell-friendly key=value lines for CI."""
    base, build, dev = parse_ref(ref_name)
    version_name = dev_version_name(base, dev) if dev else base
    code = version_code(base, str(build))
    print(f"base={base}")
    print(f"build={build}")
    print(f"dev={dev if dev is not None else ''}")
    print(f"version_name={version_name}")
    print(f"code={code}")
    print(f"arm64_version_code={ABI_OFFSET['arm64-v8a'] * 1000 + code}")
    print(f"armv7_version_code={ABI_OFFSET['armeabi-v7a'] * 1000 + code}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--parse-ref":
        if len(argv) != 2:
            sys.exit("usage: version-code.py --parse-ref v2.11.3-plotina-mobile.28-dev.1")
        emit_parse_ref(argv[1])
    elif argv and argv[0] == "--check-dev-base":
        if len(argv) != 3:
            sys.exit(
                "usage: version-code.py --check-dev-base <dev-tag> <refs-file>"
            )
        with open(argv[2], encoding="utf-8") as handle:
            print(check_dev_base(argv[1], handle.readlines()))
    elif len(argv) == 2:
        print(version_code(argv[0], argv[1]))
    elif len(argv) == 3:
        print(apk_version_code(argv[0], argv[1], argv[2]))
    else:
        sys.exit(__doc__)
