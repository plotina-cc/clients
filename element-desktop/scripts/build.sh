#!/usr/bin/env bash
# Build Plotina's Element Desktop from a pinned element-web tag.
#
#   scripts/build.sh            # current platform: AppImage+deb, or NSIS on Windows
#
# Expects: node 24 with pnpm, python3, git, curl, and network access for
# `pnpm install` and the Element Web release tarball (53 MB, cached in .build/).
# SENTRY_DSN overrides the GlitchTip DSN committed in element-web/config.json
# (CI passes the repository variable so a rotation needs no commit). The build
# fails if the resulting config has no usable DSN.
# macOS is not built: our builds are unsigned and the arm64 runner would only
# cover Apple Silicon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="${WORK:-$ROOT/.build}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
REPO="https://github.com/element-hq/element-web.git"
SRC="$WORK/element-web"

echo "==> upstream $TAG in $WORK"
mkdir -p "$WORK"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$TAG" "$REPO" "$SRC"
fi
cd "$SRC"
git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
git checkout --quiet "$TAG"

# The desktop app is part of the element-web monorepo since 1.12.14; only its
# own workspace project is installed, the webapp comes from the pinned tarball.
echo "==> desktop deps"
cd apps/desktop
pnpm install --frozen-lockfile --filter element-desktop

echo "==> webapp"
"$ROOT/scripts/prepare-webapp.sh" --dest "$WORK/webapp"

echo "==> webapp.asar"
rm -rf webapp webapp.asar
cp -a "$WORK/webapp" webapp
pnpm run asar-webapp
pnpm exec asar list webapp.asar | grep -q '^/noise/boot.js$'
pnpm exec asar list webapp.asar | grep -q '^/noise/plotina-dfn.js$'
# The floating level panel is gone with EC .17 (Settings -> Audio owns the
# level); an entry reappearing here means a stale layer was copied back in.
! pnpm exec asar list webapp.asar | grep -q '^/noise/plotina-panel.js$'
pnpm exec asar list webapp.asar | grep -q '^/config.json$'
pnpm exec asar list webapp.asar | grep -q '^/LICENSE-AGPL-3.0$'
pnpm exec asar list webapp.asar | grep -q '^/NOTICE$'
# The call widget must be ours *in the asar*, not just in .build/webapp: the
# packed bytes are what users install. --asar reads the archive directly (no
# extraction) and fails on the upstream widget (no stream_paused / voice
# volumes) and on leftover root-absolute asset URLs.
python3 "$ROOT/scripts/element-call-widget.py" --asar webapp.asar
# Check the packed file, not the directory it came from: the whole point is
# that the Sentry block ends up inside the artifact users install.
node -e '
const { extractFile } = require("@electron/asar");
const c = JSON.parse(extractFile("webapp.asar", "config.json"));
const s = c.sentry || {};
if (!s.dsn || s.environment !== "production" || !/\/relay\//.test(s.dsn)) {
  console.error("webapp.asar config.json has no usable sentry block:", s);
  process.exit(1);
}
console.log("asar config.json sentry:", s.dsn.replace(/\/\/[^@]+@/, "//<key>@"), s.environment);
'

echo "==> variant"
cp "$ROOT/build.plotina.json" variant.json

# Upstream's src/updater.ts only drives Squirrel, which our NSIS packaging
# never installs; swap in our own GitHub-releases updater (Windows NSIS +
# Linux AppImage) before compiling.
cp "$ROOT/desktop/updater.ts" src/updater.ts

