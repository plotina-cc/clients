# Hiding somebody's stream (video), per viewer

`patches/0005-plotina-stream-video-toggle.patch`, applied after `0004` on `v0.26.1`.

## The question

Can a viewer switch off **the stream itself**, not just its sound? Upstream: no.
`ScreenShareVolumeButton` in `src/tile/SpotlightTile.tsx` only drives the volume and mute of the
`ScreenShareAudio` track. There is no control that stops a *remote* screen share's video, and the
publisher's `Stop sharing` button belongs to the publisher.

## What the patch adds

Every remote screen share in the spotlight gets a second button in the bottom-right corner, next to
the volume button (and, unlike the volume button, it is there for a stream with no audio too). It is
a **single eye button**, not a menu: one click hides the stream, another click brings it back.

**Somebody else's stream arrives hidden.** The viewer turns it on with the corner eye; only then is
the video track put into the subscription.

- Hidden — the default for a stream nobody has asked for, and what the eye reports on a fresh
  stream: the video track is kept out of the subscription
  (`RemoteTrackPublication.setSubscribed(false)`), the tile does not render it, and the tile turns
  into a **paused stream**: the participant's avatar under a dark scrim, «Стрим приостановлен» /
  "Stream paused" in the middle, and a **Watch** button under it. Hiding is remembered per MXID in
  the same store as the volumes (`visible: false` in account data), so it stays hidden on the next
  call and on the viewer's other devices.
- A shown stream: the eye-open icon and the label **"Screen share visibility"** /
  «Показ демонстрации экрана», `aria-pressed="false"`.
- A hidden stream: the eye-struck-through icon and the label **"Show screen share"** /
  «Показать демонстрацию экрана», `aria-pressed="true"`. Neither state needs a hover: the icon and
  the accessible name say which way the next click goes. It is a plain toggle, not a menu: one click
  is the whole interaction.
- Turned on: `setSubscribed(true)` and the normal render come back, without renegotiating the call
  or reconnecting. This is a choice about what the viewer is watching now: it is *not* written to
  account data, so the next visit — or the next share from that person — starts hidden again.
- Each stream has its own toggle, keyed by the participant's MXID. There is deliberately **no**
  "hide all streams" switch.
- The person sharing is never affected: a local share is not a `RemoteScreenShareViewModel` and does
  not consult the visibility model at all, so the sharer always sees their own stream.

The tile itself stays in place while hidden. That is what makes the toggle reachable again: hiding a
stream must not remove the only way to unhide it.

## How it is wired

| | |
| :-- | :-- |
| `src/state/media/RemoteScreenShareViewModel.ts` | new `videoVisible$` (the viewer's choice) next to upstream's `videoEnabled$` (whether the publisher is sharing and connected). `setVideoVisible` / `toggleVideoVisible` change it; a `combineLatest` of the screen share publication and `videoVisible$` calls `setSubscribed`. |
| `src/state/PersistentVolume.ts` | the store from `0004` gains a `#screenshare-video` key namespace and `getStreamVisible` / `setStreamVisible` (no entry = hidden); the map, debounce, merge and limit are shared with the volumes. |
| `src/tile/SpotlightTile.tsx` | `ScreenShareVisibilityButton` (one `<button>` with `VisibilityOnIcon`/`VisibilityOffIcon`, `aria-pressed` and a state-dependent label) next to `ScreenShareVolumeButton`; `SpotlightRemoteScreenShareItem` does not hand the track to `MediaView` while hidden, and passes the paused block as `MediaView`'s `overlay`. |
| `src/tile/SpotlightTile.module.css` | the paused block and its Watch button (centred, white on the dark scrim, `opacity: 1` so it does not wait for a hover). |
| `src/tile/MediaView.tsx`, `MediaView.module.css` | a generic `overlay` layer: above the background (avatar, video), below the foreground chrome, so the volume and eye controls stay reachable. |
| `locales/{en,ru}/app.json` | `screen_share_visibility`, `show_stream`, `stream_paused`, `watch_stream`. The old menu label `hide_stream` went with the menu, and the old status line `stream_hidden` was replaced by the paused tile. |
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

## What a paused stream looks like

A hidden stream must not read as a participant who happens to be present with their camera off. The
tile therefore switches to a state of its own instead of painting a status line:

- the participant's own avatar, dimmed under a dark scrim (`rgb(0 0 0 / 55%)`, the same in both
  themes) so the label stays readable over any avatar, wallpaper or theme colour;
