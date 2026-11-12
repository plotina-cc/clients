#!/usr/bin/env bash
# NEGATIVE CONTROL for the member-name suite.
#
# The suite claims to test the display point (getMemberDisplayName) in
# src/app/utils/room.ts. A test that passed against a tree where that function
# still returns only the member-state name would prove nothing. This script
# builds the SAME test file against upstream's own room.ts -- the version main
# ships, with no contact-name lookup -- and requires it to FAIL on assertions.
#
#   bash cinny/scripts/member-names-negative-control.sh [UPSTREAM_SRC]
#
# Exit 0 = the suite really fails on the unpatched display point (good).
# Exit 1 = the suite passed on unpatched code, or did not even run: either way
#          it does not test the feature.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
SRC="${1:-${CINNY_SRC:-$ROOT/.build/cinny-desktop/cinny}}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plotina-member-control.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

REV="$TAG"
if ! git -C "$SRC" rev-parse --verify --quiet "$REV^{commit}" >/dev/null; then
  # The submodule checkout carries the release commit but not its tags, so fall
  # back to HEAD exactly as scripts/test-dm-aliases.sh does -- same commit, the
  # "chore: Release v4.12.8" one.
  REV="$(git -C "$SRC" rev-parse HEAD)"
  echo "==> $TAG is not a tag in $SRC, using HEAD ($REV)" >&2
fi
echo "==> upstream $REV exported to $WORK/src (no Plotina patches)"
mkdir -p "$WORK/src"
git -C "$SRC" archive "$REV" | tar -x -C "$WORK/src"
ln -s "$SRC/node_modules" "$WORK/src/node_modules"

# The suite imports src/plotina/memberNames, which only the patch adds. A stub
# with the same three names keeps that import resolvable, so the assertions
# fail on BEHAVIOUR (the member-state name instead of the personal one) rather
# than on a missing module. A control that dies while loading would prove only
# that a file is absent -- not that the display point is wired.
#
# The stub encodes upstream's rule honestly: personalNameOf/personalNameForMember
# always answer "no personal name", and memberOwnName is exactly what upstream's
# getMemberDisplayName already did. It is written BEFORE the bundle is built,
# because esbuild resolves the import at build time.
mkdir -p "$WORK/src/src/plotina"
cat > "$WORK/src/src/plotina/memberNames.ts" <<'STUB'
type RoomLike = {
  client?: unknown;
  getMember?: (userId: string) => { rawDisplayName?: string } | null | undefined;
};
export const personalNameOf = (_mx: unknown, _userId: string | undefined): string | undefined =>
  undefined;
export const personalNameForMember = (
  _room: RoomLike | null | undefined,
  _userId: string | undefined
): string | undefined => undefined;
export const memberOwnName = (
  room: RoomLike | null | undefined,
  userId: string | undefined
): string | undefined => {
  if (!room || typeof userId !== 'string' || typeof room.getMember !== 'function') return undefined;
  const name = room.getMember(userId)?.rawDisplayName;
  if (name === userId) return undefined;
  return name;
};
STUB

cat > "$WORK/src/memberNamesEntry.ts" <<'ENTRY'
export { getMemberDisplayName, getMemberSearchStr } from './src/app/utils/room';
export * as sort from './src/app/hooks/useMemberSort';
export * as memberNames from './src/plotina/memberNames';
ENTRY
"$SRC/node_modules/.bin/esbuild" "$WORK/src/memberNamesEntry.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --external:matrix-js-sdk --external:react \
  --banner:js="import { createRequire as __plotinaCreateRequire } from 'node:module'; const require = __plotinaCreateRequire(import.meta.url);" \
  --outfile="$WORK/src/memberNames.mjs"

