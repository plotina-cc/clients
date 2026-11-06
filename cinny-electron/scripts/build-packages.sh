#!/usr/bin/env bash
# Build the Plotina Lite Desktop (Electron) packages.
#
#   LITE_DIST=/path/to/cinny/dist bash scripts/build-packages.sh [linux] [windows]
#   (targets default to the host OS: `linux` on Linux, `windows` on Windows)
#
# What it does, in order:
#   1. derive APP_VERSION (tag contract §7.1; a branch/local build gets
#      4.12.8-plotina.0.local — rpm cannot carry a '-' inside Release, so the
#      documented `0-local` fallback is written `0.local`),
#   2. generate the icon set (scripts/build-icons.sh),
#   3. stage the Cinny web dist into web/ (scripts/stage-web.sh) so it is
#      bundled inside the app asar — the shell never depends on a shared dist
#      directory at runtime,
#   4. run electron-builder DIRECTLY (never through pnpm/nx wrappers: they
#      re-quote ${version} macros and they expand empty — the Element run #41
#      failure),
#   5. assert packaging identity (app-update.yml feed, desktop file, icon
#      count), then
#   6. stage stable aliases + SHA256SUMS into dist/stable/ for /dl promotion.
#
# Never publishes: --publish always here would leave a half-published release.
# The release job (Phase 4) uploads the staged assets itself.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# ---- 1. version -------------------------------------------------------------
if [[ "${GITHUB_REF_NAME:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-plotina-lite-desktop\.([0-9]+)$ ]]; then
  APP_VERSION="${BASH_REMATCH[1]}-plotina.${BASH_REMATCH[2]}"
  TAG_OK=1
else
  APP_VERSION="4.12.8-plotina.0.local"
  TAG_OK=0
fi
# Explicit override (CI workflow_dispatch input) wins over derivation.
APP_VERSION="${APP_VERSION_OVERRIDE:-$APP_VERSION}"
# A tag-triggered build IS the release path (workflow build-cinny-electron.yml
# fires on v*-plotina-lite-desktop.*): a tag that does not parse to
# <semver>-plotina.<rev> would silently stamp 0.local artifacts into the
# updater feed. Fail loudly instead; only branch/local builds may use it.
if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ -z "${APP_VERSION_OVERRIDE:-}" ] && [ "$TAG_OK" != 1 ]; then
  echo "FATAL: tag '$GITHUB_REF_NAME' is not v<semver>-plotina-lite-desktop.<rev>" >&2
  echo "       (expected e.g. v4.12.8-plotina-lite-desktop.18 -> APP_VERSION 4.12.8-plotina.18)" >&2
  exit 1
fi
echo "APP_VERSION=$APP_VERSION"

TARGETS=("${@:-}")
if [ "${#TARGETS[@]}" -eq 0 ] || [ -z "${TARGETS[0]}" ]; then
  case "$(uname -s)" in
    Linux*) TARGETS=(linux) ;;
    MINGW*|MSYS*|Windows*) TARGETS=(windows) ;;
    *) echo "unsupported host" >&2; exit 1 ;;
  esac
fi

# ---- 2/3. icons + web --------------------------------------------------------
bash scripts/build-icons.sh
if [ ! -f web/index.html ] || [ -n "${LITE_DIST:-}" ]; then
  bash scripts/stage-web.sh
fi
# electron + electron-builder must be installed (npm ci in CI; dev here).
[ -x node_modules/.bin/electron-builder ] || { echo "run npm install first" >&2; exit 1; }

# ---- 4. build ----------------------------------------------------------------
EB=(node_modules/.bin/electron-builder --config electron-builder.plotina.json
    -c.extraMetadata.version="$APP_VERSION" --publish never)
for t in "${TARGETS[@]}"; do
  case "$t" in
    linux)
      "${EB[@]}" --linux AppImage deb
      # rpm needs rpmbuild on the build host (present on the ubuntu CI
      # runner, often absent on Arch). A missing rpm must not sink a Linux
      # release: it is warned, and the CI job asserts it separately.
      "${EB[@]}" --linux rpm || echo "WARN: rpm target failed (need rpmbuild: sudo apt-get install rpm)"
      ;;
    windows) "${EB[@]}" --win nsis msi ;;
    # Cross-build the auto-updating NSIS installer from a Linux host (works:
    # bundled makensis, no Wine needed). MSI needs WiX+Wine-Mono (or a real
    # Windows runner) — that one stays Windows-CI-only.
    win-nsis) "${EB[@]}" --win nsis ;;
    *) echo "unknown target group '$t'" >&2; exit 1 ;;
  esac
done