- «Стрим приостановлен» / "Stream paused" in the middle of the tile;
- a **Watch** button under the label, the same action as the corner eye toggle
  (`vm.setVideoVisible(true)`), a real `<button>` with `aria-label`, so it is reachable with Tab and
  announced by a screen reader. It is visible without a hover — the tile's own buttons are
  hover-only, and the paused block opts out of that rule.

The block is rendered through a new generic `MediaView` `overlay` slot: above the background (avatar,
video) and below the foreground chrome. Covering the chrome instead would have taken the volume and
eye controls away exactly when the viewer is looking at the tile. The old
`video_tile.stream_hidden` status line is gone, and no dead key is left in the locales.

## Storage

Same two layers and the same account data event as the volumes (`0004`):

| | |
| :-- | :-- |
| localStorage | `plotina_voice_volumes_v1` (synchronous cache, works offline) |
| account data | `cc.plotina.voice_volumes` (source of truth across devices) |
| key | `<mxid>#screenshare-video` |
| entry | `{ "visible": false, "ts": 1730000000000 }` |
| default | no entry = hidden, exactly like an explicit `false`; only `visible: true` shows a stream (see below) |
| merge | union by key, last write wins by `ts`, remote wins ties |
| write | hiding only, debounced 500 ms, flushed on `pagehide`; showing is a page-session choice and is never written |
| limit | the existing 500-entry budget is shared with the volumes (≈37 KiB at the cap); each visibility entry costs about 45 bytes |

Because it lives in account data, the choice follows the account to another device, and a change
made on one device is applied to a call already running on another (`onChange`). The visibility
entries are validated by key shape, and a visibility entry is never returned as a volume, so hiding
a stream cannot accidentally mute it.

## Hidden by default

Somebody else's stream arrives **hidden**: `getStreamVisible` answers `false` for a key with no
entry, and the ViewModel starts from that answer, so the video is never subscribed until the viewer
asks for it. Only `visible: true` shows a stream, and there are two ways such an entry can exist:

- an older build wrote it, when showing was the default — still honoured, so upgrading does not hide
  a stream that viewer had asked to watch;
- another device of the same account chose to show it.

Hiding is the only choice this patch writes. Showing is a choice about what this viewer is watching
now: it holds for the page session — a reconnect or a re-share keeps it — and the next visit, or the
next share from that person, starts hidden again. An explicit hide from another device ends a local
"watch", so the running call still follows the account.

The person sharing is not affected: a local screen share never consults the store (it is not a
`RemoteScreenShareViewModel`), so the sharer always sees what they are sharing, whatever is stored
for their own MXID.

**Privacy.** As with the volumes, account data is an ordinary unencrypted state event: the
homeserver can see that this account hid that person's stream. The value is a boolean and a
timestamp per participant, nothing more.

**Limits.** Hidden state is not synced to Element X, FluffyChat or Cinny: they see the share as
usual. The only writer is Element Call, which is why the key lives in the `cc.plotina.*` namespace.

## Verification

Run from `element-call/` with the sources of the pinned tag plus the patch series (what
`build.py --mode source` does):

```bash
npx vitest run --project=unit        # 812 passed | 9 skipped, 99 files
npx tsc --noEmit                     # clean
npx oxlint src/state src/tile src/utils/test.ts   # 2 pre-existing no-meaningless-void-operator in Publisher.ts (0001), no new ones
python3 -m unittest discover -s element-call/tests   # 89 tests, OK
NODE_OPTIONS=--max-old-space-size=16384 npx vite build   # exit 0
```

The new coverage, in `src/state/media/RemoteScreenShareViewModel.test.ts` and two cases in
`src/tile/SpotlightTile.test.tsx`:

- one click on the eye hides the stream and opens no menu; the next click brings it back;
- `aria-pressed` and the accessible name follow the state ("Screen share visibility" /
  "Show screen share"), and a stream the store has hidden renders as hidden from the first frame and
  stays hidden across a re-render;