# Plotina shell patches (mirror of the "Apply Plotina desktop sources" CI step):
#  * src/icon.ts: getMainWindowIcon() caps the Linux window icon at 128px so
#    Chromium can actually serialize it into _NET_WM_ICON (a 256px icon blows
#    the X request limit and KDE's switcher shows a generic/empty icon);
#  * patch-shell.py: wires electron-main.ts to that helper and answers ipc.ts'
#    getUpdateFeedUrl from our updater, so Settings -> "Check for updates"
#    appears on Linux AppImage despite upstream's Squirrel-only call throwing.
cp "$ROOT/desktop/icon.ts" src/icon.ts
# Protocol registration for every scheme build.plotina.json declares
# (io.element.desktop, the SSO callback): electron-builder only applies
# `protocols` to macOS bundles and Linux .desktop files, so the shell has to
# claim it itself on Windows.
cp "$ROOT/desktop/protocol-schemes.ts" src/protocol-schemes.ts
rm -rf build/icons && cp -r "$ROOT/build/icons" build/icons
# electron-builder's default nsis.include is build/installer.nsh, and its
# uninstaller deletes only the protocol keys its own installer wrote; the ones
# Electron's setAsDefaultProtocolClient() writes at runtime are removed by the
# customUnInstall hook in this file (see its header). The variant whitelist in
# apps/desktop/electron-builder.ts drops an "nsis" block, so the copy is the
# wiring. Must mirror the "Apply Plotina desktop sources" step in
# .github/workflows/build-element-desktop.yml.
cp "$ROOT/build/installer.nsh" build/installer.nsh
python3 "$ROOT/desktop/patch-shell.py" src

echo "==> installers"
# GNU tar and some containers hate hard links (electron-builder#5721).
export USE_HARD_LINKS=false
# electron-builder resolves the app version from VERSION (see upstream
# electron-builder.ts) or package.json; interpolate it into the artifact
# names ourselves: passing the ${version} macro through `pnpm run build`
# (nx) dies to shell re-expansion -- nx re-quotes such argument values in
# double quotes and ${version} expands to the empty string.
APPVER="${VERSION:-$(node -p 'require("./package.json").version')}"
case "$(uname -s)" in
  Linux)                TARGETS=(-l appimage deb)
                        PUB=("--config.appImage.artifactName=Plotina-Desktop-$APPVER.AppImage" \
                             --config.linux.icon=icons \
                             "--config.linux.desktop.entry.Name=Plotina Desktop") ;;
  MINGW*|MSYS*|CYGWIN*) TARGETS=(-w nsis)
                        PUB=(--config.win.executableName=Plotina-Desktop \
                             "--config.nsis.artifactName=Plotina-Desktop-$APPVER-setup.exe" \
                             --config.nsis.include=build/installer.nsh) ;;
  *)
    echo "build.sh: unsupported platform $(uname -s); macOS is not built for lack of a signing identity" >&2
    exit 1
    ;;
esac
# Upstream's electron-builder.ts ignores the variant's publish block, so the
# github publish target is forced via CLI dot-overrides (they beat the config
# file and the "repository" field inference). Set VERSION="<base>-plotina.N"
# (semver prerelease only; a 4-segment version gets mangled by
# electron-builder) so successive builds have distinct app versions.
VARIANT_PATH=variant.json pnpm run build --publish never "${TARGETS[@]}" \
  --config.publish.provider=github \
  --config.publish.owner=plotina-cc \
  --config.publish.repo=clients \
  --config.publish.releaseType=release \
  "${PUB[@]}"

