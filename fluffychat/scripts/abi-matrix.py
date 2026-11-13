#!/usr/bin/env python3
"""Which Android ABIs a Plotina Mobile build compiles and publishes.

The dev loop ("fix -> build -> check on the owner's one phone") used to pay for
three ABIs every time: Dart AOT for android-arm/android-arm64/android-x64, the
Rust denoiser for arm64-v8a/armeabi-v7a/x86_64, and three native library sets in
Gradle. Measured on the three-ABI workflow, `Build native denoiser` alone was
8-10 minutes of a 27-29 minute job. A dev build therefore compiles **one** ABI:

    dev tag      v2.11.3-plotina-mobile.35-dev.3   -> android-arm64 only
    stable tag   v2.11.3-plotina-mobile.35         -> the three it always had

Everything that needs an ABI list (the rustup targets, `cargo ndk -t`, the
`--target-platform` of `flutter build apk`, which APKs to copy, which
versionCodes to expect, which APKs the marker gate and the content check read)
asks this file through `.github/workflows/build-fluffychat.yml` instead of
spelling the lists out again, so "dev is arm64-only" cannot be half-applied:
one list is the truth and CI prints it at the start of the job.

A **stable** tag is unchanged by design — armv7 devices keep their APK and
x86_64 keeps its denoiser build for emulators (its APK is not published, as
before). A dispatch that is not one of our tags at all (a branch run) is a
stable-format build as well: that is how the three-ABI path is proven in CI
without touching a release.

Usage:

    abi-matrix.py --ref v2.11.3-plotina-mobile.35-dev.3   # dev: arm64 only
    abi-matrix.py --ref v2.11.3-plotina-mobile.35         # stable: three ABIs
    abi-matrix.py --ref main                              # untagged: stable
    abi-matrix.py --dev-build 3                           # same, M from CI

    -> KEY=value lines, ready for `>> "$GITHUB_OUTPUT"` (and "$GITHUB_ENV"):

    MODE=dev
    DART_PLATFORMS=android-arm64                  # --target-platform
    CARGO_NDK_TARGETS=arm64-v8a                   # the ABIs, for checks
    CARGO_NDK_FLAGS=-t arm64-v8a                  # cargo ndk arguments
    RUST_TARGETS=aarch64-linux-android            # dtolnay/rust-toolchain
    PUBLISHED_ABIS=arm64-v8a                      # an APK is shipped per ABI
    APK_FILES=Plotina-Mobile.apk                  # the asset names, unchanged
    ABI_PAIRS=Plotina-Mobile.apk arm64-v8a        # <apk> <abi> pairs for loops
    MUST_NOT_BUILD_ABIS=armeabi-v7a x86_64        # must not appear in build/

`CARGO_NDK_TARGETS` is the bare list for the checks that look at the output
directories; `CARGO_NDK_FLAGS` is what goes on the command line, because
`cargo ndk` takes one `-t <abi>` per target and reads a bare ABI as a
subcommand (`error: no such command: arm64-v8a` — that cost the first run).

`MUST_NOT_BUILD_ABIS` is emitted so the build can fail loudly when a half-applied
matrix leaves a stray APK behind: for a dev tag an armeabi-v7a or x86_64 APK
existing in build/ means the compile still happened.
"""

from __future__ import annotations

import re
import sys

# Flutter's own platform names (`flutter build apk --target-platform`).
DART_PLATFORM = {
    "arm64-v8a": "android-arm64",
    "armeabi-v7a": "android-arm",
    "x86_64": "android-x64",
}

# Rust target triples, the same three the workflow installs with rustup.
RUST_TARGET = {
    "arm64-v8a": "aarch64-linux-android",
    "armeabi-v7a": "armv7-linux-androideabi",
    "x86_64": "x86_64-linux-android",
}

