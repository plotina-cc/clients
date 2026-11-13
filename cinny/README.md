# Cinny for plotina.cc

One directory per client, because the modification is the same for both
surfaces: the web app and the desktop build consume the shared wrapper in
`../noise/` (`logic.js`, `boot.js`, `vendor/` with DeepFilterNet3) plus the
source patches in `patches/` — `0009` compiles the Settings → General noise
block into the bundle as a React component. Only the delivery differs — the
web client is served as static files, the desktop build compiles the dist into
a Tauri binary.

No source fork is needed: Cinny is taken at a pinned tag, the **built web dist**
is patched before packaging, and the installers are built with our own config.

## Source and licence

The web app and the desktop build are Cinny `v4.12.8` plus `patches/`,
`apply-noise.py` and `branding.py`. The source pair — upstream tag plus this
repository — is in `../SOURCE.md`. Patch `0002-plotina-source-link.patch` adds
the "Исходный код" link to the auth footer and to Settings → About; both point
at <https://github.com/plotina-cc/clients>. `apply-noise.py` copies
`../LICENSE` and `../NOTICE` into the dist as `LICENSE-AGPL-3.0` and `NOTICE`.
`branding.py` owns the browser shell: icons, HTML metadata and the web app
manifest, plus one pinned bundle default — fresh visitors get "follow the
system theme" (`useSystemTheme`), which renders Dark on a dark OS and Light
otherwise. The guard in `branding.py` rewrites `useSystemTheme:!1` back on
and aborts the build if the settings default is missing from the bundle.

## What is here

```
config.json          default homeserver (plotina.cc), no featured communities
UPSTREAM_TAG         the cinny-desktop tag we build against
element-call.lock.json  tag + URL + sha256 of OUR Element Call archive (same pin as Desktop)
apply-noise.py       finishes the dist: removes any stale noise/ copy, adds licences, gates the call frame
branding.py          applies Plotina icons, HTML metadata and manifest to the dist
tests/               unit tests for branding.py (python3 -m unittest discover -s cinny/tests),
                     for the DM-name patch (scripts/test-dm-aliases.sh) and for the
                     Sentry noise filter (scripts/test-sentry-filter.sh)
tauri.plotina.json   build override: no beforeBuildCommand, updater disabled
noise.lock.json      URL and sha256 of the two model binaries (wasm and .tar.gz)
scripts/build.sh     local Linux build (AppImage + deb)
scripts/mount-element-call.py  installs our Element Call into dist/public/element-call/
scripts/fetch-noise.py  downloads the model into noise/, verifying sha256
windows/             our NSIS installer: installer.nsi + build-installer.sh
```

## Cinny Web

Static files on the edge (`/srv/cinny`), built by
`.github/workflows/build-cinny-web.yml` and unpacked there unchanged: the
workflow takes the tag from `UPSTREAM_TAG`, applies the patches in `patches/`
(Sentry, branding, SSO handoff, the Updates page, the noise settings block and
the call-widget patch), mounts our Element Call archive into
`public/element-call/` (pin and digest in `element-call.lock.json`; the denoiser
travels inside the mount) and uploads `plotina-lite-web.tar.gz` with
`build-info.json` next to it (release, upstream tag, the repository commit and
the Cinny commit, run).

```bash
sha256sum -c plotina-lite-web.tar.gz.sha256
sudo mkdir -p /srv/cinny.new && sudo tar -xzf plotina-lite-web.tar.gz -C /srv/cinny.new
sudo chown -R bob3r:bob3r /srv/cinny.new
sudo sh -c 'mv /srv/cinny /srv/cinny.bak-$(date +%Y%m%d-%H%M%S) && mv /srv/cinny.new /srv/cinny'
```

Caddy reads the directory per request and needs no reload; the previous tree
stays as `/srv/cinny.bak-<timestamp>` and rolling back is renaming the two back.
Cache headers are the part Caddy does own: `/noise/dfn/*` for 30 days,
`/noise/*.js` as `no-cache`, and `index.html` as `no-cache` so a new shell with
new asset hashes is picked up.

