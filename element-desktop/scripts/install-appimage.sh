#!/usr/bin/env bash
# Универсальный установщик Plotina Desktop для Linux (self-contained).
#
# Можно запускать без репозитория и без аргументов:
#   curl -fsSL https://plotina.cc/dl/Plotina-Desktop-install.sh | bash
#
# Выбор пакета:
#   * по умолчанию (auto): если это Debian-подобная система (apt-get + dpkg)
#     и есть доступ к sudo (root, беспарольный sudo или интерактивный ввод
#     пароля) — система подписывается на подписанный apt-репозиторий Plotina
#     (ключ в keyring + /etc/apt/sources.list.d/plotina.list) и
#     plotina-desktop ставится из него через apt-get: дальше обновления
#     приходят с обычным apt-get update && apt-get upgrade;
#   * если репозиторий недоступен (не Debian, нет sudo, пользователь отказал,
#     apt или сеть подвели) — ставится AppImage в ${PREFIX:-$HOME/.local};
#   * --deb — ТОЛЬКО установка из apt-репозитория (никакого локального .deb:
#     позиционный .deb с --deb запрещён);
#   * --appimage — только AppImage в ~/.local (override: PREFIX=...);
#   * --dev — AppImage в ~/.local, но из DEV-канала: скачивается
#     latest-linux-dev.yml с /dl/dev/desktop, берётся первый files: вход,
#     артефакт проверяется по sha512 И size и только затем ставится тем же
#     AppImage-путём (desktop-файл/иконки/бинарь). Без apt и без GitHub;
#     с --deb несовместим, позиционный файл и PLOTINA_APPIMAGE_URL с --dev
#     запрещены — источник задаёт yml;
#   * позиционный аргумент — путь или URL: .AppImage для AppImage-пути,
#     .deb — устаревшая явная установка конкретного файла через apt-get/dpkg
#     (файл ставится как есть, но система НЕ подписывается на репозиторий,
#     и apt не будет обновлять такой пакет как пакет из репозитория);
#   * PLOTINA_DEB_URL устарела: если задана, трактуется как позиционный .deb;
#   * PLOTINA_APPIMAGE_URL переопределяет URL скачивания AppImage.
#
# AppImage сам не регистрирует .desktop, поэтому установщик закрепляет за
# Plotina Desktop схему SSO-колбэка io.element.desktop — без этого шага
# браузер продолжит открывать ссылки SSO в upstream Element.
set -euo pipefail

# =================== откуда берём сборку ====================================
# AppImage-фолбэк отдаётся стабильным именем с нашего зеркала /dl (его
# обновляет pull-release.py), а не тегом релиза. Сам .deb по умолчанию
# больше НЕ скачивается: на Debian/Ubuntu пакет ставится из подписанного
# apt-репозитория https://plotina.cc/apt — подпиской на него установщик и
# занимается (строки репозитория — ровно из /apt/README.md). Пути keyring и
# sources-list переопределяются только ради тестов; в проде это системные
# файлы, и их содержимое (включая signed-by) не меняется.
#   PLOTINA_APPIMAGE_URL=... install-appimage.sh
DEFAULT_APPIMAGE_URL="https://plotina.cc/dl/Plotina-Desktop.AppImage"
APPIMAGE_URL="${PLOTINA_APPIMAGE_URL:-$DEFAULT_APPIMAGE_URL}"
# Dev-канал: electron-builder yml с нашего зеркала /dl/dev/desktop (его
# обновляет CI dev-сборки). --dev скачивает этот yml, берёт ПЕРВЫЙ вход
# files: (url/sha512/size), проверяет артефакт по ОБОИМ значениям и ставит
# его AppImage-путём. yml-адрес переопределяется только ради тестов.
DEFAULT_DEV_YAML_URL="https://plotina.cc/dl/dev/desktop/latest-linux-dev.yml"
DEV_YAML_URL="${PLOTINA_DEV_YAML_URL:-$DEFAULT_DEV_YAML_URL}"

