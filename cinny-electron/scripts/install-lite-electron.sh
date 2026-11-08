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
#   auto (default): on a Debian-like system (apt-get + dpkg) with working
#     sudo, subscribe the machine to the signed Plotina apt repo (keyring at
#     /usr/share/keyrings/plotina.gpg + /etc/apt/sources.list.d/plotina.list)
#     and install plotina-lite-desktop from it, so future builds arrive with
#     the regular apt upgrade. Otherwise fall back to the AppImage into
#     ${PREFIX:-$HOME/.local}.
#   --deb forces the apt-repo install; it never installs a local file (a
#     positional .deb with --deb is rejected). --appimage forces the AppImage.
#   --dev installs the newest DEV-channel AppImage instead of stable: it
#     fetches https://plotina.cc/dl/dev/lite/latest-lite-linux-dev.yml, takes
#     the first files: entry, downloads that artifact, verifies BOTH sha512
#     (base64 as published, or hex) and size, then installs it through the
#     same AppImage path below. No apt, no GitHub. --dev conflicts with --deb
#     and with a positional file or PLOTINA_LITE_APPIMAGE_URL (the yml is the
#     source). PLOTINA_LITE_DEV_YAML_URL overrides the metadata URL (tests).
#   A positional .deb path/URL is kept as a DEPRECATED direct-file install:
#     the file is installed as-is via apt-get/dpkg and the machine is NOT
#     subscribed to the repo, so apt will not track new builds for it.
#   PLOTINA_LITE_DEB_URL is deprecated: when set it is treated as a
#     positional .deb source. PLOTINA_LITE_APPIMAGE_URL overrides the
#     AppImage download source.
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

APPIMAGE_URL="${PLOTINA_LITE_APPIMAGE_URL:-https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage}"

# Dev-channel metadata (electron-builder yml on our /dl/dev/lite mirror,
# refreshed by the dev CI). --dev reads the first files: entry from it.
# The URL is env-overridable for tests only.
DEV_YAML_URL="${PLOTINA_LITE_DEV_YAML_URL:-https://plotina.cc/dl/dev/lite/latest-lite-linux-dev.yml}"

# Signed flat apt repo for Plotina (https://plotina.cc/apt). The sources
# line is copied verbatim from /apt/README.md; the keyring/list paths are
# env-overridable for tests only — production writes the system files and
# never rewrites an existing one (admin decisions win over re-runs).
APT_PACKAGE="plotina-lite-desktop"
APT_SOURCES_LINE='deb [signed-by=/usr/share/keyrings/plotina.gpg] https://plotina.cc/apt ./'
APT_KEYRING="${PLOTINA_LITE_APT_KEYRING:-/usr/share/keyrings/plotina.gpg}"
APT_LIST="${PLOTINA_LITE_APT_LIST:-/etc/apt/sources.list.d/plotina.list}"
APT_KEY_URL="${PLOTINA_LITE_APT_KEY_URL:-https://plotina.cc/apt/key.gpg}"

BIN_NAME="plotina-lite-desktop"            # executableName in electron-builder config
DESKTOP_NAME="plotina-lite-desktop.desktop"
APP_NAME="Plotina Lite Desktop"
APP_COMMENT="Matrix client for plotina.cc"
MIME_TYPES="x-scheme-handler/cc.plotina.chat;x-scheme-handler/matrix;"

MODE="auto"
DEV_MODE=0           # 1 = --dev: AppImage from the dev-channel yml
DEB_SOURCE=""
APP_SOURCE=""
SUDO_CMD=()

info() { :; }
warn() { :; }
die()  { echo "ERROR: $*" >&2; exit 1; }   # the ONLY output on failure

