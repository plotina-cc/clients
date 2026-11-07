#!/usr/bin/env bash
# Build the Linux AppImages needed to exercise the update channels by hand.
# Nothing is published (--publish never); these are test artifacts only.
#
#   LITE_DIST=/path/to/cinny/dist bash scripts/build-appimages.sh
#   bash scripts/build-appimages.sh                       # if web/ is staged
#   bash scripts/build-appimages.sh 4.12.8-plotina.99     # custom version list
#
# Default set (chosen so every channel transition is reachable):
#   4.12.8-plotina.19        stable, "the old install"
#   4.12.8-plotina.20        stable, what the stable feed offers
#   4.12.8-plotina.19-dev.1  dev,   what the dev feed offers
# For each version we keep: the AppImage (dist + .qa/images), electron-builder's
# own latest-linux.yml (.qa/images/latest-linux-<ver>.yml) and the unpacked
# binary (.qa/unpacked/<ver>/) — the QA harness runs the unpacked binary with
# APPIMAGE pointed at a copy of the image, same as scripts/qa-updater-feed.sh,
# so no FUSE is needed and each version reports its own app.getVersion().
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

VERSIONS=("$@")
if [ "${#VERSIONS[@]}" -eq 0 ]; then
  VERSIONS=(4.12.8-plotina.19 4.12.8-plotina.20 4.12.8-plotina.19-dev.1)
fi

[ -x node_modules/.bin/electron-builder ] || { echo "run npm install first" >&2; exit 1; }
if [ ! -f web/index.html ]; then
  LITE_DIST="${LITE_DIST:?set LITE_DIST to the built Cinny web dist (or stage web/ once)}" \
    bash scripts/stage-web.sh
fi
bash scripts/build-icons.sh >/dev/null

mkdir -p dist .qa/images .qa/unpacked
for v in "${VERSIONS[@]}"; do
  # The version grammar is the updater contract — refuse anything else instead
  # of producing an image no feed can ever offer it.
  node -e "const p=require('./src/update-channel.js');const v=process.argv[1];
    if(!p.versionTokens(v)){console.error('VERSION NOT PARSEABLE: '+v);process.exit(1)}
    console.log('version '+v+' -> tokens '+JSON.stringify(p.versionTokens(v))+' shape='+p.channelOfVersion(v));" "$v"
  echo "== building AppImage $v"
  node_modules/.bin/electron-builder --config electron-builder.plotina.json \
    -c.extraMetadata.version="$v" --publish never --linux AppImage >"$HERE/.qa/build-$v.log" 2>&1 \
    || { tail -20 "$HERE/.qa/build-$v.log"; exit 1; }
  ai="dist/Plotina-Lite-Desktop-$v-x86_64.AppImage"
  [ -f "$ai" ] || { echo "expected artifact missing: $ai" >&2; exit 1; }
  cp -f "$ai" .qa/images/
  cp -f dist/latest-linux.yml ".qa/images/latest-linux-$v.yml"
  rm -rf ".qa/unpacked/$v"; cp -a dist/linux-unpacked ".qa/unpacked/$v"
done

echo; echo "built:"; ls -la .qa/images/ | sed -n '2,20p'
sha256sum .qa/images/*.AppImage
