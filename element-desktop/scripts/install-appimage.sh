#!/usr/bin/env bash
# Универсальный установщик Plotina Desktop для Linux (self-contained).
#
# Можно запускать без репозитория и без аргументов:
#   curl -fsSL https://plotina.cc/dl/Plotina-Desktop-install.sh | bash
#
# Выбор пакета:
#   * по умолчанию (auto): если это Debian-подобная система (apt-get + dpkg)
#     и есть доступ к sudo (root, беспарольный sudo или интерактивный ввод
#     пароля) — скачивается и ставится .deb через sudo apt-get install;
#   * если .deb поставить нельзя (не Debian, нет sudo, пользователь отказал,
#     apt не смог) — ставится AppImage в ${PREFIX:-$HOME/.local};
#   * --deb / --appimage — принудительный выбор способа;
#   * позиционный аргумент — путь к файлу или URL (.deb или .AppImage);
#     файл по пути берётся как есть, без перекачивания;
#   * URL переопределяются окружением: PLOTINA_DEB_URL, PLOTINA_APPIMAGE_URL.
#
# AppImage сам не регистрирует .desktop, поэтому установщик закрепляет за
# Plotina Desktop схему SSO-колбэка io.element.desktop — без этого шага
# браузер продолжит открывать ссылки SSO в upstream Element.
set -euo pipefail

# =================== константы текущего релиза ==============================
# При каждом новом релизе заменить тег vX.Y.Z-plotina-element.NN в обоих URL
# на новый из https://github.com/plotina-cc/clients/releases — или не трогать
# скрипт и задать окружение:
#   PLOTINA_DEB_URL=... PLOTINA_APPIMAGE_URL=... install-appimage.sh
DEFAULT_DEB_URL="https://github.com/plotina-cc/clients/releases/download/v1.12.32-plotina-element.19/Plotina-Desktop.deb"
DEFAULT_APPIMAGE_URL="https://github.com/plotina-cc/clients/releases/download/v1.12.32-plotina-element.19/Plotina-Desktop.AppImage"
# ============================================================================

DEB_URL="${PLOTINA_DEB_URL:-$DEFAULT_DEB_URL}"
APPIMAGE_URL="${PLOTINA_APPIMAGE_URL:-$DEFAULT_APPIMAGE_URL}"

SCHEME="io.element.desktop"
DESKTOP_NAME="plotina-desktop.desktop"

MODE="auto"          # auto | deb | appimage
DEB_SOURCE=""        # явный путь/URL для .deb
APP_SOURCE=""        # явный путь/URL для AppImage
SUDO_CMD=()          # (sudo) или пусто, если прав root хватает

info() { echo "$*"; }
warn() { echo "ПРЕДУПРЕЖДЕНИЕ: $*" >&2; }
die()  { echo "ОШИБКА: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Использование: install-appimage.sh [--deb|--appimage] [ПУТЬ_или_URL]

  без аргументов       выбрать способ автоматически (сначала .deb, иначе AppImage)
  --deb                ставить только .deb (через apt-get/dpkg + sudo)
  --appimage           ставить только AppImage в ~/.local (override: PREFIX=...)
  ПУТЬ_или_URL         конкретный пакет (.deb или .AppImage) вместо скачивания
  PLOTINA_DEB_URL / PLOTINA_APPIMAGE_URL   переопределить URL скачивания
EOF
}

# --------- разбор аргументов ------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --deb)
            [ "$MODE" = "appimage" ] && die "нельзя одновременно --deb и --appimage"
            MODE="deb"
            ;;
        --appimage)
            [ "$MODE" = "deb" ] && die "нельзя одновременно --deb и --appimage"
            MODE="appimage"
            ;;
        -h|--help)  usage; exit 0 ;;
        --*)        die "неизвестный флаг: $1" ;;
        *)
            case "$1" in
                *.deb) DEB_SOURCE="$1" ;;
                *)     APP_SOURCE="$1" ;;
            esac
            ;;
    esac
    shift