APT_PACKAGE="plotina-desktop"
APT_SOURCES_LINE='deb [signed-by=/usr/share/keyrings/plotina.gpg] https://plotina.cc/apt ./'
APT_KEYRING="${PLOTINA_APT_KEYRING:-/usr/share/keyrings/plotina.gpg}"
APT_LIST="${PLOTINA_APT_LIST:-/etc/apt/sources.list.d/plotina.list}"
APT_KEY_URL="${PLOTINA_APT_KEY_URL:-https://plotina.cc/apt/key.gpg}"
# ============================================================================

SCHEME="io.element.desktop"
DESKTOP_NAME="plotina-desktop.desktop"

MODE="auto"          # auto | deb (apt-репозиторий) | appimage
DEV_MODE=0           # 1 = --dev: AppImage из dev-канала (latest-linux-dev.yml)
DEB_SOURCE=""        # устаревшее: явный путь/URL для .deb-файла
APP_SOURCE=""        # явный путь/URL для AppImage
SUDO_CMD=()          # (sudo) или пусто, если прав root хватает

info() { :; }
warn() { :; }
die()  { echo "ОШИБКА: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Использование: install-appimage.sh [--deb|--appimage|--dev] [ПУТЬ_или_URL]

  без аргументов       на Debian/Ubuntu с sudo — подписка на apt-репозиторий
                       Plotina и установка plotina-desktop из него;
                       иначе AppImage в ${PREFIX:-$HOME/.local}
  --deb                только установка из apt-репозитория (ключ +
                       /etc/apt/sources.list.d/plotina.list + apt-get install;
                       позиционный .deb с --deb запрещён)
  --appimage           ставить только AppImage в ~/.local (override: PREFIX=...)
  --dev                AppImage в ~/.local из DEV-канала: первый files: вход
                       latest-linux-dev.yml (url/sha512/size), артефакт
                       проверяется по sha512 и размеру; без apt и без GitHub.
                       Несовместимо с --deb, позиционным файлом и
                       PLOTINA_APPIMAGE_URL
  ПУТЬ_или_URL         .AppImage для AppImage-пути; .deb — устаревшая явная
                       установка конкретного файла (без подписки на репозиторий)
  PLOTINA_APPIMAGE_URL                    переопределить URL AppImage
  PLOTINA_DEV_YAML_URL                    переопределить yml dev-канала для --dev
  PLOTINA_DEB_URL                         устарело: трактуется как позиционный .deb
EOF
}

# --------- разбор аргументов ------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --deb)
            [ "$DEV_MODE" = 1 ] && die "--dev и --deb вместе нельзя: --dev ставит AppImage из dev-канала без apt"
            [ "$MODE" = "appimage" ] && die "нельзя одновременно --deb и --appimage"
            MODE="deb"
            ;;
        --appimage)
            [ "$MODE" = "deb" ] && die "нельзя одновременно --deb и --appimage"
            MODE="appimage"
            ;;
        --dev)
            [ "$MODE" = "deb" ] && die "--dev и --deb вместе нельзя: --dev ставит AppImage из dev-канала без apt"
            MODE="appimage"
            DEV_MODE=1
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
if [ "$DEV_MODE" = 1 ] && [ -n "$APP_SOURCE" ]; then
    die "--dev берёт AppImage из $DEV_YAML_URL; позиционный файл ($APP_SOURCE) с ним запрещён"
fi
if [ "$DEV_MODE" = 1 ] && [ -n "${PLOTINA_APPIMAGE_URL:-}" ]; then
    die "--dev берёт AppImage из $DEV_YAML_URL; снимите PLOTINA_APPIMAGE_URL"
fi
if [ -n "${PLOTINA_DEB_URL:-}" ] && [ -z "$DEB_SOURCE" ]; then
    # Устаревшее поведение (дефолт ставил .deb скачиванием) убран; переменная
    # сохранена как явный файл-оверрайд для старых вызовов.
    warn "PLOTINA_DEB_URL устарела: по умолчанию пакет ставится из apt-репозитория Plotina; переменная трактуется как явный .deb-файл/URL."
    DEB_SOURCE="$PLOTINA_DEB_URL"
fi
if [ "$MODE" = "deb" ] && [ -n "$APP_SOURCE" ]; then
    die "аргумент '$APP_SOURCE' не .deb; --deb — это установка из apt-репозитория"