- a fresh stream is hidden and its video is not subscribed;
- a stored `visible: true` (an older build's choice) is honoured, a stored `false` is not;
- hiding calls `setSubscribed(false)`, showing calls `setSubscribed(true)`;
- showing is not written to account data, and a restart starts hidden again;
- a hidden stream renders as the paused tile — "Stream paused" over the participant's avatar, with a
  Watch button that is reachable from the keyboard and brings the stream back;
- `videoEnabled$` stays `true` while the viewer hides the stream;
- `setVolume` is not called by hiding, and the share's playback volume/mute do not change;
- with two shares, showing one does not touch the other's publication;
- a reconnect (new participant, new publication) applies the stored choice, and keeps a stream the
  viewer is watching;
- a publication that only arrives after the viewer hid the stream is
  unsubscribed when it does;
- showing the stream again after the publisher's track ended does not throw, and
  a re-share afterwards is shown rather than hidden;
- a restart (new store, same cache) applies a hidden choice too;
- a choice delivered as account data from another device reaches the running call;
- the viewer's own (local) screen share is never hidden, whatever is stored for their MXID;
- the store rejects junk keys, does not read a visibility entry as a volume, and writes only hiding
  to account data.

`tests/stream_visibility_probe.mjs` re-checks the store rules under plain node with no
`node_modules` (22 cases), and `tests/test_stream_video_toggle.py` applies the whole series to the
pinned tag before running it, so the probe runs against the file that ships.

## Live proof

One run of `tests/live/stream_video_toggle_proof.mjs` covers both halves of this
patch on one build, because they are one behaviour now. The stand is the upstream
`docker-compose-dev.yml` one — Synapse + `lk-jwt-service` + LiveKit SFU behind its
nginx (`synapse.m.localhost`, `matrix-rtc.m.localhost`) — with a `vite build` of
the pinned tag plus patches `0001`–`0006` served by `tests/live/serve_bundle.mjs`
on `https://localhost:3443`. Three browser contexts join one call: a **sharer**
that publishes a synthetic share (canvas 640x360 @ 10 fps + 440 Hz audio), a
**viewer** that is the subject, and a **control** viewer that asks for the stream
once and is then left alone.

Numbers are WebRTC `getStats()` deltas over a 2.5 s window, on every
`RTCPeerConnection` the page created, so "hidden" means the SFU never sent the
share — not that a div was hidden. The share is identified by difference, not by
pixel size: LiveKit picks the simulcast layer per subscriber.

| measurement | viewer, on join | viewer, after one eye click | viewer, hidden again | control, same moments | sharer, own tile |
| :-- | :-- | :-- | :-- | :-- | :-- |
| video streams received | **2 (both cameras)** | 3 (cameras + share `640x360` @ 10 fps, 25 frames) | **2 — the share is gone** | 3 throughout (25 frames each window) | own camera + own share, 50 frames each |
| audio bytes / 2.5 s | 37.7 KB | 37.9 KB | 37.9 KB | 38.0–38.4 KB | 22.0–22.3 KB |
| tile | paused: "Stream paused" + **Watch** | video | paused again | video | no paused block, ever |
| account data writes so far | **0** | **0 — showing is not written** | 1 (`visible: false`) | 0 | — |

What the run established, check by check (22 checks, all `true`, `EXIT=0`):

- `streamHiddenOnJoin`, `pausedTileOnJoin`, `nothingStoredOnJoin` — the stream is
  not received at all until the viewer asks for it, the tile says "Stream paused"
  with a **Watch** button, and nothing was written to account data or to the cache
  in the process;
- `eyeShowsOnFirstClick`, `watchWroteNothing`, `eyeOpensNoMenu` — one click on the
  corner eye brings the share in (3 streams, `Subscribed: video screen_share` in
  the page log), it opens no menu, and it writes nothing: `localStorage` stays
  empty and there is no `PUT …/account_data/cc.plotina.voice_volumes`;
- `pausedTileOnHide`, `watchBroughtItBack`, `watchReachableFromKeyboard` — hiding
  again turns the tile into the paused block: "Stream paused | Watch", the
  participant's avatar under `rgba(0, 0, 0, 0.55)`, the Watch button at
  `opacity: 1` with no hover, and `pausedAboveBackground: true` from
  `document.elementsFromPoint` (the paint-order check the branch that added the
  block needed: `.bg` is a paint container, so a static overlay would be invisible
  while every style assertion passed). Tab focuses Watch, Enter brings the stream
  back;
- `viewerAudioKeptAfterHide`, `controlUnaffected`, `sharerUnaffected` — hiding one
  stream changes nothing for the audio, for the other viewer, or for the publisher;
- `hiddenAfterReload`, `stillHiddenAfterReload`, `accountDataWrite` — hiding is
  remembered: after a reload the tile is paused again, the share is not received,
  and the cache holds
  `{"@<sharer>:synapse.m.localhost#screenshare-video":{"visible":false,"ts":…}}`,
  the same account data event as the volumes;
- `sharerOwnStreamVisible` — a local share never consults the visibility model.

The negative control for this harness is a build of the same tree with one line
changed — `getStreamVisible` returning `true` for a key with no entry, i.e. the
behaviour before "hidden by default" — served on a second port and driven by the
same script. It exits non-zero: the viewer receives the share on join, the paused
tile is absent, and there is no "Show screen share" button to click. So the checks
above reject the old default rather than passing for any build.

Command:

```bash
# 1. a bundle of the pinned tag with the whole series applied
#    (build.py --mode source does this; any production build of it works)
# 2. serve it over HTTPS with the stand's certificate
node element-call/tests/live/serve_bundle.mjs <dist> 3443 <cert dir>   # key.pem + cert.pem
# 3. drive three browsers through both scenarios (the room comes from
#    ec-live-room.py: the stand's Synapse refuses EC's own room creation)
BASE_URL="https://localhost:3443/room/#?roomId=<url-encoded id>" EVIDENCE_DIR=/tmp/stream-proof \
  PLAYWRIGHT_FROM=<ec source tree>/package.json \
  node element-call/tests/live/stream_video_toggle_proof.mjs
```

Screenshots from the run: `01-viewer-arrives-hidden.png`, `02-viewer-receiving.png`,
`03-viewer-paused.png`, `04-viewer-shown-again.png`, `05-viewer-after-reload.png`,
plus `evidence.json` with every number above.

### What the live run showed about the UI

- With one remote share in a call, EC puts the share in the spotlight by itself,
  so the corner button is there without the viewer changing layout. The button is
  next to the volume button and is present even when the share has no audio (the
  volume button is not, because it is gated on `audioEnabled`).
- The control is one eye button: a click hides the stream and the same button
  (now the eye with the strike-through, labelled "Show screen share") brings it
  back. Hiding keeps the tile in place, now as the paused state with the avatar,
  «Стрим приостановлен» and the **Watch** button, so the way back is both in the
  middle of the tile and in its corner.
- In the grid layout the control is not shown: the tile chrome in grid is not the
  spotlight tile. Upstream's own per-share volume button is grid-less for the same
  reason, and this patch follows it rather than inventing a second control there.

### Earlier runs

The runs behind the three changes merged here are recorded in their own task
reports, and the numbers above were re-measured on the merged build; the older
record of the 2026-11-10 run is kept in `tests/live/EVIDENCE-2026-11-10.md`. It
predates the eye button and the paused tile, so its screenshots show the
single-item menu and the "Stream hidden" status line that this build no longer
has.

## Manual check, if the stand has to be rebuilt

1. two accounts in one call, A shares a screen with audio;
2. as B, the share's tile says «Стрим приостановлен» / "Stream paused", and B's console logs no
   `Subscribed: video screen_share`; `chrome://webrtc-internals` shows no inbound video stream for
   the share (2 inbound video streams would be one too many);
3. B clicks the eye in the stream tile's corner — once, no menu: the stream renders, `Subscribed:
   video screen_share` is logged, and no `PUT …/account_data/cc.plotina.voice_volumes` happens;
4. B clicks the same eye again: the tile turns into the paused state — dimmed avatar,
   «Стрим приостановлен», Watch button, with no hover and no menu — B's console logs
   `Unsubscribed: video screen_share`, and `chrome://webrtc-internals` shows the share's inbound
   video stream gone. Hiding writes `{"visible":false,…}`, so reloading B keeps it hidden;
5. A's voice and the share's audio still play for B, and A's own tile is never hidden;
6. press **Watch** in the paused tile: the stream renders again. B leaves, A stops and restarts the
   share, B rejoins: hidden again, because nothing was stored to say B wants it.

## Rollback

Remove `patches/0005-plotina-stream-video-toggle.patch` from the build. The keys under
`#screenshare-video` stay in account data as unknown-but-valid entries; `0004` ignores them because
they are not volume keys, and nothing else reads the event. To clean up, delete those keys from
`cc.plotina.voice_volumes`.