#!/usr/bin/env bash
# Reproduce the bundle inspection behind SPIKE-dm-aliases.md.
#
#   element-web/spike-dm-aliases/bundle-hooks.sh <unpacked webapp v1.12.32>
#
# Prints where the page exposes a Matrix client handle and where the room name
# is computed, which is what the overlay hooks. Everything is grep/source-map
# work: no build, no network.
set -euo pipefail

APP="${1:?usage: bundle-hooks.sh <webapp dir>}"
BUNDLE_DIR="$(ls -d "$APP"/bundles/*/ | head -1)"
BUNDLE="$(basename "$BUNDLE_DIR")"

echo "== webapp: $APP"
echo "== bundle: $BUNDLE"
echo
echo "== window.mxMatrixClientPeg (matrix-react-sdk init.tsx, element-web v1.12.32)"
grep -o -E '.{80}window\.mxMatrixClientPeg\|\|\(window\.mxMatrixClientPeg=.{40}' \
  "$BUNDLE_DIR/init.js" || { echo "NOT FOUND"; exit 1; }
echo
echo "== source maps that carry the matrix-js-sdk Room model"
for map in "$BUNDLE_DIR"/*.js.map; do
  if grep -q 'matrix-js-sdk/src/models/room.ts' "$map"; then
    printf '   %s (%s)\n' "$(basename "$map" .map)" "$(du -h "${map%.map}" | cut -f1)"
  fi
done
echo
echo "== room.ts facts the hook relies on (from the map's sourcesContent)"
python3 - "$BUNDLE_DIR" <<'PY'
import glob
import json
import sys

for mp in sorted(glob.glob(sys.argv[1] + "/*.js.map")):
    data = json.load(open(mp, encoding="utf-8"))
    for i, src in enumerate(data.get("sources") or []):
        if not src.endswith("matrix-js-sdk/src/models/room.ts"):
            continue
        body = (data.get("sourcesContent") or [""])[i].splitlines()
        print(f"   {src.split('node_modules/')[-1]}")
        for n, line in enumerate(body, 1):
            if ("public name: string;" in line
                    or "public recalculate()" in line
                    or "private calculateRoomName(" in line
                    or "this.name = this.calculateRoomName(" in line
                    or "this.emit(RoomEvent.Name, this)" in line):
                print(f"     {n:5d}  {line.strip()}")
        break
PY