done
if [ "$MODE" = "deb" ] && [ -n "$APP_SOURCE" ]; then
    die "аргумент '$APP_SOURCE' не .deb; для AppImage уберите --deb"
fi
if [ "$MODE" = "appimage" ] && [ -n "$DEB_SOURCE" ]; then
    die "передан .deb, но выбран режим --appimage"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --------- скачивание: 2 попытки, curl -fSL --retry 2 ------------------------
download() {
    local url="$1" dest="$2" attempt
    for attempt in 1 2; do
        if curl -fSL --retry 2 -o "$dest" "$url"; then
            return 0
        fi
        warn "попытка ${attempt}/2 не удалась: $url"
    done
    return 1
}

# RESOLVED = путь к файлу: взять переданный путь как есть, или скачать
# явный URL, или скачать URL по умолчанию.
RESOLVED=""
obtain() {
    local src="$1" url="$2" name="$3"
    if [ -n "$src" ]; then
        case "$src" in
            http://*|https://*)
                info "Скачиваю: $src"
                download "$src" "$TMP/$name" || die "не удалось скачать: $src"
                RESOLVED="$TMP/$name"
                ;;
            *)
                [ -f "$src" ] || die "файл не найден: $src"
                RESOLVED="$src"
                ;;
        esac
    else
        info "Скачиваю: $url"
        download "$url" "$TMP/$name" || die "не удалось скачать: $url"
        RESOLVED="$TMP/$name"
    fi
}

# --------- регистрация схемы и .desktop-кэша: warn-but-continue --------------
# never die: в headless-сессии (curl | bash) xdg-settings может отсутствовать
# или падать — это предупреждение, а не ошибка установки.
register_handler() {
    local data_root="$1" rc=0 dirs
    if [ "$data_root" = "/usr/share" ]; then
        dirs="$data_root"
    else
        dirs="$data_root:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    fi

    if command -v xdg-settings >/dev/null 2>&1; then
        rc=0
        XDG_DATA_DIRS="$dirs" xdg-settings set default-url-scheme-handler \
            "$SCHEME" "$DESKTOP_NAME" 2>/dev/null || rc=$?
        if [ "$rc" -eq 0 ]; then
            info "Схема $SCHEME закреплена за $DESKTOP_NAME."
        else
            warn "xdg-settings завершился с кодом $rc (headless-сессия?) — схему $SCHEME надо назначить вручную; установка не сломана."
        fi
    else
        warn "xdg-settings не найден — схему $SCHEME надо назначить вручную; установка не сломана."
    fi

    if command -v update-desktop-database >/dev/null 2>&1; then
        rc=0
        "${SUDO_CMD[@]}" update-desktop-database "$data_root/applications" 2>/dev/null || rc=$?
        if [ "$rc" -ne 0 ]; then
            warn "update-desktop-database завершился с кодом $rc — меню может обновиться позже; установка не сломана."
        fi
    else
        warn "update-desktop-database не найден — пропускаю."
    fi
}

# --------- доступность .deb-пути: Debian-окружение + sudo --------------------
DEB_REASON=""
deb_env_available() {
    DEB_REASON=""
    SUDO_CMD=()
    if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
        DEB_REASON="apt-get/dpkg не найдены (не Debian-подобная система)"
        return 1
    fi
    if [ "$(id -u)" -eq 0 ]; then
        return 0
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        DEB_REASON="sudo не установлен"
        return 1
    fi
    if sudo -n true 2>/dev/null; then
        SUDO_CMD=(sudo)
        return 0
    fi
    if [ -t 0 ]; then
        info "Для установки .deb нужен sudo — введите пароль (или прервите, чтобы поставить AppImage)."
        if sudo -v; then
            SUDO_CMD=(sudo)
            return 0
        fi
        DEB_REASON="пользователь отказал или пароль не принят"
        return 1
    fi
    DEB_REASON="нет беспарольного sudo и сессия неинтерактивная (например, curl | bash)"
    return 1
}

