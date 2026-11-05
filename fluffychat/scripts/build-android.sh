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

for patch in "$here"/patches/*.patch; do
  if git -C "$upstream" apply --reverse --check "$patch" 2>/dev/null; then
    echo "already applied: $(basename "$patch")"
  else
    git -C "$upstream" apply --verbose "$patch"
  fi
done

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
# an APK that must install over a released one. The formula and its limits
# are documented in scripts/version-code.py; CI computes it the same way.
base_version="$(sed -n 's/^version: \([0-9][0-9.]*\)+.*/\1/p' pubspec.yaml)"
if [ -z "${PLOTINA_BUILD:-}" ]; then
  ref="$(git -C "$here" describe --tags --match 'v*plotina-mobile.*' --abbrev=0 2>/dev/null || true)"
  case "$ref" in
    v*plotina-mobile.*) PLOTINA_BUILD="${ref##*.}" ;;
    *) PLOTINA_BUILD=0 ;;
  esac
fi
build_number="$(python3 "$here/scripts/version-code.py" "$base_version" "$PLOTINA_BUILD")"
echo "versionCode $build_number ($base_version, build $PLOTINA_BUILD)"
# Optional manifest URL override for testing the updater against a local
# server, e.g. PLOTINA_UPDATE_URL=http://10.0.2.2:8000/update-mobile.json.
update_args=()
[ -n "${PLOTINA_UPDATE_URL:-}" ] && update_args+=(--dart-define=PLOTINA_UPDATE_URL="$PLOTINA_UPDATE_URL")
# No --target-platform: Flutter's Gradle plugin forces its default ABI filter
# (armeabi-v7a, arm64-v8a, x86_64), so building fewer platforms would package
# x86_64 libraries from dependencies without a libflutter.so next to them.
flutter build apk "${update_args[@]}" --build-number "$build_number" "--$variant"
echo "APK: $upstream/build/app/outputs/flutter-apk/app-$variant.apk"
