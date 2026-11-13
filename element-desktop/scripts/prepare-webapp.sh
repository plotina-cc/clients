#!/usr/bin/env bash
# Assemble the Element Web bundle that the desktop shell embeds.
#
#   scripts/prepare-webapp.sh [--dest element-desktop/.build/webapp]
#
# The desktop shell has no way to load a remote webapp: upstream packs a webapp
# directory into webapp.asar and serves it from vector://vector/webapp/. This
# script produces that directory: the pinned upstream release build plus our
# noise overlay and config.json.
#
# WEBAPP_DIR  use an already unpacked webapp instead of the release tarball, for
#             example `docker cp plotina/element-web-1.12.32:/app webapp`.
# WORK        where the tarball and the assembly live (default: .build)
# NOISE       where the DeepFilterNet3 assets are downloaded (default: noise)
# PYTHON      interpreter to use (default: python3, falling back to python)
# SENTRY_DSN  GlitchTip DSN written into the webapp's config.json; required, and
#             obtained from the SENTRY_DSN repository variable in CI
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO_ROOT="$(dirname "$ROOT")"
WORK="${WORK:-$ROOT/.build}"
NOISE="${NOISE:-$ROOT/noise}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
DEST="$WORK/webapp"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a path}"; shift 2 ;;
    *) echo "usage: $0 [--dest <dir>]" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
command -v "$PYTHON" >/dev/null 2>&1 || { echo "prepare-webapp: no python interpreter" >&2; exit 1; }

echo "==> webapp for $TAG"
rm -rf "$DEST"
mkdir -p "$DEST" "$WORK"

if [ -n "${WEBAPP_DIR:-}" ]; then
  [ -f "$WEBAPP_DIR/index.html" ] || { echo "prepare-webapp: $WEBAPP_DIR has no index.html" >&2; exit 1; }
  echo "    from $WEBAPP_DIR"
  cp -a "$WEBAPP_DIR/." "$DEST/"
else
  LOCK_LINE="$("$PYTHON" - "$ROOT/webapp.lock.json" "$TAG" <<'PY'
import json
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
tag = sys.argv[2]
if lock.get("tag") != tag:
    sys.exit(f"webapp.lock.json pins {lock.get('tag')!r} but UPSTREAM_TAG is {tag!r}: update both together")
print(lock["url"], lock["sha256"])
PY
  )"
  URL="${LOCK_LINE%% *}"
  SHA="${LOCK_LINE##* }"
  TARBALL="$WORK/$(basename "$URL")"
  if [ -f "$TARBALL" ] && echo "$SHA  $TARBALL" | sha256sum -c - >/dev/null 2>&1; then
    echo "    cached $TARBALL"
  else
    echo "    fetch $URL"
    curl -fL --retry 3 --max-time 3600 -o "$TARBALL.part" "$URL"
    echo "$SHA  $TARBALL.part" | sha256sum -c -
    mv "$TARBALL.part" "$TARBALL"
  fi
  tar xzf "$TARBALL" -C "$DEST" --strip-components=1
fi

# Replace the call widget with our own Element Call.
#
# The upstream tarball carries a stock Element Call under
# webapp/widgets/element-call/, and element-web builds the call iframe URL from
# it (./widgets/element-call/). Stock means none of element-call/patches/: no
# per-person volume memory (0004) and no hide-this-stream control (0005), so a
# desktop user gets neither. scripts/element-call-widget.py swaps the whole
# directory for the archive pinned in element-call.lock.json, rebases its
# root-absolute asset URLs for vector://vector/webapp/, and fails the build on
# anything that is not our bundle.
echo "==> element call widget"
"$PYTHON" "$ROOT/scripts/element-call-widget.py" \
  --lock "$ROOT/element-call.lock.json" --work "$WORK" --webapp "$DEST"

echo "==> noise layer"
mkdir -p "$NOISE/vendor"
# logic.js/boot.js serve the app document; plotina-dfn.js/plotina-panel.js are
# the ones the call widget loads (its microphone goes through the LiveKit track
# processor, not through boot.js's getUserMedia wrapper).
cp "$REPO_ROOT/noise/logic.js" "$REPO_ROOT/noise/boot.js" \
   "$REPO_ROOT/noise/plotina-dfn.js" "$REPO_ROOT/noise/plotina-panel.js" "$NOISE/"
cp -a "$REPO_ROOT/noise/vendor/." "$NOISE/vendor/"

echo "==> noise assets"
"$PYTHON" "$REPO_ROOT/cinny/scripts/fetch-noise.py" --dest "$NOISE"
"$PYTHON" "$REPO_ROOT/noise/scripts/fetch-dpdfnet.py" --dest "$NOISE"