fi
if [ "$MODE" = "deb" ] && [ -n "$DEB_SOURCE" ]; then
    die "--deb означает установку из apt-репозитория; позиционный .deb ($DEB_SOURCE) задан ради устаревшей файловой установки — уберите --deb"
fi
if [ "$MODE" = "appimage" ] && [ -n "$DEB_SOURCE" ]; then
    die "передан .deb, но выбран режим --appimage"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --------- скачивание: 2 попытки, curl -fsSL --retry 2 ------------------------
download() {
    local url="$1" dest="$2" attempt
    for attempt in 1 2; do
        if curl -fsSL --retry 2 -o "$dest" "$url"; then
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

# --------- dev-канал: разбор latest-linux-dev.yml и проверка артефакта ------
# electron-builder пишет yml сам; первый вход files: — актуальная dev-сборка.
# url в yml абсолютный, но умеем и относительный (resolved от папки yml).
# sha512 — base64 от сырого дайджеста (электрон-builder именно так и делает);
# hex-форма тоже принимается. size — байты.
parse_dev_yml() {
    # $1: yml-файл. Заполняет DEV_URL/DEV_SHA512/DEV_SIZE; 0, если нашёлся
    # полный ПЕРВЫЙ вход files:, иначе 1.
    local yml="$1" line t in_files=0
    DEV_URL=""; DEV_SHA512=""; DEV_SIZE=""
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        t="${line#"${line%%[![:space:]]*}"}"   # leading whitespace strip
        if [ "$in_files" -eq 0 ]; then
            [ "$t" = "files:" ] && in_files=1
            continue
        fi
        # неотступленный ключ нулевого уровня закрывает список files:
        if [ -n "$t" ] && [ "$line" = "$t" ]; then
            break
        fi
        case "$t" in
            "- url:"*)  [ -n "$DEV_URL" ]    || DEV_URL="${t#*- url:}" ;;
            "sha512:"*) [ -n "$DEV_SHA512" ] || DEV_SHA512="${t#sha512:}" ;;
            "size:"*)   [ -n "$DEV_SIZE" ]   || DEV_SIZE="${t#size:}" ;;
        esac
        # ведущие пробелы значений (case-метки схлопнуты руками выше)
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
    # hex-дайджест -> стандартный base64 чистим bash'ом (внешний base64 не
    # обязателен на машине пользователя).
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
    # $1: файл, $2: ожидаемый sha512 (base64 или hex), $3: ожидаемый размер.
    # 0 — совпало и sha512, и size; 1 — отказ, причина в DEV_VERIFY_REASON.
    local file="$1" want="$2" want_size="$3"
    DEV_VERIFY_REASON=""
    command -v sha512sum >/dev/null 2>&1 || { DEV_VERIFY_REASON="нет sha512sum в PATH"; return 1; }
    local size actual_hex want_cmp actual_cmp
    size="$(wc -c < "$file")"
    size="${size//[[:space:]]/}"
    if [ "$size" != "$want_size" ]; then
        DEV_VERIFY_REASON="размер $size != ${want_size} из yml"
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
        DEV_VERIFY_REASON="sha512 в yml не похож на base64/hex: $want"
        return 1
    fi
    if [ "$want_cmp" != "$actual_cmp" ]; then
        DEV_VERIFY_REASON="sha512 не совпал (ожидался $want)"
        return 1
    fi
    return 0
}

