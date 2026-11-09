# Hiding somebody's stream (video), per viewer

`patches/0005-plotina-stream-video-toggle.patch`, applied after `0004` on `v0.26.1`.

## The question

Can a viewer switch off **the stream itself**, not just its sound? Upstream: no.
`ScreenShareVolumeButton` in `src/tile/SpotlightTile.tsx` only drives the volume and mute of the
`ScreenShareAudio` track. There is no control that stops a *remote* screen share's video, and the
publisher's `Stop sharing` button belongs to the publisher.

## What the patch adds

Every remote screen share in the spotlight gets a second button in the bottom-right corner, next to
the volume button (and, unlike the volume button, it is there for a stream with no audio too). It
opens a menu with one toggle: **"Don't show this stream"** / **«Не показывать этот стрим»**.

- Toggled on: the video track is taken out of the subscription
  (`RemoteTrackPublication.setSubscribed(false)`), the tile stops rendering it, and the tile shows
  "Stream hidden" / «Стрим скрыт» in its place.
- Toggled off: `setSubscribed(true)` and the normal render come back, without renegotiating the call
  or reconnecting.
- Each stream has its own toggle, keyed by the participant's MXID. There is deliberately **no**
  "hide all streams" switch.

The tile itself stays in place while hidden. That is what makes the toggle reachable again: hiding a
stream must not remove the only way to unhide it.

## How it is wired

| | |
| :-- | :-- |
| `src/state/media/RemoteScreenShareViewModel.ts` | new `videoVisible$` (the viewer's choice) next to upstream's `videoEnabled$` (whether the publisher is sharing and connected). `setVideoVisible` / `toggleVideoVisible` change it; a `combineLatest` of the screen share publication and `videoVisible$` calls `setSubscribed`. |
| `src/state/PersistentVolume.ts` | the store from `0004` gains a `#screenshare-video` key namespace and `getStreamVisible` / `setStreamVisible`; the map, debounce, merge and limit are shared with the volumes. |
| `src/tile/SpotlightTile.tsx` | `ScreenShareVisibilityButton` (a `Menu` with a `ToggleMenuItem`) next to `ScreenShareVolumeButton`; `SpotlightRemoteScreenShareItem` does not hand the track to `MediaView` while hidden. |
| `locales/{en,ru}/app.json` | `screen_share_visibility`, `hide_stream`, `stream_hidden`. |
| `src/utils/test.ts` | the shared remote-participant mock's publication stub understands `setSubscribed`. |

`videoEnabled$` is not changed or reused: it still means "this share is being published and we are
connected", which is what other code (waiting states, the presenter bin) reads. Hiding a stream
must not look like the publisher stopped sharing.

## What is *not* touched

- The publisher: nothing is signalled to them, the share keeps running.
- Voice (`Track.Source.Microphone`) and the share's audio (`ScreenShareAudio`): separate tracks,
  separate volume controls, not mentioned by this patch.
- Other participants' streams: each toggle touches exactly one publication.
- LiveKit/SFU configuration, `pins.env`/`EC_TAG`, `VolumeControls.ts`, any deployed artefact.

## Storage

Same two layers and the same account data event as the volumes (`0004`):

| | |
| :-- | :-- |
| localStorage | `plotina_voice_volumes_v1` (synchronous cache, works offline) |
| account data | `cc.plotina.voice_volumes` (source of truth across devices) |
| key | `<mxid>#screenshare-video` |
| entry | `{ "visible": false, "ts": 1730000000000 }` |
| default | no entry = show; hiding is an explicit choice, so it is the only thing written |
| merge | union by key, last write wins by `ts`, remote wins ties |
| write | debounced 500 ms, flushed on `pagehide` |
| limit | the existing 500-entry budget is shared with the volumes (≈37 KiB at the cap); each visibility entry costs about 45 bytes |

Because it lives in account data, the choice follows the account to another device, and a change
made on one device is applied to a call already running on another (`onChange`). The visibility
entries are validated by key shape, and a visibility entry is never returned as a volume, so hiding
a stream cannot accidentally mute it.

**Privacy.** As with the volumes, account data is an ordinary unencrypted state event: the
homeserver can see that this account hid that person's stream. The value is a boolean and a
timestamp per participant, nothing more.

**Limits.** Hidden state is not synced to Element X, FluffyChat or Cinny: they see the share as
usual. The only writer is Element Call, which is why the key lives in the `cc.plotina.*` namespace.

## Verification

Run from `element-call/` with the sources of the pinned tag plus the patch series (what
`build.py --mode source` does):

```bash
npx vitest run --project=unit        # 801 passed | 9 skipped, 99 files
npx tsc --noEmit                     # clean
npx oxlint src/state src/tile src/utils/test.ts
python3 -m unittest discover -s element-call/tests   # 83 tests, OK
NODE_OPTIONS=--max-old-space-size=16384 npx vite build   # exit 0
```

The new coverage, in `src/state/media/RemoteScreenShareViewModel.test.ts` and one case in
`src/tile/SpotlightTile.test.tsx`:

- a fresh stream is visible and subscribed;
- hiding calls `setSubscribed(false)`, showing calls `setSubscribed(true)`;
- `videoEnabled$` stays `true` while the viewer hides the stream;
- `setVolume` is not called by hiding, and the share's playback volume/mute do not change;
- with two shares, hiding one does not touch the other's publication;
- a reconnect (new participant, new publication) applies the stored choice;
- a restart (new store, same cache) applies it too;
- a choice delivered as account data from another device reaches the running call;
- the store rejects junk keys, does not read a visibility entry as a volume, and writes the choice
  to account data once it settles.

`tests/stream_visibility_probe.mjs` re-checks the store rules under plain node with no
`node_modules` (18 cases), and `tests/test_stream_video_toggle.py` applies the whole series to the
pinned tag before running it, so the probe runs against the file that ships.

## What was not verified

There was no live two-party SFU call in this task: the behaviour is verified at ViewModel/store
level with real `rxjs`, in the tile's DOM tests, and in the production bundle (the new strings and
`setSubscribed` are in `dist/assets/index-*.js`). The manual check that closes the gap:

1. two accounts in one call, A shares a screen with audio;
2. as B, open the stream's corner menu → "Don't show this stream";
3. B's tile shows "Stream hidden", B's console logs `setSubscribed` on the `ScreenShare`
   publication, and `chrome://webrtc-internals` shows the screen-share video track removed;
4. A's voice and the share's audio still play for B, and another participant's stream (if any) is
   unaffected;
5. reload B: the stream stays hidden; toggle it back and it renders again.

## Rollback

Remove `patches/0005-plotina-stream-video-toggle.patch` from the build. The keys under
`#screenshare-video` stay in account data as unknown-but-valid entries; `0004` ignores them because
they are not volume keys, and nothing else reads the event. To clean up, delete those keys from
`cc.plotina.voice_volumes`.