echo "==> config"
# The DSN is the one deployment value that may change without a commit:
# element-web/config.json keeps the current one, SENTRY_DSN overrides it (CI
# passes the repository variable). render-config.py fails the build if the
# result could not report (no sentry object, empty or non-hex key, wrong
# environment), instead of shipping an app that is silent about crashes.
CONFIG="$WORK/element-web-config.json"
"$PYTHON" "$REPO_ROOT/element-web/scripts/render-config.py" --out "$CONFIG"

echo "==> overlay"
"$PYTHON" "$ROOT/apply-noise.py" --webapp "$DEST" --noise "$NOISE" \
  --config "$CONFIG" --brand "Plotina Desktop"

# Branding runs after the noise overlay: apply-noise.py owns the JS hooks and
# config.json, branding.py owns the browser-facing shell (title, icons, meta,
# error view) and must see the final index.html.
echo "==> branding"
"$PYTHON" "$ROOT/branding.py" --webapp "$DEST" --icons "$REPO_ROOT/branding/icons"

# The opt-in Dev update channel UI (Settings -> Help & About). Desktop-only:
# the file no-ops without window.electron, but it still ships solely here.
# Insertion is literal-counted below; a moved </head> fails the build.
echo "==> update channel overlay"
install -m 0644 "$ROOT/desktop/web-overlay/update-channel.js" "$DEST/plotina-update-channel.js"
"$PYTHON" - "$DEST/index.html" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
TAG = '<script src="plotina-update-channel.js" defer></script>'
if "plotina-update-channel.js" not in text:
    if "</head>" not in text:
        sys.exit("update-channel overlay: no </head> in index.html; upstream layout changed")
    text = text.replace("</head>", TAG + "</head>", 1)
    p.write_text(text, encoding="utf-8")
    print("update-channel overlay: patched index.html")
else:
    print("update-channel overlay: already patched")
PY

# The webapp directory becomes webapp.asar inside the installer; the licence
# text and the modification notice have to travel with it. Byte-identical to
# ../LICENSE and ../NOTICE.
echo "==> licence"
install -m 0644 "$REPO_ROOT/LICENSE" "$DEST/LICENSE-AGPL-3.0"
install -m 0644 "$REPO_ROOT/NOTICE" "$DEST/NOTICE"

echo "==> verify"
grep -q 'noise/boot.js' "$DEST/index.html"
grep -q 'noise/logic.js' "$DEST/index.html"
# The call widget must be OUR Element Call, not the upstream build that shipped
# in the tarball. Two failures matter and both are silent at runtime: an
# upstream widget (the user loses per-person volume and hide-stream), and one
# whose asset URLs are still root-absolute (every /assets/ 404s under
# vector://vector/webapp/ and the iframe renders an empty #root). The checker is
# the same one the swap uses, so the two cannot drift; it is proven to fail on
# the upstream layout in element-desktop/tests/test_element_call_widget.py.
"$PYTHON" "$ROOT/scripts/element-call-widget.py" --check --webapp "$DEST"
# Direct evidence in the final bytes, independent of the helper: the two
# features from the wish list, the per-person volume store, and the locale the
# user reads them in.
grep -rqs 'video_tile.stream_paused' "$DEST/widgets/element-call/assets/"
grep -rqs 'video_tile.screen_share_visibility' "$DEST/widgets/element-call/assets/"
grep -rqs 'cc.plotina.voice_volumes' "$DEST/widgets/element-call/assets/"
grep -qs 'Стрим приостановлен' "$DEST"/widgets/element-call/assets/*ru-app-*.json
# And the superseded submenu must be gone: it is what .16 replaced.
if grep -rqs 'video_tile.hide_stream' "$DEST/widgets/element-call/assets/"; then
  echo "prepare-webapp: the superseded hide_stream menu is still in the widget" >&2; exit 1
fi
# Upstream's widget is the negative control: it must not be here at all.
if [ -d "$DEST/widgets/element-call/noise" ]; then
  echo "prepare-webapp: the widget carries its own noise/ tree; the webapp root owns it" >&2; exit 1
fi
# plotina-dfn.js resolves its model from its own src (noise/tests/dfn-base.test.mjs);
# without it the desktop widget's microphone is never processed.
grep -q 'document.currentScript' "$DEST/noise/plotina-dfn.js"
test -s "$DEST/noise/plotina-dfn.js"
test -s "$DEST/noise/plotina-panel.js"
grep -q 'Plotina Desktop' "$DEST/index.html"
if grep -q '>Element</title>' "$DEST/index.html"; then
  echo "prepare-webapp: the Element title is still in index.html" >&2; exit 1
fi
if grep -q 'element-app-logo' "$DEST"/bundles/*/error-view.js; then
  echo "prepare-webapp: the Element logo is still in error-view.js" >&2; exit 1