# The deb keeps upstream's Vendor/Maintainer/Homepage and menu name; rewrite
# those in the built package (app-update.yml is already ours since the build
# publishes directly to plotina-cc/clients — repacking an AppImage after the
# fact would break the sha512 that latest-linux.yml just published, so we
# assert the metadata instead of patching it).
for deb in dist/*.deb; do
  [ -f "$deb" ] || continue
  REQUIRE_HICOLOR_ICONS=1 "$HERE/fix-deb-branding.sh" "$deb"
done

# The compiled shell must carry the Plotina patches (see the cp/patch-shell
# step above); if nx/electron-builder ever starts shipping lib/ from a cached
# build, these greps fail the build instead of the user's icons.
echo "==> shell patch assertions"
grep -q "getMainWindowIcon" lib/electron-main.js || { echo "build.sh: lib/electron-main.js lacks getMainWindowIcon" >&2; exit 1; }
grep -q 'from "./updater.js"' lib/ipc.js || { echo "build.sh: lib/ipc.js does not import our updater feed" >&2; exit 1; }
grep -q "plotinaUpdateFeed" lib/updater.js || { echo "build.sh: lib/updater.js lacks plotinaUpdateFeed" >&2; exit 1; }
# Every scheme the variant declares must be registered, not just protocols[0]
# (a declared-but-unclaimed scheme is what QA reports as
# CHECK|protocol:declared|NOT-REGISTERED). The variant declares one scheme,
# io.element.desktop — the SSO callback MAS requires.
grep -q "protocolSchemeList" lib/protocol.js || { echo "build.sh: lib/protocol.js does not register the variant's protocol list" >&2; exit 1; }
grep -q "electron_protocols" lib/build-config.js || { echo "build.sh: lib/build-config.js lacks the electron_protocols list" >&2; exit 1; }
grep -q "electron_protocols" electron-builder.ts || { echo "build.sh: electron-builder.ts does not export electron_protocols" >&2; exit 1; }
if [ -d dist/linux-unpacked ]; then
  ai=$(ls dist/*.AppImage 2>/dev/null | head -1)
  [ -n "$ai" ] || { echo "build.sh: no AppImage to inspect" >&2; exit 1; }
  ai="$(readlink -f "$ai")"
  rm -rf "$WORK/appimg-check"; mkdir -p "$WORK/appimg-check"
  ( cd "$WORK/appimg-check" && "$ai" --appimage-extract >/dev/null )
  d="$WORK/appimg-check/squashfs-root"
  grep -qx "Name=Plotina Desktop" "$d"/*.desktop || { echo "build.sh: AppImage .desktop Name wrong" >&2; exit 1; }
  grep -qx "StartupWMClass=plotina-desktop" "$d"/*.desktop || { echo "build.sh: AppImage .desktop StartupWMClass wrong" >&2; exit 1; }
  n=$(find "$d/usr/share/icons/hicolor" -path "*/apps/plotina-desktop.png" | wc -l)
  [ "$n" -ge 8 ] || { echo "build.sh: AppImage carries only $n hicolor icons; expected >=8" >&2; exit 1; }
  echo "build.sh: AppImage .desktop + $n hicolor sizes OK"
fi

# Verify the packaged updater config instead of patching it after the fact:
# re-packing the AppImage would change the bytes behind the sha512 that
# latest-linux.yml publishes for it.
echo "==> updater metadata check"
shopt -s nullglob
case "$(uname -s)" in
  Linux) unpacked=dist/linux-unpacked; meta=dist/latest-linux.yml ;;
  *)     unpacked=dist/win-unpacked;   meta=dist/latest.yml ;;
esac
if [ -d "$unpacked" ]; then
  yml="$unpacked/resources/app-update.yml"
  grep -qx 'owner: plotina-cc' "$yml" || { echo "build.sh: $yml is not ours" >&2; exit 1; }
  grep -qx 'repo: clients' "$yml" || { echo "build.sh: $yml is not ours" >&2; exit 1; }
  grep -qE 'vector-im|element-web' "$yml" && { echo "build.sh: $yml still references upstream" >&2; exit 1; } || true
  [ -s "$meta" ] || { echo "build.sh: $meta missing; updater metadata was not generated" >&2; exit 1; }
fi

echo "==> stage (names must match latest*.yml, so no renaming)"
mkdir -p "$ROOT/dist-stable"
for f in dist/*.exe dist/*.exe.blockmap dist/*.AppImage dist/*.AppImage.blockmap dist/*.deb dist/latest.yml dist/latest-linux.yml; do
  cp "$f" "$ROOT/dist-stable/"
done
ls -lh "$ROOT/dist-stable"
