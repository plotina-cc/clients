#!/usr/bin/env bash
# Local Android build. CI runs the same steps, see
# .github/workflows/build-fluffychat.yml.
#
# Needs: flutter (>= 3.47), rustup with the Android targets, cargo-ndk,
# Android SDK + NDK, and a JDK for Gradle. Nothing here is required to review or
# modify the scaffold.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="$here/upstream"
tag="$(cat "$here/UPSTREAM_TAG")"

if [ ! -d "$upstream/.git" ]; then
  git clone --depth 1 --branch "$tag" https://github.com/krille-chan/fluffychat.git "$upstream"
else
  echo "reusing $upstream"
fi

# Local dev rebuilds often sit on an already-patched tree whose files were
# edited further; re-applying the chain then fails on context. CI still runs
# the strict loop; a local dev tree can set PLOTINA_SKIP_PATCHES=1.
if [ "${PLOTINA_SKIP_PATCHES:-0}" != "1" ]; then
  for patch in "$here"/patches/*.patch; do
    if git -C "$upstream" apply --reverse --check "$patch" 2>/dev/null; then
      echo "already applied: $(basename "$patch")"
    else
      git -C "$upstream" apply --verbose "$patch"
    fi
  done
fi

# In-app logos (welcome/login/empty/lock screens, update snackbar). The
# static PNGs live in plotina_assets/, rendered by
# scripts/render-plotina-app-assets.py.
python3 "$here/scripts/apply-plotina-app-assets.py" "$upstream"

"$here/scripts/fetch-model.sh"

: "${ANDROID_NDK_HOME:=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/ndk/* | sort -V | tail -1)}"
export ANDROID_NDK_HOME

cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o "$here/plotina_dfn/android/src/main/jniLibs" \
  build --release --manifest-path "$here/plotina_dfn/rust/Cargo.toml"

cd "$upstream"
flutter pub get
flutter gen-l10n
# Release signing needs android/key.properties; upstream's fallback points at a
# dummy.keystore that is not in its repository, so build debug without it.
variant=release
[ -f android/key.properties ] || variant=debug
echo "building the $variant variant"
# Android versionCode for the in-app updater. The release tag carries the
# build number (v2.11.3-plotina-mobile.23 -> 23); a local checkout of an
# untagged commit builds .0. Override with PLOTINA_BUILD=<n>, e.g. to produce
# an APK that must install over a released one. The formula, its digit limits
# and the ABI digit Flutter's --split-per-abi adds on top are documented in
# scripts/version-code.py; CI computes the same numbers.
#
# Dev update channel (patch 0016): a dev build is tagged
# v<base>-plotina-mobile.<N>-dev.<M> and keeps the versionCode of the stable
# .N; only the versionName gains -dev.<M>, and the APK is served from the
# GitHub dev-latest feed. Build one locally with:
#   PLOTINA_DEV=1 scripts/build-android.sh        # dev build 1 of the tag base
# or let it read M off a checked-out dev tag. The dev feed URL can be pointed
# at a local server with PLOTINA_DEV_UPDATE_URL.
base_version="$(sed -n 's/^version: \([0-9][0-9.]*\)+.*/\1/p' pubspec.yaml)"
if [ -z "${PLOTINA_BUILD:-}" ]; then
  ref="$(git -C "$here" describe --tags --match 'v*plotina-mobile.*' --abbrev=0 2>/dev/null || true)"
  case "$ref" in
    v*)
      if parsed="$(python3 "$here/scripts/version-code.py" --parse-ref "$ref" 2>/dev/null)"; then
        PLOTINA_BUILD="$(printf '%s\n' "$parsed" | sed -n 's/^build=//p')"
        [ -n "${PLOTINA_DEV:-}" ] || PLOTINA_DEV="$(printf '%s\n' "$parsed" | sed -n 's/^dev=//p')"
      else
        PLOTINA_BUILD=0
      fi
      ;;
    *) PLOTINA_BUILD=0 ;;
  esac
fi
PLOTINA_DEV="${PLOTINA_DEV:-}"
build_number="$(python3 "$here/scripts/version-code.py" "$base_version" "$PLOTINA_BUILD")"
build_name_args=()
if [ -n "$PLOTINA_DEV" ]; then
  build_name="$(python3 "$here/scripts/version-code.py" --parse-ref "v${base_version}-plotina-mobile.${PLOTINA_BUILD}-dev.${PLOTINA_DEV}" | sed -n 's/^version_name=//p')"
  build_name_args+=(--build-name "$build_name")
  echo "dev-channel build $build_name (versionCode stays $build_number of stable .$PLOTINA_BUILD)"
else
  build_name="$base_version"
fi
echo "build number $build_number ($build_name, build $PLOTINA_BUILD)"
for abi in arm64-v8a armeabi-v7a; do
  echo "  --split-per-abi makes the $abi APK versionCode $(python3 "$here/scripts/version-code.py" "$base_version" "$PLOTINA_BUILD" "$abi")"
done
# Optional manifest URL override for testing the updater against a local
# server, e.g. PLOTINA_UPDATE_URL=http://10.0.2.2:8000/update-mobile.json
# (stable feed) and PLOTINA_DEV_UPDATE_URL=http://10.0.2.2:8000/update-mobile-dev.json.
update_args=()
[ -n "${PLOTINA_UPDATE_URL:-}" ] && update_args+=(--dart-define=PLOTINA_UPDATE_URL="$PLOTINA_UPDATE_URL")
[ -n "${PLOTINA_DEV_UPDATE_URL:-}" ] && update_args+=(--dart-define=PLOTINA_DEV_UPDATE_URL="$PLOTINA_DEV_UPDATE_URL")
# No --target-platform: Flutter's Gradle plugin forces its default ABI filter
# (armeabi-v7a, arm64-v8a, x86_64), so building fewer platforms would package
# x86_64 libraries from dependencies without a libflutter.so next to them.
flutter build apk "${update_args[@]}" "${build_name_args[@]}" --build-number "$build_number" "--$variant"
echo "APK: $upstream/build/app/outputs/flutter-apk/app-$variant.apk"