dev_resolve_appimage() {
    # --dev: yml -> первый files: вход -> скачивание -> sha512+size -> RESOLVED.
    # Отказ (die) на любой нестыковке: dev-артефакт НЕ заменяется стабильным.
    info "Dev-метаданные: $DEV_YAML_URL"
    download "$DEV_YAML_URL" "$TMP/latest-linux-dev.yml" \
        || die "не удалось скачать dev-метаданные: $DEV_YAML_URL"
    parse_dev_yml "$TMP/latest-linux-dev.yml" \
        || die "в $DEV_YAML_URL нет полного первого входа files: (url/sha512/size)"
    info "Dev-сборка: $DEV_URL (size=$DEV_SIZE)"
    download "$DEV_URL" "$TMP/dev-Plotina-Desktop.AppImage" \
        || die "не удалось скачать dev-артефакт: $DEV_URL"
    verify_dev_artifact "$TMP/dev-Plotina-Desktop.AppImage" "$DEV_SHA512" "$DEV_SIZE" \
        || die "dev-артефакт не прошёл проверку: $DEV_URL — $DEV_VERIFY_REASON; ничего не установлено"
    RESOLVED="$TMP/dev-Plotina-Desktop.AppImage"
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

# --------- доступность apt-пути: Debian-окружение + sudo --------------------
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
        info "Для установки из apt-репозитория нужен sudo — введите пароль (или прервите, чтобы поставить AppImage)."
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

# --------- путь 1: apt-репозиторий Plotina -----------------------------------
# Атомарная запись системного файла: копируем готовый temp рядом с целью и
# переименовываем на месте (mv в пределах ФС атомарен); назначение видит или
# старый файл, или полностью новый, никогда — полускечь.
apt_install_file() {
    local tmp="$1" dst="$2" mode="$3"
    # shellcheck disable=SC2016  # $1..$3/$$ раскрывает inner sh, не outer bash
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
        info "Скачиваю ключ репозитория: $APT_KEY_URL"
        if ! download "$APT_KEY_URL" "$TMP/plotina.gpg"; then
            warn "не удалось скачать $APT_KEY_URL"
            return 1
        fi
        [ -s "$TMP/plotina.gpg" ] || { warn "пустой файл ключа: $APT_KEY_URL"; return 1; }
        # Если gpg есть — убеждаемся, что скачали разбираемый публичный ключ,
        # а не HTML-заглушку; отпечаток не пинним, чтобы ротация ключа на
        # сервере не ломала уже распространённые установщики.
        if command -v gpg >/dev/null 2>&1; then
            if ! gpg --batch --no-tty --show-keys --with-colons "$TMP/plotina.gpg" 2>/dev/null | grep -q '^pub:'; then
                warn "скачанный файл не разбирается как публичный ключ — ничего не записываю"
                return 1
            fi
        fi
        apt_install_file "$TMP/plotina.gpg" "$APT_KEYRING" 644 || {
            warn "не удалось установить keyring: $APT_KEYRING"
            return 1
        }
    fi
    if [ ! -f "$APT_LIST" ]; then
        printf '%s\n' "$APT_SOURCES_LINE" > "$TMP/plotina.list"
        apt_install_file "$TMP/plotina.list" "$APT_LIST" 644 || {
            warn "не удалось установить sources-list: $APT_LIST"
            return 1
        }
    fi
    # Полный update может упасть из-за чужих сломанных репозиториев — это не
    # повод сдаваться: настоящим решением будет apt-get install ниже.
    DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get update >>"$TMP/install.log" 2>&1 \
        || warn "apt-get update завершился с ошибкой (чужие репозитории?) — пробую установку пакета"
    return 0
}

install_from_repo() {
    apt_repo_configure || return 1
    if ! DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get install -y "$APT_PACKAGE" >>"$TMP/install.log" 2>&1; then
        warn "apt-get install -y $APT_PACKAGE не прошёл"
        return 1
    fi
    info "$APT_PACKAGE установлен из apt-репозитория https://plotina.cc/apt."
    if [ ! -f "/usr/share/applications/$DESKTOP_NAME" ]; then
        warn "После установки из репозитория не найден /usr/share/applications/$DESKTOP_NAME — проверьте имя .desktop в пакете."
    fi
    register_handler "/usr/share"
}

# --------- устаревший путь: конкретный .deb-файл (позиционный аргумент) ------
# Сохранён для совместимости со старыми вызовами. НЕ подписывает систему на
# репозиторий, и дальше такой пакет apt обновляет как локально поставленный.
install_deb_file() {
    local deb
    obtain "$DEB_SOURCE" "" "Plotina-Desktop.deb"
    deb="$RESOLVED"
    if DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get install -y "$deb" >>"$TMP/install.log" 2>&1; then
        info "Пакет .deb установлен через apt-get."
    elif "${SUDO_CMD[@]}" dpkg -i "$deb" >>"$TMP/install.log" 2>&1 && DEBIAN_FRONTEND=noninteractive "${SUDO_CMD[@]}" apt-get -f install -y >>"$TMP/install.log" 2>&1; then
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

    # --dev: берём dev-артефакт из latest-linux-dev.yml с проверкой sha512 и
    # размера; стабильный URL/позиционный файл здесь не участвуют (позиционный
    # с --dev запрещён на разборе аргументов).
    if [ "$DEV_MODE" = 1 ]; then
        dev_resolve_appimage
    else
        obtain "$APP_SOURCE" "$APPIMAGE_URL" "Plotina-Desktop.AppImage"
    fi
    appimage="$RESOLVED"

    install -d "$PREFIX/bin" "$(dirname "$desktop")"
    install -m 755 "$appimage" "$bin"
    info "Установлен бинарник: $bin"

    # Иконки берём из --appimage-extract. Начиная с .38 AppImage несёт их в
    # squashfs-root/usr/share/icons/hicolor/<size>/apps/plotina-desktop.png
    # (16..512); копируем все размеры как есть, чтобы KDE/Breeze выбирал
    # подходящий (в т.ч. для Wayland, где _NET_WM_ICON не используется).
    # Старые образы (<= .36) лежали только в usr/share/.../512x512 — тот же
    # цикл забирает и их; если же и там пусто (ручная раскладка с png в
    # корне), фолбэк берёт корневой plotina-desktop.png как 512.
    # Если распаковка не удалась (например, передан неподходящий файл) —
    # пропускаем иконки, но не роняем установку.
    extract="$TMP/extract"
    mkdir -p "$extract"
    found=0
    if ( cd "$extract" && "$bin" --appimage-extract >/dev/null 2>&1 ); then
        for src_png in "$extract"/squashfs-root/usr/share/icons/hicolor/*/apps/plotina-desktop.png; do
            [ -f "$src_png" ] || continue
            size="${src_png%/apps/plotina-desktop.png}"
            size="${size##*/}"
            install -Dm 644 "$src_png" "$icon_dir/$size/apps/plotina-desktop.png"
            found=1
        done
        if [ "$found" -eq 0 ]; then
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
                found=1
            done
            # Один plain plotina-desktop.png считаем иконкой максимального размера.
            if [ "$found" -eq 0 ] && [ -f "$extract/squashfs-root/plotina-desktop.png" ]; then
                install -Dm 644 "$extract/squashfs-root/plotina-desktop.png" \
                    "$icon_dir/512x512/apps/plotina-desktop.png"
                found=1
            fi
        fi
        if [ "$found" -eq 1 ] && command -v gtk-update-icon-cache >/dev/null 2>&1; then
            gtk-update-icon-cache -q "$icon_dir" 2>/dev/null || true
        fi
    else
        warn "не удалось извлечь иконки (--appimage-extract) — пропускаю; приложение установится без иконок."
    fi

    cat > "$desktop" <<EOF
[Desktop Entry]
Name=Plotina Desktop
Comment=Matrix client for plotina.cc
Exec="$bin" --no-sandbox %U
Terminal=false
Type=Application
Icon=plotina-desktop
StartupWMClass=plotina-desktop
MimeType=x-scheme-handler/$SCHEME;
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
        install_from_repo || die "выбран --deb, но установка $APT_PACKAGE из https://plotina.cc/apt не удалась"
        ;;
    auto)
        if deb_env_available; then
            if [ -n "$DEB_SOURCE" ]; then
                if ! install_deb_file; then
                    warn "не удалось поставить $DEB_SOURCE — перехожу на AppImage"
                    install_appimage
                fi
            elif ! install_from_repo; then
                warn "не удалось установить из apt-репозитория Plotina — перехожу на AppImage"
                install_appimage
            fi
        else
            if [ -n "$DEB_SOURCE" ]; then
                die "передан .deb ($DEB_SOURCE), но: $DEB_REASON"
            fi
            warn "не ставлю из apt-репозитория: $DEB_REASON — ставлю AppImage в ${PREFIX:-$HOME/.local}"
            install_appimage
        fi
        ;;
    *)
        die "внутренняя ошибка: неизвестный режим $MODE"
        ;;
esac
