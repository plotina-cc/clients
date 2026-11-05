#!/usr/bin/env python3
"""Android versionCode for Plotina Mobile releases (updater contract).

Formula (documented and monotonic while the limits hold):

    versionName  = major.minor.patch   (pubspec.yaml `version:`)
    build        = N                  (the release tag suffix,
                                       v2.11.3-plotina-mobile.N)
    versionCode  = major * 1_000_000
                 + minor  *    10_000
                 + patch  *       100
                 + N

    2.11.3 + build 22  ->  2*1000000 + 11*10000 + 3*100 + 22 = 2110322
    2.11.3 + build 23  ->  2110323

Limits, checked on purpose: minor < 100, patch < 100, 0 <= N < 100. Any
version component that stays inside its slot keeps the code monotonic: the
next patch release starts at N=1, which is above the previous patch's N=99
because `patch*100` already jumped ahead. The result always fits in a 32-bit
int for sane versions.

A build number of 0 is used by untaged local/CI test builds; it collides with
the `.0` release of the same patch, which is intentionally never tagged.

Used by .github/workflows/build-fluffychat.yml and scripts/build-android.sh
so the CI APK, the local APK and the update-mobile.json manifest always
agree on the number.
"""

import sys


def version_code(version_name: str, build: str) -> int:
    parts = version_name.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        sys.exit(f"version-code: versionName must be major.minor.patch, got {version_name!r}")
    major, minor, patch = (int(p) for p in parts)
    try:
        n = int(build)
    except ValueError:
        sys.exit(f"version-code: build must be an integer, got {build!r}")
    if minor >= 100 or patch >= 100:
        sys.exit(f"version-code: {version_name} exceeds the 2-digit minor/patch slots")
    if not 0 <= n < 100:
        sys.exit(f"version-code: build {n} outside 0..99 (next release bumps the version)")
    return major * 1_000_000 + minor * 10_000 + patch * 100 + n


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    print(version_code(sys.argv[1], sys.argv[2]))