fi
test ! -e "$DEST/mobile_guide"
test -s "$DEST/LICENSE-AGPL-3.0"
test -s "$DEST/NOTICE"
# The Dev update channel overlay must be in the bundle exactly once.
test -s "$DEST/plotina-update-channel.js"
uc="$( { grep -oF -e 'src="plotina-update-channel.js"' "$DEST/index.html" || true; } | wc -l )"
[ "$uc" -eq 1 ] || { echo "prepare-webapp: the update-channel script tag appears $uc times" >&2; exit 1; }
test -f "$DEST/noise/vendor/dfn.esm.js"
test -f "$DEST/noise/dfn/v3/pkg/df_bg.wasm"
test -f "$DEST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz"
test -f "$DEST/noise/vendor/dpdfnet.esm.js"
test -f "$DEST/noise/vendor/ort/ort.wasm.bundle.min.mjs"
test -f "$DEST/noise/vendor/ort/ort-wasm-simd-threaded.wasm"
test -f "$DEST/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/model_stateful.onnx"
test -f "$DEST/config.json"
"$PYTHON" "$REPO_ROOT/element-web/scripts/render-config.py" --check --config "$DEST/config.json"

# Parity with the Element Web image: every fix ../element-web/webapp_fixes.py
# ships into /app must provably be in this webapp too (element-desktop/
# README.md, "Parity with Element Web"). branding.py already fails the build
# when one is missing; these greps re-verify the final bytes, the same way
# the web Dockerfile does after its own brand pass.
count() {  # occurrences of a literal string in a file (grep -c counts lines)
  { grep -oF -e "$1" "$2" || true; } | wc -l
}
test -s "$DEST/plotina-theme.js"
cmp -s "$DEST/plotina-theme.js" "$REPO_ROOT/element-web/plotina-theme.js"
# Personal room names (SPIKE-dm-aliases.md): payload byte-identical to the
# shared source, tagged exactly once, relative for vector://.
test -s "$DEST/plotina-dm-aliases.js"
cmp -s "$DEST/plotina-dm-aliases.js" "$REPO_ROOT/element-web/plotina-dm-aliases.js"
[ "$(count '<script src="plotina-dm-aliases.js" defer></script>' "$DEST/index.html")" -eq 1 ]
# Relative src only: vector://vector/webapp/ never serves a root-absolute path.
[ "$(count '<script src="plotina-theme.js"></script>' "$DEST/index.html")" -eq 1 ]
if grep -q 'src="/plotina-theme.js"' "$DEST/index.html"; then
  echo "prepare-webapp: root-absolute plotina-theme.js src in the desktop webapp" >&2; exit 1
fi
if grep -q 'src="/plotina-dm-aliases.js"' "$DEST/index.html"; then
  echo "prepare-webapp: root-absolute plotina-dm-aliases.js src in the desktop webapp" >&2; exit 1
fi
# The modal a11y block lands exactly once and carries no margin override
# (stock auto margins pin the auth footer to the viewport bottom).
[ "$(count '<style id="plotina-modal-a11y">' "$DEST/index.html")" -eq 1 ]
if grep -q '.mx_AuthPage_modal{' "$DEST/index.html"; then
  echo "prepare-webapp: the modal a11y block overrides .mx_AuthPage_modal margins" >&2; exit 1
fi
# Legacy custom-theme tokens: the sheets must carry the plotina-theme-tokens
# block that defines every dead token, and no custom property may be used
# without a definition or a fallback (the classic case: --timeline-text-color). The
# checker is the same one the web image runs, so the two clients cannot drift.
"$PYTHON" "$REPO_ROOT/element-web/scripts/check-theme-tokens.py" --webapp "$DEST"
if grep -qF 'var(--timeline-text-color,var(--cpd-color-text-primary))' \
  "$DEST"/bundles/*/theme-light-custom.css "$DEST"/bundles/*/theme-dark-custom.css; then
  echo "prepare-webapp: per-use fallback patch still present; the token block replaced it" >&2; exit 1
fi
grep -q 'sign_out_before_verify' "$DEST"/i18n/ru.*.json
# Branding assets referenced by config.json must exist in the webapp root and
# be referenced relatively: vector://vector/webapp/ 404s root-absolute paths.
test -s "$DEST/plotina-bg.png"
test -s "$DEST/plotina-icon.svg"
grep -q '"welcome_background_url": "plotina-bg.png"' "$DEST/config.json"
grep -q '"auth_header_logo_url": "plotina-icon.svg"' "$DEST/config.json"
if grep -qE '"(welcome_background_url|auth_header_logo_url)": "/' "$DEST/config.json"; then
  echo "prepare-webapp: config.json still points at a root-absolute branding asset" >&2; exit 1
fi

echo "webapp ready: $DEST ($(du -sh "$DEST" | cut -f1))"