**Why the call frame carries the denoiser and the shell does not.** Cinny renders
calls in an iframe pointing at `public/element-call/index.html`, and that frame is
now OUR Element Call (`scripts/mount-element-call.py`, the same archive Desktop
ships) rather than upstream's embedded 0.20.1. The frame has its own `window`, so
wrapping `getUserMedia` in the parent page would never see the call; the denoiser
therefore travels INSIDE the mount (`public/element-call/noise/`), where the
archive's own `index.html` loads `logic.js` + `boot.js`. The parent needs no noise
script at all: the Settings → General block is React (`patches/0009`) and shares
the `plotina.noise.*` localStorage keys with the frame — same origin, so a write
there fires a `storage` event in the call, where boot.js retunes the running
processors. The dist root used to get a 50 MB copy of `noise/` that no frame ever
fetched; `apply-noise.py` now removes that copy if it finds one.

Verifying: `https://cinny.plotina.cc/public/element-call/noise/logic.js` returns 200
(the denoiser lives inside the mount now, not at the site root); Settings →
General shows the noise slider above Appearance with the default level 60
(`localStorage: plotina.noise.level`); inside a call, in the iframe,
`window.__plotinaNoise.isSupported()` is `true` and `window.__plotinaNoiseStats`
counts `callRequests`, `otherAudioRequests`, `processed` and `failed` — that is
how an upstream change in the constraint shape shows up.

## Personal names for contacts

`patches/0012-plotina-contact-names.patch`. A person can be called one thing for
this account while their own profile keeps their real name, and the name follows
the PERSON: two direct chats with the same contact show one name, and so does
every group you share with them. The name lives in the account's own account
data, type `cc.plotina.contact_names`, `{"<mxid>": "<personal name>"}` — the same
event Element Web/Desktop and Mobile write, so a name set in one client shows up
in the others. `m.room.name` is never written and neither is `m.room.member`; an
empty value means reset and drops the key, and resetting the last name leaves the
event as `{}` (Matrix gives clients no way to delete account data). The old
room-keyed event `cc.plotina.room_aliases` is not read, not written and NOT
migrated: its keys are room ids, so they are read as junk.

Priority for a person's name, everywhere the client shows one: the personal name,
then the member's own displayname (`m.room.member`), then the mxid localpart.

### The name of a dialogue

The patch rides the SDK instead of patching React. matrix-js-sdk computes every
room's displayed name in `Room.calculateRoomName()` and lets the application
override the answer through `client.roomNameGenerator(roomId, state)`; Cinny
never sets that hook, so `0012` installs one in `src/client/initMatrix.ts`. It
resolves the room's PARTNER (from `m.direct`, an `is_direct` invite, or exactly
two joined members — the same rule the Element overlay uses) and looks that
mxid up in the map. The room id's shape is never consulted: room version 12 ids
are opaque `!<base64url>` with no `:server`, so any shape rule would skip
production DMs. One point covers the chat list, the open chat's header, room
settings, notifications, message search and the A→Z room order, because all of
them read `Room.name`/`Room.normalizedName`. A group is never masked: without a
single partner there is no contact and nothing is looked up.

Account data is not room state, so the patch also listens for the event and
calls `Room.recalculate()` — which emits `Room.name` — and the list repaints
without a reload. That listener alone is not enough on a cold start, which is
why the patch also recomputes on `ClientEvent.Room` and once the first sync is
applied (`SyncState.Prepared`). The SDK's first `/sync` carries global account
data before the room sections, and it recalculates a brand-new room *before*
`storeRoom()` — so inside the generator `client.getRoom(id)` is still empty for
that room, the room is born with its member-list name, and nothing recomputes
it: the chat list showed the old name until the room was opened or a message
arrived (the defect QA found after a client restart). Both hooks are covered by
`tests/contact_names.test.mjs`, including a rehearsal of that exact SDK order.

### The name of a person, in a group too

