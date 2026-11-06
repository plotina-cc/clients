#!/usr/bin/env bash
# Silent installer for Plotina Lite Desktop (Electron build).
#
#   curl -fsSL https://plotina.cc/dl/Plotina-Lite-Desktop-install.sh | bash
#
# Adapted from cinny/scripts/install-lite-appimage.sh (the proven silent
# pattern) for the electron-builder artifacts. Success means SILENCE: no
# stdout, no stderr, exit 0. Only fatal errors print (die). Package-manager
# output goes to a temp log that is read only on the error path.
#
# Modes:
#   auto (default): deb via apt/dpkg when this is a Debian system AND sudo
#     works; otherwise the AppImage into ${PREFIX:-$HOME/.local}.
#   --deb / --appimage force one path; a positional arg is a file or URL.
#   PLOTINA_LITE_DEB_URL / PLOTINA_LITE_APPIMAGE_URL override the sources.
#
# What the AppImage path installs (matching the deb):
#   $PREFIX/bin/plotina-lite-desktop          (the image itself)
#   $PREFIX/share/applications/plotina-lite-desktop.desktop
#     Name=Plotina Lite Desktop, Icon=plotina-lite-desktop,
#     StartupWMClass=plotina-lite-desktop, MimeType=x-scheme-handler entries
#   $PREFIX/share/icons/hicolor/<size>x<size>/apps/plotina-lite-desktop.png
# The cc.plotina.chat:// and matrix: URL schemes come from the .desktop
# MimeType lines; we ask xdg-mime to make us the default handler (best
# effort). We never call setAsDefaultProtocolClient from the app itself for
# the AppImage path — that would register the temporary mount point.
set -euo pipefail

DEB_URL="${PLOTINA_LITE_DEB_URL:-https://plotina.cc/dl/Plotina-Lite-Desktop.deb}"
APPIMAGE_URL="${PLOTINA_LITE_APPIMAGE_URL:-https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage}"

BIN_NAME="plotina-lite-desktop"            # executableName in electron-builder config
DESKTOP_NAME="plotina-lite-desktop.desktop"
APP_NAME="Plotina Lite Desktop"
APP_COMMENT="Matrix client for plotina.cc"
MIME_TYPES="x-scheme-handler/cc.plotina.chat;x-scheme-handler/matrix;"

MODE="auto"
DEB_SOURCE=""
APP_SOURCE=""
SUDO_CMD=()

info() { :; }
warn() { :; }
die()  { echo "ERROR: $*" >&2; exit 1; }   # the ONLY output on failure

usage() {
    cat <<'EOF'
Usage: install-lite-electron.sh [--deb|--appimage] [PATH_or_URL]
  PLOTINA_LITE_DEB_URL / PLOTINA_LITE_APPIMAGE_URL override download sources
  PREFIX=... (default ~/.local) for the AppImage path
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --deb)  [ "$MODE" = "appimage" ] && die "conflicting --deb and --appimage"; MODE="deb" ;;
        --appimage) [ "$MODE" = "deb" ] && die "conflicting --deb and --appimage"; MODE="appimage" ;;
        -h|--help) usage; exit 0 ;;
        --*) die "unknown flag: $1" ;;
        *) case "$1" in *.deb) DEB_SOURCE="$1" ;; *) APP_SOURCE="$1" ;; esac ;;
    esac
    shift
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
    local url="$1" dest="$2" attempt
    for attempt in 1 2; do
        if curl -fsSL --retry 2 -o "$dest" "$url" 2>>"$TMP/install.log"; then return 0; fi
        warn "download attempt $attempt failed: $url"
    done
    return 1
}

RESOLVED=""
obtain() {
    local src="$1" url="$2" name="$3"
    if [ -n "$src" ]; then
        case "$src" in
            http://*|https://*)
                download "$src" "$TMP/$name" || die "download failed: $src"
                RESOLVED="$TMP/$name" ;;
            *)  [ -f "$src" ] || die "file not found: $src"
                RESOLVED="$src" ;;
        esac
    else
        download "$url" "$TMP/$name" || die "download failed: $url"
        RESOLVED="$TMP/$name"
    fi
}

refresh_desktop_db() {
    local apps_dir="$1" rc=0
    if command -v update-desktop-database >/dev/null 2>&1; then
        "${SUDO_CMD[@]}" update-desktop-database "$apps_dir" 2>>"$TMP/install.log" || rc=$?
        if [ "$rc" -ne 0 ]; then
            warn "update-desktop-database rc=$rc (menu may refresh later; install not broken)"
        fi
    fi
    return 0
}