# deb: restore the hyphenated -plotina.N Version (electron-builder fpm
# encodes '-' as '~', which dpkg sorts BELOW the plain base and the historic
# -plotina scheme; §6.1 requires .18 > .17).
for deb in dist/*.deb; do
  [ -e "$deb" ] && bash scripts/fix-deb.sh "$deb"
done
# fix-deb changed the deb bytes; refresh sha512/size in any update metadata
# that references it (electron-builder hashed the pre-fix artifact).
for yml in dist/latest.yml dist/latest-linux.yml; do
  [ -e "$yml" ] && node scripts/refresh-update-yml.mjs "$yml"
done
# Ensure the Linux feed always advertises the AppImage, even when the rpm
# target rewrote latest-linux.yml after the AppImage target ran.
[ -e dist/latest-linux.yml ] && node scripts/fix-latest-linux-yml.mjs

# ---- 5. identity assertions ---------------------------------------------------
fail() { echo "PACKAGING ASSERTION FAILED: $*" >&2; exit 1; }

check_app_update_yml() { # $1 = text of app-update.yml
  grep -qx 'provider: github' "$1" || fail "app-update.yml provider"
  grep -qx 'owner: plotina-cc' "$1" || fail "app-update.yml owner"
  grep -qx 'repo: clients' "$1" || fail "app-update.yml repo"
  if grep -qE 'vector-im|element-web|cinnyapp' "$1"; then
    fail "app-update.yml still references upstream"
  fi
}

if [ -d dist ]; then
  for f in dist/latest.yml dist/latest-linux.yml; do
    [ -f "$f" ] && echo "metadata: $f"
  done
fi

# deb: >=8 hicolor icons, correct control fields, valid .desktop, app-update.yml.
if ls dist/*.deb >/dev/null 2>&1; then
  deb="$HERE/$(ls dist/*.deb | head -1)"
  tmp="$(mktemp -d)"
  ( cd "$tmp" && ar x "$deb" )
  ctrl="$(ls "$tmp"/control.tar.* | head -1)"
  tar -xf "$ctrl" -C "$tmp" ./control
  grep -q '^Package: plotina-lite-desktop$' "$tmp/control" || fail "deb Package name"
  grep -q "^Version: ${APP_VERSION}$" "$tmp/control" || fail "deb Version != $APP_VERSION"
  grep -q '^Maintainer: Plotina <support@plotina.cc>$' "$tmp/control" || fail "deb Maintainer"
  if grep -qiE 'vector-im|element\.io|cinnyapp' "$tmp/control"; then fail "upstream string in deb control"; fi
  mkdir -p "$tmp/data"
  data="$(ls "$tmp"/data.tar.* | head -1)"
  tar -xf "$data" -C "$tmp/data"
  nicons=$(find "$tmp/data/usr/share/icons/hicolor" -name 'plotina-lite-desktop.png' | wc -l)
  [ "$nicons" -ge 8 ] || fail "deb has only $nicons hicolor plotina-lite-desktop.png (need >=8)"
  deskt=$(find "$tmp/data/usr/share/applications" -name '*.desktop' | head -1)
  [ -n "$deskt" ] || fail "deb has no .desktop"
  if command -v desktop-file-validate >/dev/null; then
    desktop-file-validate "$deskt" || fail ".desktop does not validate"
  fi
  grep -qx 'StartupWMClass=plotina-lite-desktop' "$deskt" || fail "deb StartupWMClass"
  ls "$tmp/data"/opt/*/resources/app-update.yml >/dev/null 2>&1 || fail "deb has no resources/app-update.yml"
  check_app_update_yml "$(ls "$tmp"/data/opt/*/resources/app-update.yml)"
  echo "deb assertions OK ($nicons icons, $(basename "$deskt"))"
  rm -rf "$tmp"
fi

# AppImage: extract, desktop file + icons + app-update.yml.
if ls dist/*.AppImage >/dev/null 2>&1; then
  ai="$HERE/$(ls dist/*.AppImage | head -1)"
  tmpai="$(mktemp -d)"
  ( cd "$tmpai" && "$ai" --appimage-extract >/dev/null )
  grep -x 'StartupWMClass=plotina-lite-desktop' "$tmpai"/squashfs-root/*.desktop || fail "AppImage StartupWMClass"
  nai=$(find "$tmpai/squashfs-root/usr/share/icons/hicolor" -path '*apps/plotina-lite-desktop.png' | wc -l)
  [ "$nai" -ge 8 ] || echo "WARN: AppImage carries only $nai hicolor sizes (>=8 expected)"
  ls "$tmpai"/squashfs-root/resources/app-update.yml >/dev/null 2>&1 || fail "AppImage has no app-update.yml"
  check_app_update_yml "$tmpai/squashfs-root/resources/app-update.yml"
  echo "AppImage assertions OK ($nai icons)"
  rm -rf "$tmpai"
fi

# ---- 6. stable aliases + checksums -------------------------------------------
node scripts/stage-release-assets.mjs "$APP_VERSION"

echo "BUILD OK ($APP_VERSION)"; ls -la dist/ | sed -n '1,40p'
