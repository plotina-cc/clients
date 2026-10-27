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

"$here/scripts/fetch-model.sh"

: "${ANDROID_NDK_HOME:=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/ndk/* | sort -V | tail -1)}"
export ANDROID_NDK_HOME

cargo ndk -t arm64-v8a -t armeabi-v7a \
  -o "$here/plotina_dfn/android/src/main/jniLibs" \
  build --release --manifest-path "$here/plotina_dfn/rust/Cargo.toml"

cd "$upstream"
flutter pub get
flutter build apk --release --target-platform android-arm64,android-arm
echo "APK: $upstream/build/app/outputs/flutter-apk/app-release.apk"