register_schemes() {
    # Best effort only: a desktop environment picks this up; headless runs
    # simply keep the .desktop MimeType line.
    local desktop_path="$1"
    if command -v xdg-mime >/dev/null 2>&1; then
        for scheme in cc.plotina.chat matrix; do
            xdg-mime default "$desktop_path" "x-scheme-handler/$scheme" 2>>"$TMP/install.log" || true
        done
    fi
}

deb_env_available() {
    SUDO_CMD=()
    if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
        return 1
    fi
    if [ "$(id -u)" -eq 0 ]; then return 0; fi
    if ! command -v sudo >/dev/null 2>&1; then return 1; fi
    if sudo -n true 2>/dev/null; then SUDO_CMD=(sudo); return 0; fi
    if [ -t 0 ]; then
        if sudo -v 2>>"$TMP/install.log"; then SUDO_CMD=(sudo); return 0; fi
        return 1
    fi
    return 1
}

install_deb() {
    local deb
    obtain "$DEB_SOURCE" "$DEB_URL" "Plotina-Lite-Desktop.deb"
    deb="$RESOLVED"
    if "${SUDO_CMD[@]}" apt-get install -y "$deb" >>"$TMP/install.log" 2>&1; then
        info "deb installed via apt-get"
    elif "${SUDO_CMD[@]}" dpkg -i "$deb" >>"$TMP/install.log" 2>&1 \
      && "${SUDO_CMD[@]}" apt-get -f install -y >>"$TMP/install.log" 2>&1; then
        warn "apt-get install failed; installed with dpkg -i + apt-get -f install"
    else
        warn "cannot install $deb"
        return 1
    fi
    if [ ! -f "/usr/share/applications/$DESKTOP_NAME" ]; then
        warn "no $DESKTOP_NAME in /usr/share/applications after deb install"
    fi
    refresh_desktop_db "/usr/share/applications"
    register_schemes "$DESKTOP_NAME"
    return 0
}

install_appimage() {
    local appimage bin desktop icon_dir extract src_png size found src_desktop
    PREFIX="${PREFIX:-$HOME/.local}"
    bin="$PREFIX/bin/$BIN_NAME"
    desktop="$PREFIX/share/applications/$DESKTOP_NAME"
    icon_dir="$PREFIX/share/icons/hicolor"

    obtain "$APP_SOURCE" "$APPIMAGE_URL" "Plotina-Lite-Desktop.AppImage"
    appimage="$RESOLVED"

    install -d "$PREFIX/bin" "$(dirname "$desktop")"
    install -m 755 "$appimage" "$bin"

    # Icons + desktop entry come from the image itself (extracted with its own
    # runtime, no FUSE needed for --appimage-extract).
    extract="$TMP/extract"
    mkdir -p "$extract"
    found=0
    if ( cd "$extract" && "$bin" --appimage-extract >>"$TMP/install.log" 2>&1 ); then
        root="$extract/squashfs-root"
        for src_png in "$root"/usr/share/icons/hicolor/*/apps/"$BIN_NAME".png "$root"/icons/*/"$BIN_NAME".png "$root"/*.png; do
            [ -f "$src_png" ] || continue
            case "$src_png" in
                *hicolor*) size="$(basename "$(dirname "$(dirname "$src_png")")")" ;;
                *icons/*)  size="$(basename "$(dirname "$src_png")")" ;;
                *)         size="256x256" ;;
            esac
            install -Dm 644 "$src_png" "$icon_dir/$size/apps/$BIN_NAME.png"
            found=1
        done
    fi

    # Write our own desktop entry pointing at the installed image (the copy
    # inside the image still Exec()s a mount path; electron-builder names the
    # file after executableName, matching deb/rpm).
    src_desktop=""
    for d in "$extract/squashfs-root/$DESKTOP_NAME" "$extract/squashfs-root"/*.desktop; do
        [ -f "$d" ] && src_desktop="$d" && break
    done
    cat > "$desktop" <<EOF
[Desktop Entry]
Name=$APP_NAME
Comment=$APP_COMMENT
Exec="$bin" %U
Terminal=false
Type=Application
Icon=$BIN_NAME
StartupWMClass=$BIN_NAME
Categories=Network;InstantMessaging;Chat;
MimeType=$MIME_TYPES
EOF

    refresh_desktop_db "$PREFIX/share/applications"
    register_schemes "$DESKTOP_NAME"
    return 0
}

case "$MODE" in
    appimage) install_appimage ;;
    deb)  deb_env_available || die "--deb chosen but no apt/dpkg + sudo here"
          install_deb || die "--deb install failed (see the apt/dpkg attempt)" ;;
    auto) if deb_env_available; then
              install_deb || install_appimage
          else
              install_appimage
          fi ;;
    *) die "internal error: mode $MODE" ;;
esac