usage() {
    cat <<'EOF'
Usage: install-lite-electron.sh [--deb|--appimage|--dev] [PATH_or_URL]
  default: Debian/Ubuntu with sudo -> subscribe to the signed Plotina apt
           repo (https://plotina.cc/apt) and install plotina-lite-desktop
           from it; otherwise the AppImage into ${PREFIX:-$HOME/.local}
  --deb      apt-repo install only (never a local .deb file)
  --appimage AppImage only (override: PREFIX=...)
  --dev      newest DEV-channel AppImage via latest-lite-linux-dev.yml:
             the first files: entry is downloaded and verified by sha512
             AND size before installing (same AppImage path); no apt, no
             GitHub; conflicts with --deb, a positional file and
             PLOTINA_LITE_APPIMAGE_URL
  PATH_or_URL  .AppImage source; a .deb file/URL is the DEPRECATED
               direct-file install (no repo subscription)
  PLOTINA_LITE_APPIMAGE_URL      override the AppImage download source
  PLOTINA_LITE_DEV_YAML_URL      override the dev-channel metadata URL (--dev)
  PLOTINA_LITE_DEB_URL           deprecated: treated as a positional .deb source
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --deb)
            [ "$DEV_MODE" = 1 ] && die "--dev and --deb cannot be combined (--dev installs the dev AppImage without apt)"
            [ "$MODE" = "appimage" ] && die "conflicting --deb and --appimage"; MODE="deb" ;;
        --appimage) [ "$MODE" = "deb" ] && die "conflicting --deb and --appimage"; MODE="appimage" ;;
        --dev)
            [ "$MODE" = "deb" ] && die "--dev and --deb cannot be combined (--dev installs the dev AppImage without apt)"
            DEV_MODE=1; MODE="appimage" ;;
        -h|--help) usage; exit 0 ;;
        --*) die "unknown flag: $1" ;;
        *) case "$1" in *.deb) DEB_SOURCE="$1" ;; *) APP_SOURCE="$1" ;; esac ;;
    esac
    shift
done
if [ "$DEV_MODE" = 1 ] && [ -n "$APP_SOURCE" ]; then
    die "--dev takes its source from $DEV_YAML_URL; a positional file ($APP_SOURCE) is not accepted"
fi
if [ "$DEV_MODE" = 1 ] && [ -n "${PLOTINA_LITE_APPIMAGE_URL:-}" ]; then
    die "--dev takes its source from $DEV_YAML_URL; unset PLOTINA_LITE_APPIMAGE_URL"
fi
if [ -n "${PLOTINA_LITE_DEB_URL:-}" ] && [ -z "$DEB_SOURCE" ]; then
    # Default no longer downloads a .deb; keep the old variable as an
    # explicit-file override so existing scripted invocations still work.
    warn "PLOTINA_LITE_DEB_URL is deprecated (packages install from the Plotina apt repo now); treated as an explicit .deb file/URL."
    DEB_SOURCE="$PLOTINA_LITE_DEB_URL"
fi
if [ "$MODE" = "deb" ] && [ -n "$DEB_SOURCE" ]; then
    die "--deb means the apt-repo install; a positional .deb ($DEB_SOURCE) is the deprecated file install — drop --deb to install that file"
fi
if [ "$MODE" = "deb" ] && [ -n "$APP_SOURCE" ]; then
    die "argument '$APP_SOURCE' is not a .deb; --deb installs plotina-lite-desktop from the apt repo"
fi
if [ "$MODE" = "appimage" ] && [ -n "$DEB_SOURCE" ]; then
    die "got a .deb ($DEB_SOURCE) but --appimage was chosen"
fi

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