Cinny has no SDK-level hook for a MEMBER's name, so this half lives in the one
display point instead: `getMemberDisplayName(room, userId)` in
`src/app/utils/room.ts` returns `personalNameForMember(...) ?? memberOwnName(...)`.
32 of the 35 member-name reads in the client go through it — the author line, the
member tile, the member drawer, reactions, replies, room search results, the
intros and every call surface — so a contact named "Денчик" reads "Денчик" in
every group as well as in the DM. Two call sites bypassed it upstream and are
covered too: `UserMentionAutocomplete` inserted `roomMember.name` into the
mention pill (it now resolves the same name as every other surface), and the
member list's A-Z comparators read `RoomMember.name` directly (`useMemberSort`
takes the resolver, so the order matches the names on the tiles).

Every one of those reads is synchronous — none of them holds the name in React
state — so a rename from this device or another one would leave an OPEN room
showing the old name. `subscribeContactNames()` / `usePlotinaContactNamesRepaint()`
close that: one subscriber at the top of the open room re-renders the subtree
that names people. The chat list needs none of it, because it repaints through
`Room.name`.

The way in is the room's context menu: "Личное имя" / "Personal name", shown for
direct chats only, with Save and Reset. Storage rules, the client glue and the
member-name surfaces are covered by `tests/contact_names.test.mjs` and
`tests/member_names.test.mjs`; `scripts/test-dm-aliases.sh` exports the pinned
tag, applies `patches/`, bundles the modules with the esbuild from Cinny's
dependency tree and runs `node --test` (node 18+).
`scripts/member-names-negative-control.sh` builds the member-name suite against
upstream's own `room.ts` and requires it to fail — a suite that passed on
unpatched code would prove nothing. The Electron build needs nothing of its
own: `stage-web.sh` stages this same web dist, so both Lite surfaces carry the
name.

## Error reporting

Upstream Cinny has no Sentry support of its own: no `@sentry` dependency, no
`sentry` key in `config.json`, nothing in the Tauri shell. The integration is
therefore a patch — `patches/0001-plotina-sentry.patch` adds
`src/plotina/sentry.ts`, calls it from `src/index.tsx` before the first render,
and switches Vite to hidden source maps. `scripts/build.sh` and the CI workflow
apply that same patch and both fail loudly if a future upstream tag moves
`src/index.tsx` or the `build` block of `vite.config.js`.

The DSN comes from `VITE_SENTRY_DSN` and the release from
`VITE_SENTRY_RELEASE`, both read at build time. They are optional: an empty DSN
turns reporting off and changes nothing else, which is what `npm start` and a
plain fork get. Only errors are sent — no tracing, no PII, and no breadcrumbs or
HTTP context, because a Matrix client's console output and URLs carry room, user
and event identifiers.

```bash
VITE_SENTRY_DSN="https://<key>@sentry.plotina.cc/relay/1" \
VITE_SENTRY_RELEASE="cinny@4.12.8" \
  scripts/build.sh
```

The release is `cinny@<version>` — `cinny@4.12.8` for upstream tag v4.12.8 —
and a tag of this repository is used as is (`cinny@v4.12.8-plotina-lite-desktop.4`),
which is the string the desktop build reports. `build.sh` falls back to
`cinny@<upstream tag>-local` on a checkout that is not at a tag. Events land in
the `web-clients` project with environment `production` and the tag
`client: cinny`. The web bundle on the edge must be built with the same
`VITE_SENTRY_RELEASE` as the maps, otherwise its events will not match them —
that is why the web build takes the release from `UPSTREAM_TAG` and never from
a branch name.

`scripts/sentry-sourcemaps.py` copies the app bundle's maps — everything under
`dist/assets` plus the root service worker — and the scripts they describe to
`$WORK/sourcemaps`, then removes the maps from `dist`, so neither the
installers nor `/srv/cinny` ship the TypeScript source. `dist/public` is left
alone: it holds packages we do not build (our mounted Element Call, the pdf.js
worker) and their symbols belong to whoever builds them. CI injects
debug ids with sentry-cli and uploads that copy:

