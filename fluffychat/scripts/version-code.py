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

Usage:

    version-code.py 2.11.3 23               -> 2110323   # --build-number
    version-code.py 2.11.3 23 arm64-v8a     -> 2112323   # what the APK holds

Used by .github/workflows/build-fluffychat.yml and scripts/build-android.sh so
the CI APK, the local APK and update-mobile.json always agree on the number.
"""

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


if __name__ == "__main__":
    if len(sys.argv) == 3:
        print(version_code(sys.argv[1], sys.argv[2]))
    elif len(sys.argv) == 4:
        print(apk_version_code(sys.argv[1], sys.argv[2], sys.argv[3]))
    else:
        sys.exit(__doc__)