# --------- dev channel: latest-lite-linux-dev.yml parsing + verification ----
# electron-builder writes the yml; the first files: entry is the current dev
# build. url is absolute but relative forms resolve against the yml folder.
# sha512 is base64 of the raw digest (as published); 128-hex is accepted too.
# size is bytes. Both must match or nothing installs.
parse_dev_yml() {
    # $1: yml file. Sets DEV_URL/DEV_SHA512/DEV_SIZE from the FIRST complete
    # files: entry; returns 1 when they cannot all be found.
    local yml="$1" line t in_files=0
    DEV_URL=""; DEV_SHA512=""; DEV_SIZE=""
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        t="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
        if [ "$in_files" -eq 0 ]; then
            [ "$t" = "files:" ] && in_files=1
            continue
        fi
        # an unindented top-level key ends the files: list
        if [ -n "$t" ] && [ "$line" = "$t" ]; then
            break
        fi
        case "$t" in
            "- url:"*)  [ -n "$DEV_URL" ]    || DEV_URL="${t#*- url:}" ;;
            "sha512:"*) [ -n "$DEV_SHA512" ] || DEV_SHA512="${t#sha512:}" ;;
            "size:"*)   [ -n "$DEV_SIZE" ]   || DEV_SIZE="${t#size:}" ;;
        esac
        DEV_URL="${DEV_URL#"${DEV_URL%%[![:space:]]*}"}"
        DEV_SHA512="${DEV_SHA512#"${DEV_SHA512%%[![:space:]]*}"}"
        DEV_SIZE="${DEV_SIZE#"${DEV_SIZE%%[![:space:]]*}"}"
    done < "$yml"
    case "$DEV_URL" in
        http://*|https://*) ;;
        "") return 1 ;;
        /*) local scheme host
            scheme="${DEV_YAML_URL%%://*}"; host="${DEV_YAML_URL#*://}"; host="${host%%/*}"
            DEV_URL="$scheme://$host$DEV_URL" ;;
        *)  DEV_URL="${DEV_YAML_URL%/*}/$DEV_URL" ;;
    esac
    [ -n "$DEV_URL" ] && [ -n "$DEV_SHA512" ] && [ -n "$DEV_SIZE" ] || return 1
    case "$DEV_SIZE" in
        ''|*[!0-9]*) return 1 ;;
    esac
    return 0
}

sha512_hex_to_b64() {
    # hex digest -> standard base64 in pure bash (no external base64 needed
    # on the user's machine).
    local hex="$1"
    local chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    local -a v=()
    local i n out="" b0 b1 b2 triple o1 o2 o3 o4
    for ((i = 0; i < ${#hex}; i += 2)); do
        v+=( "$(( 16#${hex:i:2} ))" )
    done
    n=${#v[@]}
    for ((i = 0; i < n; i += 3)); do
        b0=${v[i]}; b1=${v[i + 1]:-0}; b2=${v[i + 2]:-0}
        triple=$(( (b0 << 16) | (b1 << 8) | b2 ))
        o1=$(( (triple >> 18) & 63 )); o2=$(( (triple >> 12) & 63 ))
        o3=$(( (triple >> 6) & 63 ));  o4=$(( triple & 63 ))
        out+="${chars:o1:1}${chars:o2:1}"
        if (( i + 1 < n )); then out+="${chars:o3:1}"; else out+="="; fi
        if (( i + 2 < n )); then out+="${chars:o4:1}"; else out+="="; fi
    done
    printf '%s' "$out"
}

verify_dev_artifact() {
    # $1: file, $2: expected sha512 (base64 or hex), $3: expected size.
    # 0 = both match; 1 = refusal, reason in DEV_VERIFY_REASON.
    local file="$1" want="$2" want_size="$3"
    DEV_VERIFY_REASON=""
    command -v sha512sum >/dev/null 2>&1 || { DEV_VERIFY_REASON="sha512sum not found in PATH"; return 1; }
    local size actual_hex want_cmp actual_cmp
    size="$(wc -c < "$file")"
    size="${size//[[:space:]]/}"
    if [ "$size" != "$want_size" ]; then
        DEV_VERIFY_REASON="size $size != $want_size from the yml"
        return 1
    fi
    actual_hex="$(sha512sum -- "$file")"
    actual_hex="${actual_hex%% *}"
    actual_hex="${actual_hex,,}"
    if [[ "$want" =~ ^[0-9a-fA-F]{128}$ ]]; then
        want_cmp="${want,,}"; actual_cmp="$actual_hex"
    elif [[ "$want" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
        want_cmp="$want"; actual_cmp="$(sha512_hex_to_b64 "$actual_hex")"
    else
        DEV_VERIFY_REASON="sha512 in the yml is neither base64 nor hex: $want"
        return 1
    fi
    if [ "$want_cmp" != "$actual_cmp" ]; then
        DEV_VERIFY_REASON="sha512 mismatch (expected $want)"
        return 1
    fi
    return 0
}

dev_resolve_appimage() {
    # --dev: yml -> first files: entry -> download -> sha512+size -> RESOLVED.
    # Any mismatch is fatal: a refused dev artifact never falls back to stable.
    download "$DEV_YAML_URL" "$TMP/latest-lite-linux-dev.yml" \
        || die "download failed: $DEV_YAML_URL"
    parse_dev_yml "$TMP/latest-lite-linux-dev.yml" \
        || die "no complete first files: entry (url/sha512/size) in $DEV_YAML_URL"
    download "$DEV_URL" "$TMP/dev-Plotina-Lite-Desktop.AppImage" \
        || die "download failed: $DEV_URL"
    verify_dev_artifact "$TMP/dev-Plotina-Lite-Desktop.AppImage" "$DEV_SHA512" "$DEV_SIZE" \
        || die "dev artifact refused: $DEV_URL — $DEV_VERIFY_REASON; nothing installed"
    RESOLVED="$TMP/dev-Plotina-Lite-Desktop.AppImage"
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

# Atomic system-file write: stage next to the target and rename in place, so
# apt sees either the old file or the complete new one, never a torn write.
apt_install_file() {
    local tmp="$1" dst="$2" mode="$3"
    # shellcheck disable=SC2016  # $1..$3/$$ are expanded by the inner sh, not here
    "${SUDO_CMD[@]}" sh -c '
        set -eu
        install -d -m 755 "$(dirname "$2")"
        cp "$1" "$2.plotina-new.$$"
        chmod "$3" "$2.plotina-new.$$"
        mv -f "$2.plotina-new.$$" "$2"
    ' _ "$tmp" "$dst" "$mode" >>"$TMP/install.log" 2>&1
}

apt_repo_configure() {
    if [ ! -f "$APT_KEYRING" ]; then
        download "$APT_KEY_URL" "$TMP/plotina.gpg" || { warn "cannot download $APT_KEY_URL"; return 1; }
        [ -s "$TMP/plotina.gpg" ] || { warn "empty key file: $APT_KEY_URL"; return 1; }
        # If gpg exists, verify we fetched a parseable public key (not an
        # HTML error page). The fingerprint is deliberately not pinned: a
        # key rotation on the server must not brick shipped installers.
        if command -v gpg >/dev/null 2>&1; then
            if ! gpg --batch --no-tty --show-keys --with-colons "$TMP/plotina.gpg" 2>/dev/null | grep -q '^pub:'; then
                warn "downloaded file is not a parseable public key; refusing to write it"
                return 1
            fi
        fi
        apt_install_file "$TMP/plotina.gpg" "$APT_KEYRING" 644 || {
            warn "cannot install keyring: $APT_KEYRING"; return 1; }
    fi
    if [ ! -f "$APT_LIST" ]; then
        printf '%s\n' "$APT_SOURCES_LINE" > "$TMP/plotina.list"
        apt_install_file "$TMP/plotina.list" "$APT_LIST" 644 || {
            warn "cannot install sources list: $APT_LIST"; return 1; }
    fi
    # A full update may fail on someone else's broken third-party repo; that
    # is not fatal — apt-get install below is the real gate.
    DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get update >>"$TMP/install.log" 2>&1 \
        || warn "apt-get update returned non-zero; trying the install anyway"
    return 0
}

install_from_repo() {
    apt_repo_configure || return 1
    if ! DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get install -y "$APT_PACKAGE" >>"$TMP/install.log" 2>&1; then
        warn "apt-get install -y $APT_PACKAGE failed"
        return 1
    fi
    info "plotina-lite-desktop installed from the Plotina apt repo"
    if [ ! -f "/usr/share/applications/$DESKTOP_NAME" ]; then
        warn "no $DESKTOP_NAME in /usr/share/applications after repo install"
    fi
    refresh_desktop_db "/usr/share/applications"
    register_schemes "$DESKTOP_NAME"
    return 0
}

# DEPRECATED path: install one specific .deb file (positional argument or
# PLOTINA_LITE_DEB_URL). No repo subscription happens on this path.
install_deb_file() {
    local deb
    obtain "$DEB_SOURCE" "" "Plotina-Lite-Desktop.deb"
    deb="$RESOLVED"
    if DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get install -y "$deb" >>"$TMP/install.log" 2>&1; then
        info "deb installed via apt-get"
    elif "${SUDO_CMD[@]}" dpkg -i "$deb" >>"$TMP/install.log" 2>&1 \
      && DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get -f install -y >>"$TMP/install.log" 2>&1; then
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
    local appimage bin desktop icon_dir extract src_png size
    PREFIX="${PREFIX:-$HOME/.local}"
    bin="$PREFIX/bin/$BIN_NAME"
    desktop="$PREFIX/share/applications/$DESKTOP_NAME"
    icon_dir="$PREFIX/share/icons/hicolor"

    # --dev: verified dev-channel artifact from the yml; the stable URL and a
    # positional file are not used here (both rejected during arg parsing).
    if [ "$DEV_MODE" = 1 ]; then
        dev_resolve_appimage
    else
        obtain "$APP_SOURCE" "$APPIMAGE_URL" "Plotina-Lite-Desktop.AppImage"
    fi
    appimage="$RESOLVED"

    install -d "$PREFIX/bin" "$(dirname "$desktop")"
    install -m 755 "$appimage" "$bin"

    # Icons + desktop entry come from the image itself (extracted with its own
    # runtime, no FUSE needed for --appimage-extract).
    extract="$TMP/extract"
    mkdir -p "$extract"
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
        done
    fi

    # Write our own desktop entry pointing at the installed image (the copy
    # inside the image still Exec()s a mount path; electron-builder names the
    # file after executableName, matching deb/rpm).
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
          install_from_repo || die "--deb repo install of $APT_PACKAGE failed (see the apt attempt)" ;;
    auto) if deb_env_available; then
              if [ -n "$DEB_SOURCE" ]; then
                  install_deb_file || install_appimage
              else
                  install_from_repo || install_appimage
              fi
          else
              [ -n "$DEB_SOURCE" ] && die "got a .deb file ($DEB_SOURCE) but no apt/dpkg + sudo here"
              install_appimage
          fi ;;
    *) die "internal error: mode $MODE" ;;
esac