# The asset names the updater and the release pages use. `APK_NAME` and
# `APK_NAME_ARMV7` in the workflow's `env:` block must stay equal to these
# (fluffychat/tests/test_abi_matrix.py checks that); only arm64 and armv7 are
# published, x86_64 is for emulators and has never had an APK.
APK_NAME = {
    "arm64-v8a": "Plotina-Mobile.apk",
    "armeabi-v7a": "Plotina-Mobile-armv7.apk",
}

# Three-ABI order is the historical one: arm64 first (it is the APK the updater
# downloads), then armv7, then x86_64. Keep it: the log and the sha256 list in
# a stable build should read exactly as they did before.
STABLE_COMPILED = ("arm64-v8a", "armeabi-v7a", "x86_64")
DEV_COMPILED = ("arm64-v8a",)

# Published = an APK is built and uploaded. Stable publishes arm64 + armv7;
# x86_64 is compiled (emulator) but never published.
STABLE_PUBLISHED = ("arm64-v8a", "armeabi-v7a")
DEV_PUBLISHED = ("arm64-v8a",)

# v2.11.3-plotina-mobile.35[-dev.<M>]; anything else is not our tag.
REF_RE = re.compile(
    r"^v\d+\.\d+\.\d+-plotina-mobile\.\d+(?:-dev\.(?P<dev>\d+))?$"
)


def apk_name(abi: str) -> str:
    """Asset name for an ABI; refuses an ABI we never publish."""
    try:
        return APK_NAME[abi]
    except KeyError:
        sys.exit(
            f"abi-matrix: no APK is published for {abi!r}, known: "
            f"{', '.join(APK_NAME)}"
        )


def mode_from_ref(ref_name: str) -> str:
    """'dev' for a -dev.<M> tag, 'stable' for everything else.

    A branch name, an empty ref or a foreign tag is a stable-format build: CI
    uses `workflow_dispatch` on a branch to prove the three-ABI path without
    touching a release, so this must never fall into arm64-only by accident.
    """
    match = REF_RE.match(ref_name.strip())
    if match and match.group("dev"):
        return "dev"
    return "stable"


def mode_from_dev_build(dev_build: str) -> str:
    """The workflow already knows M; an empty value means a stable build."""
    return "dev" if str(dev_build).strip() else "stable"


def matrix(mode: str) -> dict[str, str]:
    """The ABI lists for one mode, as shell-friendly strings."""
    if mode == "dev":
        compiled, published = DEV_COMPILED, DEV_PUBLISHED
    elif mode == "stable":
        compiled, published = STABLE_COMPILED, STABLE_PUBLISHED
    else:
        sys.exit(f"abi-matrix: unknown mode {mode!r}, expected dev or stable")
    pairs = [f"{apk_name(abi)} {abi}" for abi in published]
    return {
        "MODE": mode,
        "DART_PLATFORMS": ",".join(DART_PLATFORM[abi] for abi in compiled),
        "CARGO_NDK_TARGETS": " ".join(compiled),
        # cargo-ndk takes one `-t <abi>` per target; passing the bare list
        # makes cargo read the first ABI as a subcommand.
        "CARGO_NDK_FLAGS": " ".join(f"-t {abi}" for abi in compiled),
        "RUST_TARGETS": ",".join(RUST_TARGET[abi] for abi in compiled),
        "PUBLISHED_ABIS": " ".join(published),
        "APK_FILES": " ".join(apk_name(abi) for abi in published),
        "ABI_PAIRS": " ".join(pairs),
        # What a stable build has and this one must not: for a dev tag an
        # armv7 or x86_64 APK in build/ means the compile still happened.
        "MUST_NOT_BUILD_ABIS": " ".join(
            abi for abi in STABLE_COMPILED if abi not in compiled
        ),
    }


def emit(mode: str) -> None:
    for key, value in matrix(mode).items():
        print(f"{key}={value}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if len(argv) == 2 and argv[0] == "--ref":
        emit(mode_from_ref(argv[1]))
    elif len(argv) == 2 and argv[0] == "--dev-build":
        emit(mode_from_dev_build(argv[1]))
    else:
        sys.exit(__doc__)