# --------- путь 1: .deb через apt-get/dpkg -----------------------------------
install_deb() {
    local deb
    obtain "$DEB_SOURCE" "$DEB_URL" "Plotina-Desktop.deb"
    deb="$RESOLVED"
    if "${SUDO_CMD[@]}" apt-get install -y "$deb"; then
        info "Пакет .deb установлен через apt-get."
    elif "${SUDO_CMD[@]}" dpkg -i "$deb" && "${SUDO_CMD[@]}" apt-get -f install -y; then
        warn "apt-get install не прошёл (зависимости?) — установил через dpkg -i + apt-get -f install."
    else
        warn "apt-get и dpkg не смогли установить $deb."
        return 1
    fi
    if [ ! -f "/usr/share/applications/$DESKTOP_NAME" ]; then
        warn "После deb-установки не найден /usr/share/applications/$DESKTOP_NAME — проверьте имя .desktop в пакете."
    fi
    register_handler "/usr/share"
}

# --------- путь 2: AppImage в PREFIX ------------------------------------------
install_appimage() {
    local appimage bin desktop icon_dir extract size name icon
    PREFIX="${PREFIX:-$HOME/.local}"
    bin="$PREFIX/bin/plotina-desktop"
    desktop="$PREFIX/share/applications/$DESKTOP_NAME"
    icon_dir="$PREFIX/share/icons/hicolor"

    obtain "$APP_SOURCE" "$APPIMAGE_URL" "Plotina-Desktop.AppImage"
    appimage="$RESOLVED"

    install -d "$PREFIX/bin" "$(dirname "$desktop")"
    install -m 755 "$appimage" "$bin"
    info "Установлен бинарник: $bin"

    # Иконки берём из --appimage-extract; если распаковка не удалась (например,
    # передан неподходящий файл) — пропускаем иконки, но не роняем установку.
    extract="$TMP/extract"
    mkdir -p "$extract"
    if ( cd "$extract" && "$bin" --appimage-extract >/dev/null 2>&1 ); then
        for icon in "$extract"/squashfs-root/*.png; do
            [ -f "$icon" ] || continue
            name="${icon##*/}"
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
            install -Dm 644 "$icon" "$icon_dir/${size}x${size}/apps/plotina-desktop.png"
        done
        # Один plain plotina-desktop.png считаем иконкой максимального размера.
        if [ ! -f "$icon_dir/512x512/apps/plotina-desktop.png" ] \
           && [ -f "$extract/squashfs-root/plotina-desktop.png" ]; then
            install -Dm 644 "$extract/squashfs-root/plotina-desktop.png" \
                "$icon_dir/512x512/apps/plotina-desktop.png"
        fi
    else
        warn "не удалось извлечь иконки (--appimage-extract) — пропускаю; приложение установится без иконок."
    fi

    cat > "$desktop" <<EOF
[Desktop Entry]
Name=Plotina Desktop
Comment=Element for plotina.cc
Exec="$bin" --no-sandbox %U
Terminal=false
Type=Application
Icon=plotina-desktop
StartupWMClass=plotina-desktop
MimeType=x-scheme-handler/$SCHEME;x-scheme-handler/element;x-scheme-handler/cc.plotina.element;
Categories=Network;InstantMessaging;Chat;
EOF
    info "Ярлык: $desktop"

    register_handler "$PREFIX/share"
}

# --------- основной выбор -----------------------------------------------------
case "$MODE" in
    appimage)
        install_appimage
        ;;
    deb)
        deb_env_available || die "выбран --deb, но: $DEB_REASON"
        install_deb || die "выбран --deb, но установка пакета не удалась"
        ;;
    auto)
        if deb_env_available; then
            if ! install_deb; then
                warn "не удалось поставить .deb — перехожу на AppImage"
                install_appimage
            fi
        else
            warn "не ставлю .deb: $DEB_REASON — ставлю AppImage в ${PREFIX:-$HOME/.local}"
            install_appimage
        fi
        ;;
    *)
        die "внутренняя ошибка: неизвестный режим $MODE"
        ;;
esac

echo "Вход через SSO из браузера теперь открывается в Plotina Desktop."