```bash
sentry-cli releases new "$release"
sentry-cli sourcemaps upload --release "$release" --url-prefix "~" "$maps"
```

`https://sentry.plotina.cc/api/0/*` is a token-gated proxy in the relay
(`Authorization: Bearer` from `/etc/plotina-sentry-relay/api-token`), so the
upload runs in CI with `SENTRY_AUTH_TOKEN` and a rejection is a real failure,
not the old 403. `build-cinny-web.yml` uploads the maps for `cinny@4.12.8` and
the artifact records the debug ids, which is what pairs an event with its map;
the release and the tag `client: cinny` are visible in every event.

Do **not** also inject a shell-level Sentry script (such as a vendored
`/noise/vendor/sentry-global.js`) into `index.html`: the bundle reports for
itself, and a second `Sentry.init` would replace this client and lose the
release and the source-map pairing.

### What is not sent

The same patch carries a `beforeSend` filter (`src/plotina/sentryFilter.ts`)
that drops one class of events: the promises upstream Cinny v4.12.8 and
`matrix-widget-api` abandon, which nobody awaits and whose rejections only
exist because this layer listens. Six GlitchTip alerts (#70-#75) were triaged
and all six are upstream — a widget-transport timeout, a widget that answers
after `dispose()`, a spec-versions fetch that fails at startup, and a URL
preview the server refuses with 403 because previews are off in
`homeserver.yaml`. Four signatures, each with its own evidence:

| dropped when | why it is not ours |
|---|---|
| `Request timed out` | `matrix-widget-api` `PostmessageTransport`, 10-second deadline in `sendComplete` |
| `Not ready or unknown widget ID` | the same transport, called after the call widget was stopped |
| value contains `URL Previews are disabled` | Synapse's answer to `preview_url` with `url_preview_enabled: false` |
| `Failed to fetch` **and** the failed request went to `/_matrix/client/versions` | `specVersions()` at startup, whose error the loader already shows on screen |

Every rule also requires the SDK's `onunhandledrejection` mechanism, and the
last one requires the request URL the fetch probe recorded — plain `Failed to
fetch` is the text of every network failure in a web client, so filtering it by
text alone would hide a login that cannot reach the homeserver. `beforeSend`
rather than `ignoreErrors` for exactly that reason: it sees the exception type,
the mechanism and the `hint.originalException`, not just a message. A render
crash, a network failure at login, an exception with one of the texts above that
somebody actually threw, and any event the filter does not recognise are sent as
before — the filter fails open.

`scripts/test-sentry-filter.sh [UPSTREAM_SRC]` pins both halves: it exports the
pinned tag, applies `patches/`, bundles `src/plotina/sentry.ts` with
`@sentry/browser` aliased to a stub that records the options, and requires the
noise signatures to be dropped *and* a render crash, a login failure, an
unannotated `Failed to fetch` and a handled exception with the same texts to
survive (`node --test`). Both Cinny workflows run it after `npm ci`.

## Cinny Desktop

```bash
git clone --recurse-submodules --depth 1 --branch "$(cat UPSTREAM_TAG)" \
  https://github.com/cinnyapp/cinny-desktop.git upstream
cd upstream && npm ci
cd cinny && npm ci && npm run build && cd ..

mkdir -p noise/vendor
cp ../noise/logic.js ../noise/boot.js noise/
cp -a ../noise/vendor/. noise/vendor/
python3 scripts/fetch-noise.py
cp config.json upstream/config.json
# Our Element Call replaces upstream's embedded 0.20.1 in dist/public/element-call/
python3 scripts/mount-element-call.py --dist upstream/cinny/dist \
  --lock element-call.lock.json --work "$PWD/.build/element-call"
python3 apply-noise.py --dist upstream/cinny/dist
python3 branding.py --dist upstream/cinny/dist --brand "Plotina Lite Desktop"
npm run tauri -- build --config "$PWD/tauri.plotina.json"
```

Artifacts land in `upstream/src-tauri/target/release/bundle/{appimage,deb}/`.
Windows is cross-built (`cargo-xwin`, `--no-bundle`) and wrapped by
`windows/installer.nsi` through `makensis`; the comments inside those files list
the details. CI does the same natively on windows-latest.

### Sign-in (SSO) stays inside the app

Both Matrix sign-in paths open a *new window* and expect the answer to come back
to the window that opened it:

- the login page's **Continue with SSO** hands `/login/sso/redirect?...redirectUrl=<app origin>/login/...`
  to the browser and waits to be called back with `?loginToken=`;
- the UIA stage (`SSOStage.tsx`) calls `window.open(getFallbackAuthUrl(...))` and waits
  for `postMessage('authDone')` from the homeserver's completion page — Synapse's
  `auth_success.html` really does `window.opener.postMessage("authDone", "*")`.

With the upstream shell (`on_new_window` → `open_url` + `NewWindowResponse::Deny`)
both paths break the same way: `window.open` returns `null`, the dialog never
leaves "Continue with SSO", and the identity provider answers a *system browser*
that has no `window.opener` and no session in the app.

`desktop-patches/0002` keeps Matrix sign-in URLs in the app: `on_new_window` opens
them in a child webview built with `.window_features(features)`, which on GTK makes
the child a *related view* of the caller. WebKit then preserves the real opener
link, so `window.open` returns a live window object, `postMessage` from the
sign-in page reaches the app, and the `loginToken` callback lands on the app's own
origin (`http://localhost:<port>`, served by tauri-plugin-localhost). Every other
URL still goes to the system browser through `tauri-plugin-opener`. The child
window is deliberately absent from `capabilities/*.json` — only `main` is listed —
so a remote sign-in page gets no IPC access (the CVE-2024-35222 class).

`patches/0007` closes the loop for the login page. The callback arrives in the
child window, and a login token can be spent only once, so that window posts
`{type: 'plotina:sso:login-token', loginToken}` to its opener — restricted to its
own origin — and the main window runs `m.login.token` itself. In the browser build
the login page is never opened as a popup, `window.opener` is null there, neither
branch runs, and the web flow is unchanged.

`patches/0008` adds the Settings → **Обновления** page
(`SettingsPages.UpdatesPage`, menu item with `Icons.Download`, component
`src/app/features/settings/updates/Updates.tsx`). It is the renderer half of
the Lite Desktop update channel and speaks only through the preload bridge
(`window.plotinaLite`: `appVersion()`, `updater.checkForUpdates()`,
`updater.onStatus`, `updater.channel.{get,set,returnToStable}`), so all dev
acknowledgement and downgrade policy stays in the main process. On Cinny Web
the bridge is absent and the page shows an explanatory notice. It replaces the
floating bottom-right update button that overlapped the composer.

`patches/0009` adds the noise settings block to Settings → **General**
(`src/app/features/settings/general/PlotinaNoise.tsx`, rendered above
Appearance): Cinny's own `SequenceCard`/`SettingTile`/`Box`/`Text` plus a
native range input and a native backend select, reading and writing the same
`plotina.noise.level` / `plotina.noise.backend` keys boot.js consumes. It
replaces the DOM block `noise/cinny-ui.js` used to inject with a
MutationObserver, anchor text search, colour sampling and hand-written CSS —
that file is deleted, and the shell no longer carries any noise `<script>`
tags.

**Why not point the app at our website.** Tauri can open an external URL, but
then the remote page needs IPC access — that is the CVE-2024-35222 class of
vulnerability. The web part is compiled into the app instead, and updates only
come from our own builds.

## Licence

Cinny and cinny-desktop are AGPL-3.0. We distribute modified binaries and serve
the web build over the network, so we must offer the corresponding source: this
public repository is that offer. Do not remove the upstream copyright notices.

## Build inputs

The desktop bundle embeds the shared `noise/` layer at build time, so the
default suppression level and the settings block come from whatever `noise/`
held when the tag was cut. The web build is served from the same files, which
is why the two must be rebuilt together after a change there.
