#!/usr/bin/env bash
# Install the Plotina Element AppImage for one user and make it the handler for
# the SSO callback scheme. Run as the desktop user, not root.
#
#   scripts/install-appimage.sh ~/Downloads/Plotina-Element.AppImage
#
# AppImages do not register their .desktop file by themselves, so without this
# step the browser keeps opening the upstream Element for io.element.desktop.
set -euo pipefail

APPIMAGE="${1:?usage: install-appimage.sh <Plotina-Element.AppImage>}"
[ -f "$APPIMAGE" ] || { echo "no such file: $APPIMAGE" >&2; exit 1; }
APPIMAGE="$(readlink -f "$APPIMAGE")"

PREFIX="${PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/plotina-element"
DESKTOP="$PREFIX/share/applications/plotina-element.desktop"
ICON_DIR="$PREFIX/share/icons/hicolor"

install -d "$PREFIX/bin" "$(dirname "$DESKTOP")"
install -m 755 "$APPIMAGE" "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && "$BIN" --appimage-extract >/dev/null )

for icon in "$TMP"/squashfs-root/*.png; do
    [ -f "$icon" ] || continue
    name="$(basename "$icon")"
    size=""
    case "$name" in
        *512x512*) size=512 ;;
        *256x256*) size=256 ;;
        *128x128*) size=128 ;;
        *64x64*)   size=64 ;;
        *48x48*)   size=48 ;;
        *32x32*)   size=32 ;;
    esac
    [ -n "$size" ] || continue
    install -Dm 644 "$icon" "$ICON_DIR/${size}x${size}/apps/plotina-element.png"
done

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Name=Plotina Element
Comment=Element for plotina.cc
Exec="$BIN" --no-sandbox %U
Terminal=false
Type=Application
Icon=plotina-element
StartupWMClass=plotina-element
MimeType=x-scheme-handler/io.element.desktop;x-scheme-handler/element;x-scheme-handler/cc.plotina.element;
Categories=Network;InstantMessaging;Chat;
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$PREFIX/share/applications" || true
for scheme in io.element.desktop element cc.plotina.element; do
    xdg-mime default plotina-element.desktop "x-scheme-handler/$scheme"
done

if command -v gio >/dev/null; then
    gio mime x-scheme-handler/io.element.desktop || true
fi

echo "installed: $BIN"
echo "handler:   $DESKTOP"
