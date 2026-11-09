# Remembering a participant's volume in Element Call

Element Call keeps a remote participant's playback volume inside that tile's ViewModel. When the
participant reconnects, rejoins, or joins from another device, a new ViewModel is created and the
volume is back to 1.0 — the user has to turn that one person down again in every call.

`patches/0004-plotina-persistent-volume.patch` remembers it per **Matrix user ID** instead.
LiveKit's participant identity is the MXID, so the value follows the person, not the tile: renaming
them, reconnecting them, or their joining from a phone does not lose it. Applied by
`build.py --mode source` together with the other patches in `patches/`, in filename order.

This note is about that patch only. Element X, FluffyChat and Cinny are out of scope: X has no
per-participant volume at all, and FluffyChat's calls are not stable enough to build on. Nothing in
this patch touches them, the SFU, or `pins.env`.

`patches/0005-plotina-stream-video-toggle.patch` reuses the same map and account data event for the
viewer's choice of whether to show a stream at all (`<mxid>#screenshare-video`); see
[STREAM-VIDEO-TOGGLE.md](./STREAM-VIDEO-TOGGLE.md). Its entries are not volumes and are never read
as one.

## What is remembered, and under which key

| Key | What it controls |
| :-- | :-- |
| `@alice:plotina.cc` | the volume of Alice's microphone, as heard by *this* user |
| `@alice:plotina.cc#screenshare` | the volume of Alice's screen share audio, separately |

The screen share is a separate key on purpose: a share is usually much louder or quieter than the
person talking, and muting a share should not mute the person. One screen share per participant is
what Element Call models, so the key does not carry a share id.

The value is a level plus a mute flag, never the other way round: muting keeps the level, so
unmuting after a restart returns to where the user left it rather than to 1.0.

A participant nobody has adjusted has no entry at all and plays at upstream's 1.0. Merely rendering
a tile does not write anything.

## Where it lives

Two layers, both holding the same map:

```json
{
  "@alice:plotina.cc": { "volume": 0.7, "muted": false, "ts": 1794256199000 },
  "@bob:plotina.cc#screenshare": { "volume": 0.3, "muted": true, "ts": 1794256199000 }
}
```

**localStorage — `plotina_voice_volumes_v1`.** A synchronous cache, read on start, so the value is
applied on the first frame of the tile and still works with no network. Written on every change.

**Account data — `cc.plotina.voice_volumes`.** The source of truth across devices, read on start
and on every `accountData` event, written with a **500 ms debounce** (a slider drag produces one
write, not one per pixel; `pagehide` flushes a pending write so closing the tab does not lose it).

Notes for anyone reading the map in a rageshake or on the server:

- `ts` is the writing device's clock in milliseconds. Two devices merging the same key keep the
  newer `ts` (last write wins); on a tie the copy that arrived over account data wins. Keys only one
  device knows about are merged in rather than dropped, so adjusting one person on a laptop does not
  wipe what the phone recorded about everyone else.
- A change from another device is applied to a call that is already running, not just on the next
  start.
- Volumes outside `0..1` are clamped, a volume that is not a number is dropped, and a key that is
  not an MXID is dropped. Junk in account data or in the cache never throws: the cache falls back to
  a cold start, account data falls back to the cache.

## Privacy

Account data is stored **unencrypted** on the homeserver and is visible to it, and to anything that
can read the account's plaintext state (an admin, a backup, a client with the account open). What it
reveals is "this account turned Alice down to 0.7 and muted Bob's screen share" — a social graph of
sorts, but no content, no keys, and no other account's data. It is per-account: the entries are the
volumes *this* user chose, and they are never written to room state, so other participants do not
see them.

If that is not acceptable for an account, do not apply the patch for it, or clear the event (see
"Rolling back").

The cache is per browser profile, and the account data is per account. Signing into another account
in the same profile drops the previous account's cached entries rather than carrying them over, so
what one account turned down is never applied to — or written into — another account's map.

## Limits

| | |
| :-- | :-- |
| entries kept | **500**, newest by `ts` win, the rest are evicted |
| size at 500 entries | ~37 KiB of JSON with realistic MXIDs (75 bytes per entry) |
| event size | account data is a normal state event; servers commonly cap it at 64 KiB |
| write rate | one `setAccountData` per 500 ms of quiet at most |
| cache | one localStorage key; a cache that exceeds quota is dropped, not fatal |

The cap exists because account data is not a database: it is synced to every device of the account
and bounded in size. 500 people is far more than anyone calls with; past that the oldest entries go
first, so the people the user adjusted most recently are the ones that survive.

## Rolling back

The patch is additive: it adds `src/state/PersistentVolume.ts` (+ its test) and two calls in
`RemoteUserMediaViewModel` and `RemoteScreenShareViewModel`. Upstream's `VolumeControls.ts` is
untouched.

- Stop applying it: remove `patches/0004-plotina-persistent-volume.patch` and rebuild
  (`element-call/build.py --mode source`). Volumes go back to per-tile and reset on reconnect;
  nothing else changes. The account data event and the localStorage key are simply left behind and
  ignored.
- Clear what was written, with the account's own token (or from a client that can send arbitrary
  account data): `PUT /_matrix/client/v3/user/{userId}/account_data/cc.plotina.voice_volumes` with
  `{}`, and clear `plotina_voice_volumes_v1` from the browser's localStorage. Either side alone is
  enough to be back to defaults, since the patch treats a missing value as 1.0.

## Verifying a build

```bash
python3 -m unittest discover -s element-call/tests          # applies every patch to the pinned tag
EC_SKIP_NETWORK=1 python3 -m unittest discover -s element-call/tests   # cached/no network
```

`tests/test_volume_persistence.py` applies `patches/*.patch` in order to the upstream source of the
tag in `pins.env` and runs the store under plain node (`tests/volume_store_probe.mjs`) — no
node_modules, which is why the store has no runtime imports. Inside a source checkout with
`pnpm install` done, the same rules run under vitest as `src/state/PersistentVolume.test.ts`.

In the app: turn a participant down, reload, and the tile comes back at that level; open the same
account on a second device and the level is there too. `filter` one person in the browser console to
see it:

```js
JSON.parse(localStorage.getItem("plotina_voice_volumes_v1"))
```