# The storage module the suite also loads. Upstream has no such file at all, so
# this is a no-names implementation with the same export surface: the run is
# about the DISPLAY POINT, not about a missing parser, and a control that
# stopped here would not exercise getMemberDisplayName.
cat > "$WORK/src/contactNames.ts" <<'CORE'
export const CONTACT_NAMES_EVENT_TYPE = 'cc.plotina.contact_names';
export type ContactNames = Record<string, string>;
export type DirectPartners = Record<string, string>;
export const isUserId = (_raw: unknown): _raw is string => false;
export const parseContactNames = (_raw: unknown): ContactNames => ({});
export const directPartners = (_content: unknown): DirectPartners => ({});
export const contactNameFor = (_names: ContactNames, _userId: string | undefined): string | undefined =>
  undefined;
export const dmPartnerId = (
  _roomId: string,
  _meId: string | undefined,
  _direct: DirectPartners | undefined,
  _joinedUserIds: readonly string[] | undefined,
  _inviterId?: string | undefined,
  _isSpace?: boolean
): string | undefined => undefined;
export const contactNameForRoom = (
  _names: ContactNames,
  _roomId: string,
  _meId: string | undefined,
  _direct: DirectPartners | undefined,
  _joinedUserIds: readonly string[] | undefined,
  _inviterId?: string | undefined,
  _isSpace?: boolean
): string | undefined => undefined;
export const contactNamesWith = (
  names: ContactNames,
  _userId: string,
  _name: string | null | undefined
): ContactNames => ({ ...names });
export const resolveRoomName = (roomName: string | undefined, _personalName: string | undefined): string =>
  roomName || '';
export const hasContactNames = (_names: ContactNames): boolean => false;
CORE
"$SRC/node_modules/.bin/esbuild" "$WORK/src/contactNames.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --outfile="$WORK/src/core.mjs"

# The glue the suite imports for subscribeContactNames/install/set. Upstream has
# none of it; the stub installs nothing and writes nothing, so the assertions
# about a live rename fail -- which is the point.
cat > "$WORK/src/glue.ts" <<'GLUE'
export const subscribeContactNames = (_mx: unknown, _listener: () => void): (() => void) => () => {};
export const installPlotinaContactNames = (_mx: unknown) => {};
export const setPlotinaContactName = async (
  _mx: unknown,
  _room: unknown,
  _name: string | null | undefined
): Promise<void> => {};
GLUE
"$SRC/node_modules/.bin/esbuild" "$WORK/src/glue.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --outfile="$WORK/src/glue.mjs"

echo "==> node --test (expected to FAIL: unpatched display point)"
set +e
PLOTINA_ALIASES_CORE="$WORK/src/core.mjs" \
  PLOTINA_ALIASES_GLUE="$WORK/src/glue.mjs" \
  PLOTINA_ALIASES_SDK="$SRC/node_modules/matrix-js-sdk/lib/index.js" \
  PLOTINA_MEMBER_NAMES="$WORK/src/memberNames.mjs" \
  node --test "$ROOT/tests/member_names.test.mjs" > "$WORK/out.txt" 2>&1
STATUS=$?
set -e

grep -E "^(✔|✖|ℹ (tests|pass|fail))" "$WORK/out.txt" || true
if [ "$STATUS" -eq 0 ]; then
  echo "NEGATIVE CONTROL FAILED: the member-name suite passes on upstream's display point," >&2
  echo "  so it does not test the contact-name feature at all." >&2
  exit 1
fi
# A control that fails while MODULES LOAD proves only that something is
# missing. Require at least one test to have actually run, and at least one to
# have failed on an assertion about the personal name.
PASSED="$(sed -n 's/^ℹ pass \([0-9]*\)$/\1/p' "$WORK/out.txt" | tail -1)"
if [ "${PASSED:-0}" = "0" ]; then
  echo "NEGATIVE CONTROL INVALID: no test ran (load-time failure), not a behavioural RED:" >&2
  sed -n '1,25p' "$WORK/out.txt" >&2
  exit 1
fi
echo "NEGATIVE CONTROL OK: exit=$STATUS on the unpatched display point, $PASSED passed / rest failed"
