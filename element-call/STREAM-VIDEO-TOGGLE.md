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
npx vitest run --project=unit        # 802 passed | 9 skipped, 99 files
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
- a publication that only arrives after the viewer hid the stream is
  unsubscribed when it does;
- a restart (new store, same cache) applies it too;
- a choice delivered as account data from another device reaches the running call;
- the store rejects junk keys, does not read a visibility entry as a volume, and writes the choice
  to account data once it settles.

`tests/stream_visibility_probe.mjs` re-checks the store rules under plain node with no
`node_modules` (18 cases), and `tests/test_stream_video_toggle.py` applies the whole series to the
pinned tag before running it, so the probe runs against the file that ships.

## Live proof

Run on 2026-11-10 against a local stand — Synapse + `lk-jwt-service` + LiveKit SFU
behind the upstream `docker-compose-dev.yml` nginx (`synapse.m.localhost`,
`matrix-rtc.m.localhost`), with Element Call served from the production bundle this
patch series builds (`vite build`, then a static HTTPS server) and three browser
contexts in one call: a sharer, a viewer and a control viewer that never touches
the toggle. Numbers are WebRTC `getStats()` deltas over a 2.5 s window, not
screenshots: the share is the 640x360 inbound video (a canvas at 10 fps), the two
320x180 @ 20 fps tracks are the participants' (fake) cameras.

| measurement | viewer, before hiding | viewer, while hidden | control viewer, same moment | viewer, after showing again |
| :-- | :-- | :-- | :-- | :-- |
| `inbound-rtp` video 640x360 | 1 track, 25 frames | **0 tracks** | 1 track, 22 frames | 1 track, 25 frames |
| audio (`inbound-rtp`, 3 streams) | 15.3 / 15.3 / 18.9 KB | 16.3 / 14.8 / 15.1 KB | 14.5 / 14.0 / 12.5 KB | 18.7 / 15.4 / 14.7 KB |
| camera layers 320x180 | 2 tracks, 50 frames each | unchanged | unchanged | unchanged |

So hiding removes the track from the subscription — the inbound stream disappears
from the peer connection entirely (it is not a paused or blanked video element) —
while every audio stream and the other viewer's copy of the same share keep
flowing. Showing it again brings the share back inside the same call, on a new
inbound stream (new SSRC), without leaving or reconnecting.

The client's own LiveKit log in the viewer's page, in order:

```
[RemoteTracks] Subscribed:   video screen_share TR_VSEWTHmuuLPwcE of @<sharer>:synapse.m.localhost
[RemoteTracks] Unsubscribed: video screen_share TR_VSEWTHmuuLPwcE of @<sharer>:synapse.m.localhost
PUT .../account_data/cc.plotina.voice_volumes 200
[RemoteTracks] Subscribed:   video screen_share TR_...  (after showing again)
```

Restart: after reloading the viewer's page and rejoining the lobby, the tile came
back as "Stream hidden" with no 640x360 inbound track at all, and the choice was
in the cache as
`{"@<sharer>:synapse.m.localhost#screenshare-video":{"visible":false,"ts":...}}`
— the same account data event as the volumes, so a second device applies it too.

`tests/live/stream_video_toggle_proof.mjs` is the harness that produced this (it
asserts all of the above and exits non-zero on a mismatch);
`tests/live/serve_bundle.mjs` is the static HTTPS server it needs:

```bash
# 1. a bundle of the pinned tag with the whole series applied
#    (build.py --mode source does this; any production build of it works)
# 2. serve it over HTTPS with the stand's certificate
node element-call/tests/live/serve_bundle.mjs <dist> 3443 <cert dir>   # key.pem + cert.pem
# 3. drive three browsers through the toggle
BASE_URL=https://localhost:3443/ EVIDENCE_DIR=/tmp/stream-proof \
  PLAYWRIGHT_FROM=<ec source tree>/package.json \
  node element-call/tests/live/stream_video_toggle_proof.mjs
```

The evidence file and screenshots from the run are attached to the task
(`t_f1c04868`): `evidence.json`, `01-viewer-receiving.png`, `02-viewer-menu.png`,
`03-viewer-hidden.png`, `04-viewer-shown-again.png`, `05-viewer-after-reload.png`.

### What the live run showed about the UI

- With one remote share in a call, EC puts the share in the spotlight by itself,
  so the corner button is there without the viewer changing layout. The button is
  next to the volume button and is present even when the share has no audio (the
  volume button is not, because it is gated on `audioEnabled`).
- The toggle menu stays open after a click — it is a `ToggleMenuItem`, and the
  checked state is the feedback. Hiding keeps the tile in place with the avatar
  and "Stream hidden", so the same menu is always reachable to bring it back.
- In the grid layout the control is not shown: the tile chrome in grid is not the
  spotlight tile. Upstream's own per-share volume button is grid-less for the same
  reason, and this patch follows it rather than inventing a second control there.

## Manual check, if the stand has to be rebuilt

1. two accounts in one call, A shares a screen with audio;
2. as B, open the stream's corner menu → "Don't show this stream";
3. B's tile shows "Stream hidden", B's console logs `Unsubscribed: video
   screen_share`, and `chrome://webrtc-internals` shows the share's inbound video
   stream gone;
4. A's voice and the share's audio still play for B, and another participant's
   stream (if any) is unaffected;
5. reload B: the stream stays hidden; toggle it back and it renders again.

## Rollback

Remove `patches/0005-plotina-stream-video-toggle.patch` from the build. The keys under
`#screenshare-video` stay in account data as unknown-but-valid entries; `0004` ignores them because
they are not volume keys, and nothing else reads the event. To clean up, delete those keys from
`cc.plotina.voice_volumes`.