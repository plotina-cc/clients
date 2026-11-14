# FluffyChat with DeepFilterNet3

Plotina's Android build of [FluffyChat](https://github.com/krille-chan/fluffychat)
with DeepFilterNet3 (DFN3) denoising on outgoing call audio, on by default, no
user action.

**Status:** building in CI. `v2.11.3-plotina-fluffy.19` adds the in-app Plotina
logos, a reachable "Sign in" button and the `cc.plotina.fluffychat` OIDC scheme
that MAS requires; `.8` was the first release with FCM push and per-ABI splits;
earlier tags shipped the same denoiser as one fat APK.
The DFN3 path below was read from the pinned upstream, flutter_webrtc and
deep_filter sources and is covered by the APK-content check, but nobody has
listened to a call on a device yet.

## Upstream

| | |
|---|---|
| Tag | `v2.11.3` (`UPSTREAM_TAG`), commit `6fc4920` |
| Flutter | `3.47.8` (upstream `.fvmrc`) |
| Call stack | `livekit_client` 2.13.1, `flutter_webrtc` 1.6.2+hotfix.4 (both from `pubspec.lock`) |
| Patch | twenty-five: `0001` pubspec (DFN), `0002` plotina.cc defaults, `0003` push gateway, `0004` ABI splits vs `abiFilters`, `0005` GlitchTip, `0006` noise level, `0007` application id `cc.plotina.mobile`, `0008`-`0011` Plotina name/label/links/visible strings, `0012` intro buttons, `0013` OIDC scheme, `0014` no upstream support, `0015` About dialog, `0016` in-app updater, `0018` no donation/support prompts, `0019` one "Обновления" settings tab, `0020` build number in the update status, `0021` UTF-8 update manifests, `0023` personal names for contacts, `0024` live refresh of the preview author line, `0025` notification of a room is cancelled when the room is read, `0026` the push helper's fallback notification is dismissed as well, `0027` read rooms are dismissed when the app returns from the background (`patches/`); numbers are per directory, so nothing may reuse one. `0017` is retired: it was the room-keyed personal-name model, removed in favour of `0023`, and its number stays unused |

## What is in this directory

```
UPSTREAM_TAG                       v2.11.3
patches/0001-pubspec-add-plotina-dfn.patch
patches/0002-plotina-default-homeserver.patch
patches/0003-plotina-push-gateway.patch
patches/0004-split-per-abi-vs-abi-filters.patch
patches/0005-plotina-sentry.patch
patches/0006-plotina-noise-level.patch
patches/0007-plotina-application-id.patch
plotina_dfn/                       Flutter plugin (Android only)
  lib/plotina_dfn.dart             isAvailable / setEnabled / setAttenLim / frameLength / status
  android/…/PlotinaDfnPlugin.kt    attaches to flutter_webrtc, extracts the model
  android/…/DfnProcessor.kt        the audio-thread callback
  android/…/DfnNative.kt           JNI declarations, tolerates a missing .so
  rust/                            cdylib: JNI shim over libDF (`deep_filter`)
scripts/build-android.sh           same steps as CI, run locally
scripts/fetch-model.sh             downloads the model, SHA-256 pinned
patches/0012-plotina-intro-buttons.patch  intro "Sign in" always on-screen (see below)
patches/0013-plotina-oidc-scheme.patch    SSO scheme cc.plotina.fluffychat (MAS)
patches/0016-plotina-self-updater.patch   in-app updater (see "In-app updater")
patches/0018-plotina-remove-donations.patch  no donation/support prompts
patches/0019-plotina-updates-tab.patch      one "Обновления" settings tab
patches/0020-plotina-version-details.patch  build number in the update status
patches/0021-plotina-update-utf8.patch      UTF-8 update manifests
patches/0023-plotina-contact-names.patch    personal names for contacts (see below)
patches/0024-plotina-preview-live-refresh.patch  live refresh of the preview
                                 author line (see below)
patches/0025-plotina-cancel-on-read.patch  notification of a room is cancelled
                                 when the room is read (see below)
patches/0026-plotina-cancel-fallback.patch  the push helper's fallback
                                 notification is dismissed too (see below)
patches/0027-plotina-cancel-on-resume.patch  read rooms are dismissed when
                                 the app returns from the background (see
                                 below)
scripts/version-code.py          the versionCode formula, used by CI and by
                                 scripts/build-android.sh
tests/intro_plotina_test.dart    Flutter widget regression test for 0012
tests/plotina_contact_names_test.dart  Dart test for 0023 (copied into the
                                 upstream checkout to run)
tests/plotina_contact_name_entry_test.dart  Dart test for the two 0023 entry
                                 points, chat list and invite banner
tests/plotina_contact_name_refresh_test.dart  Dart test for 0024: the preview
                                 author line follows a live rename/reset
tests/plotina_push_cancel_test.dart  Dart test for 0025, 0026 and 0027:
                                 reading a room clears its notification, an
                                 unread room keeps its own, the push helper's
                                 fallback is cleared as well, and the return
                                 to the foreground clears what was read while
                                 the app was in the background
```

The patch adds only this to `pubspec.yaml`:

```yaml
  plotina_dfn:
    path: ../plotina_dfn
```

Gradle picks the Rust library up from
`plotina_dfn/android/src/main/jniLibs/<abi>/libplotina_dfn.so`, so **no Gradle
file of FluffyChat is modified**.

## Intro screen: the "Sign in" button (patch 0012)

On a OnePlus 13 (CPH2649, Android 16) the welcome screen showed the logo,
subtitle and description but the login controls were not reachable. Cause, in
upstream `lib/pages/intro/intro_page.dart`: the body is
`LayoutBuilder -> SingleChildScrollView -> ConstrainedBox(minHeight: viewport)
-> IntrinsicHeight -> Column(..., Spacer, buttons, SizedBox(36))`. The
`Spacer` bottom-anchors the buttons to the *reported* layout viewport, and the
content height is forced to exactly that viewport, so the scroll view has zero
scroll range. When the visible window is shorter than the height Flutter lays
out for (Android 16 floating/resized windows, stale surface metrics), the
buttons land below the visible area and cannot be scrolled to. Two of the
three buttons ("Create account", "Login with Matrix-ID") are additionally
hidden by design here because patch 0002 presets `plotina.cc` as homeserver
(`hasPresetHomeserver: true`); only "Sign in" should ever be visible in Plotina
builds.

`0012-plotina-intro-buttons.patch` replaces the `const Spacer(),` with a fixed
`const SizedBox(height: 32),` so the buttons flow directly under the
description: their y-position no longer depends on the reported viewport
height, and when the content does exceed a small window the scroll extent is
content-driven and actually scrolls.

Verified with the pinned Flutter 3.47.8, not by eye:
`git apply --check` passes against a clean `v2.11.3` clone; all twelve-plus-one
patches apply in order; `dart analyze lib/pages/intro/` is clean; and
`tests/intro_plotina_test.dart` (run inside a fully patched upstream checkout
after `flutter pub get && flutter gen-l10n`) boots the real `FluffyChatApp`
through its router and asserts, at 1440x3168@4.0 and at the user's
1438x2411@4.0 window, that "Sign in" renders fully inside the viewport and
within 64 dp of the description. The gap assertion is the regression gate:
254 dp (Spacer, unpatched) vs 48 dp (patched). Note the user's screenshot is
either an area-crop or a window shot of 1438x2411 (full screen is 1440x3168):
the bottom ~757 px of the device are not in it, so the photo alone cannot show
the button; the fix makes the question moot by placing the buttons right under
the description text, which *is* inside that frame.

## Noise suppression level

The strength is a global setting, not per call:

- Settings → Chat → **Sound**: a slider from 0 to 100 dB, default **40**.
- **100** removes the attenuation limit (`DfTract` treats >= 100 as unlimited).
- **0** bypasses the denoiser: the channel sets `DfnProcessor.bypass`, no audio
  reaches the Rust handle, and the model is not loaded at startup.
- Any other value is pushed into the live `DfTract` through
  `DfTract::set_atten_lim` under the same mutex as `process()`, so a change
  takes effect on the next 10 ms frame and does not restart the call.
- The value is stored in `shared_preferences` as
  `chat.fluffy.noise_suppression_level` (`AppSettings.noiseSuppressionLevel` in
  `0006`). On Android the plugin reads the same key from
  `FlutterSharedPreferences` in `onAttachedToEngine`, before the model load is
  queued, because Dart's `main()` runs after that point.

```dart
await PlotinaDfn.setAttenLim(45); // dB, 0..100, no-op outside Android
```

## Push (FCM)

The APK carries Firebase Cloud Messaging, so notifications do not depend on the
ntfy app. The build does what upstream's Play build does:

1. The `GOOGLE_SERVICES_JSON` secret (base64 of `google-services.json` for the
   Firebase project `plotina-push`; it has clients for both
   `chat.fluffy.fluffychat` and `io.element.android.x`) is decoded into
   `android/app/google-services.json` **before** Gradle configures the project:
   `android/settings.gradle.kts` only declares the
   `com.google.gms.google-services` plugin when that file already exists.
2. `bash scripts/add-firebase-messaging.sh` (upstream's own script) adds
   `fcm_shared_isolate` — which brings `firebase_core` and
   `firebase-messaging` — and uncomments the FCM paths in
   `lib/utils/background_push.dart` and `FcmPushService.kt`.
3. `0003` points `pushNotificationsGatewayUrl` at our sygnal,
   `https://push.plotina.cc/_matrix/push/v1/notify`.

`0004` is not about push: upstream's `ndk { abiFilters … }` workaround in
`android/app/build.gradle.kts` makes AGP reject `--split-per-abi` ("Conflicting
configuration … cannot be present when splits abi filters are set"), which is why
tag `…-fluffy.7` produced no APK at all. The patch applies the workaround only to
fat builds.

Checked on the released APKs of `v2.11.3-plotina-fluffy.8`: 30
`com/google/firebase` strings in `classes*.dex` (the zip entry names stay at 0 —
R8 dexes the classes, so `unzip -l | grep com/google/firebase` proves nothing),
`plotina-push` plus `gcm_defaultSenderId`/`google_app_id` in `resources.arsc`, and
the gateway URL in `libapp.so` with the old `push.fluffychat.im` default gone. The
CI step fails the build if any of that is missing.

## Limitations

- Android only. iOS/macOS have an equivalent hook
  (`common/darwin/Classes/AudioProcessingAdapter.m`,
  `ExternalAudioProcessingDelegate`), which is a small Swift follow-up, not done
  here. Linux/Windows have no hook at all
  (flutter-webrtc#2016).
- Only WebRTC capture is denoised. Voice messages go through the `record`
  package (`MediaRecorder`/`AudioRecord`) and are unaffected.
- webrtc-sdk passes **channel 0 only**. Mono calls are fine; a stereo capture
  would denoise the left channel only.
- 32-bit x86 is not a Flutter target, so there is no x86 build. x86_64 is built
  and works, including on emulators; if the native library ever fails to load,
  `DfnNative.available` stays false and audio passes through untouched.
- The built-in NS/AGC still run before DFN3 (double processing). Cheap to tune
  later via `androidUseHardwareAudioProcessing` / APM config if it matters.
- 48 kHz only: any other rate is passed through rather than resampled.
- Registration is process-global and happens once. `PlotinaDfn.setEnabled(false)`
  and `PlotinaDfn.setAttenLim(0)` switch processing off; the level is global
  (Settings → Chat), not per call.
- DFN3 adds its algorithmic lookahead (~10 ms). Irrelevant next to network
  jitter, but it is not zero.

## Personal names for contacts (patch `0023`)

Rename a *person*, not a chat: the name is keyed by the contact's mxid, so it
applies to the author line under a message, the participant list, mentions, the
DM title, the chat list row and the invite banner, and it is the same name in
every direct chat with that person. This replaced an earlier room-keyed model;
only one model exists now.

**Storage.** `cc.plotina.contact_names`, global account data, one map:

```json
{"@user:server": "Имя"}
```

Private to the account and never written to `m.room.member`, so nobody else's
profile changes and no room state moves. A reset (blank field) removes the key;
when the last name goes the event body is `{}` with no empty values left in it.
Nothing is ever written under `/state/`, and `m.room.name` is never touched —
a group keeps its own name.

**How it is applied.** `fluffychat/patches/0023` overrides the `matrix` package
with our fork `plotina-cc/matrix-dart-sdk` (tag `v14.1.0-plotina.1`, branch
`plotina/contact-names`, one commit on top of the released 14.1.0). The fork adds
`Client.localNameResolver`; the app installs one closure in
`ClientManager.createClient` (`lib/utils/plotina_contact_names.dart`) and
`User.displayName` becomes `resolveLocalName(id) ?? <member state name>`. The
member state name stays readable as `User.rawDisplayName`.

That single override is what makes every place work: `calcDisplayname` reads
`displayName`, `mention` and `mentionFragments` read `displayName`, and
`Room.getLocalizedDisplayname` builds a DM title from `hero.calcDisplayname()`.
Coverage therefore is:

| Place | Covered |
| --- | --- |
| Author under a message (`message.dart`) | yes |
| Participant list, member search filter | yes |
| DM / chat title bar, chat list row | yes |
| Invite banner (`chat_event_list.dart`) | yes — for a direct chat the contact name wins over the room name the inviter set; a group keeps its own name |
| Mentions and mention fragments | yes |
| Muted/pinned/room list names for DMs | yes |
| Push notification texts | no — they are built server-side / in the background isolate from the raw member state |
| Anything on the other side of the chat | no — by design, this is a private name |

**Two places outside the resolver.** Everything above is free, because the name
is substituted inside the SDK. Two call sites name a person *without* going
through it, and `lib/utils/plotina_contact_name_entry.dart` holds their decision:

- *the chat list entry* (`lib/pages/chat_list/chat_list.dart`) writes a name, so
  it has to know whose: `plotinaPersonalNameContactOf(room)` is
  `room.directChatMatrixID` (the `m.direct` partner, or the inviter of an
  `is_direct` invite), and `setPlotinaPersonalNameOfChat` writes that mxid. The
  dialog is prefilled with the contact's personal name and hints at the name
  everyone else sees (`rawDisplayName`);
- *the invite banner* (`lib/pages/chat/chat_event_list.dart`) used to build its
  label inline from `room.name` and the canonical alias, which bypassed every
  resolver. `plotinaInviteBannerName` gives the contact's personal name for a
  direct chat (falling back to the inviter's mxid when `m.direct` does not list
  the room yet), and keeps `m.room.name`, then the canonical alias, for a group
  — a group is never renamed by a contact name. The inviter is already named by
  the sentence around the label, and that name goes through the resolver.

**UI.** "Личное имя" is an entry in the member context menu
(`member_actions_popup_menu_button.dart`, offered for other people, not
yourself) and in the chat list context menu of a joined direct chat
(`chat_list.dart`). Both use `showTextInputDialog` and the `plotinaPersonalName*`
strings. The chat list entry is not offered for a group or an invite: there is
no contact to rename.

**Robustness.** The parser accepts the decoded map or a JSON string, trims
values, and skips blank values, non-strings and keys that are not mxids, returning
an empty map for missing or corrupt data instead of throwing. A resolver that
throws, or returns `null`/`''`/whitespace, leaves the upstream SDK behaviour
exactly as it was.

Tests: `tests/plotina_contact_names_test.dart`, 22 cases — parsing and junk
tolerance, set/reset semantics (a reset writes `{}`), the resolver in a real
`Client` (name set, name absent, empty map, junk, `rawDisplayName` intact, DM
title from heroes, mentions) and a real write proven to hit
`/user/.../account_data/cc.plotina.contact_names` only — no `/state/` request and
no `m.room.member` in any body.

`tests/plotina_contact_name_entry_test.dart`, 25 cases — the two entry points
above: the chat list entry writes the contact's mxid and nothing else (no room
key, no `/state/`, no `m.room.member`, no room-keyed account data), a reset
writes `{}`, a group is never written to, two direct chats with one person share
the name; the invite banner prefers the contact name over a room name the
inviter set, keeps a group's own name and alias, falls back to the "invited by"
sentence when there is neither, and never throws on junk. Three of them assert
the call sites are wired to these helpers and that nothing in `lib/` still
reaches for the removed room-keyed model.

Both files ship in the patch (`test/…`), so a patched checkout can run them right
away:

```
flutter pub get && flutter gen-l10n
flutter test test/plotina_contact_names_test.dart
flutter test test/plotina_contact_name_entry_test.dart
```

### The preview updates live (patch `0024`)

The name above reaches every widget that reads it per build — the DM title, the
DM row, the participant list. The author line that prefixes the last message in
a **group** preview did not: it came from a `FutureBuilder`'s `initialData`,
which the framework turns into the builder's snapshot once, in
`_FutureBuilderState.initState`, and replaces only when the `future` changes.
With the sender in member state the future is `null`, so the snapshot kept the
first string forever and a rename or reset left `QA-DOOR-B: привет из группы`
on screen until a cold start (QA `t_f2f5b871`, item 3).

`0024` derives the preview body in `build` and only uses the awaited future when
the sender has to be fetched first:

```dart
final previewBody = lastEvent?.calcLocalizedBodyFallback(...);
// …
: (snapshot.data ?? previewBody)?.trim().replaceAll('\n', ' ') ??
  L10n.of(context).noMessagesYet,
```

`tests/plotina_contact_name_refresh_test.dart`, 5 cases — renders a real
`ChatListItem` for a group whose last message is the contact's and asserts the
author line: set before the first build; rewritten after a live rename; falling
back to the real displayname after a live reset; the real displayname when no
personal name exists; unbroken by junk in the account data. A sixth case pins
the direct-chat rule — no sender prefix, before and after a rename. The two live
cases fail on the tree without `0024` (`initialData` restored) and pass with it.

Not covered: the dialogs have no widget test (they are plain
`showTextInputDialog` plus a menu entry), and the end-to-end check with two
accounts on a real homeserver belongs to QA. Push and local notification titles
are not covered (see the table). A name changed in *another* client while the
chat itself is open reaches the chat list on the next sync, but the app bar
title of the already-open chat re-renders on its next room update (or on
re-entering the chat), not instantly.

## Reading a room clears its notification (patch `0025`)

The symptom: a message arrives in another chat, the notification appears in the
Android shade, you open that chat and read it without tapping the notification —
and the notification stays until you tap it. The same happens when the room is
read on *another* device: the desktop sends the receipt, our sync learns the
room is read, and the phone keeps showing the notification.

This is not a Plotina patch that broke it. Upstream cancels notifications from
the sync stream (`cancelNotificationsOnSync`, upstream commit `ceb1331` "clear up
active notifications on sync on all platforms"), and that commit is in the
upstream tags **v2.11.2 and v2.11.5** but *not* in **v2.11.3**, the tag in
`UPSTREAM_TAG`. The v2.11.3 release does not carry it, so every build from it
has no sync-driven read → cancel path at all: the walk over the shade existed
only inside the push helper's clearing branch, where it runs when a push arrives
— never when a room is read.

`0025` reuses that walk instead of writing a second one. The block is lifted out
of the push helper's clearing branch into `cancelNotificationsOfReadRooms()` in
`lib/utils/push_helper.dart`, and both callers use it: the push helper itself,
and a new `onReadRooms` subscription in `lib/widgets/matrix.dart` on
`c.onSync.stream`. One implementation, so the read path and the push path cannot
drift apart.

It dismisses a room's notification when the sync says the room is not unread any
more (`!room.isUnreadOrInvited`), which covers all three ways a room becomes
read:

- read inside the app — `ChatPage.setReadMarker` sends the receipt, the sync
  that carries it back zeroes the unread counter;
- read on another device of the same account — only the sync says so, nothing
  happens locally;
- a cold start — the notification was posted while the app was closed, the
  message was read elsewhere, and the first sync already reports the room read.

Nothing is done twice: the walk only cancels ids that are still in the shade, so
the next sync with the same state cancels nothing and does not rebuild the
summary. Rooms that are still unread are never touched, and a notification whose
room is not in `client.rooms` (another account's, or not synced yet) is left
alone. `updateSummaryNotification` runs after a cancellation, so the group
summary is rebuilt from what is left instead of listing a room that is gone. The
tap handler (`notification_background_handler.dart`) is untouched: tapping a
notification still opens that chat.

Upstream's `ceb1331` also changes the desktop/web in-app notification ids, which
our Android-only build never reaches, and the push serialisation (`_pushLock`,
`syncPending`) comes from other v2.11.5 commits; neither is part of this patch.

### One id for show and cancel (the `.35-dev.1` defect)

The first build of this patch, `.35-dev.1`, reached the path and cancelled
nothing (QA `t_ece478f5` §3–§5). It was not the subscription, not the sync, not
the hash function: the notification was in the shade under one id and the walk
looked for another.

```
room !-CFM…   id in the shade (dumpsys) 672513629  = roomId.hashCode
              id the walk searched       711748308  = '${clientName}_$roomId'.hashCode
```

The id is decided when a notification is **posted**, from the payload it came
with: `push_helper.dart` shows under `PushNotification.notificationId`, which is
`roomId.hashCode` when the payload has no `devices[0].data.client_name` and the
prefixed id when it has. Both shapes reach a device —
`background_push.dart` fills `devices` with an empty list when UnifiedPush strips
it, and FCM counts pushes carry no `devices` at all — so the shade can hold
either id for the same room, and the read path cannot know which payload posted
what is in it now.

So the id is derived in one function, `plotinaNotificationIdForRoom()`, and the
cancel walk matches a shade entry against **both** ids that function can produce
(`plotinaNotificationIdIsForRoom()`). The show call itself moved into
`plotinaShowRoomNotification()`, which returns the id it posted under, so the
show path and the cancel path cannot compute different numbers again. The
messaging-style lookup that runs before the show now uses
`notification.notificationId` too — it used a second, prefixed formula and so
never found its own notification.

`fluffychat/tests/plotina_push_cancel_test.dart`, 14 cases, shipped into the
checkout as `test/plotina_push_cancel_test.dart` and run by the workflow before
the Gradle build. Every notification in the test is posted **through
`plotinaShowRoomNotification()`** — the function the push helper calls — with
the payload shape the device gets (no `client_name`), so the shade holds exactly
what a device holds and the test cannot agree with the cancel walk by
construction. On `.35-dev.1` that test failed with `Expected: [672513629]
Actual: []` — the two numbers from the device report — while the previous test,
which posted under the prefixed id itself, was green on the same broken build.

The sync responses are the JSON a server sends, the client is a real `Client` on
an in-memory SQLite database, and a fake
`FlutterLocalNotificationsPlatform.instance` puts `show` into the shade and
records `cancel`. The cases: read in the app → that room is cancelled and the
other one is not; read on another device (private receipt, no local action) →
cancelled; cold start → cancelled; a notification posted from a payload that
*does* carry a client name → cancelled too; still unread → kept; the same state
again → no second cancel and no second summary; the summary is rebuilt from what
is left; and, reading the sources, that `MatrixState` subscribes to `c.onSync`,
drops the subscription with the client, that `push_helper.dart` has one
definition of the walk and no copy of the old inline loop, that the show path and
the cancel path share one id function and no second id formula is left in the
file, and that the chat page still sets its own read marker and does not cancel
anything itself.

## The notification that survived everything: the push helper's fallback (`0026`)

`.35-dev.2` shipped `0025` and still left one notification in the shade. QA
(`t_5d226c8d`) dumped the shade while it hung: it was **not** a room
notification posted by the normal path. Id `143996333`, tag `null`, channel
`fluffychat_push`, `category=msg`, and — the field that matters — **no
`groupKey` at all**. Its text was «💬 New message in Plotina Mobile / Open app to
read messages», the wording of the fallback `push_helper()` shows from its
`catch` when the event cannot be fetched inside the timeout (slow network, a 5xx
or a cold start reproduce it; QA induced it deterministically behind a proxy).
The ordinary path cancelled 7/7; the fallback hung 3/3 and survived four app
launches.

The fallback posts with `groupKey: notification.clientName`, and our gateway
delivers `event_id_only` — the payload has no `devices`, so there is no
`client_name`, so the group key is `null`. The cancel walk of `0025` opened with

```dart
activeNotifications.removeWhere((n) => n.groupKey != clientName || …);
```

which drops every ungrouped entry before it ever asks which room that entry
belongs to. The id was never the problem here: show and cancel both used
`roomId.hashCode`, which is why the `.35-dev.1` id fix could not help.

`0026` changes what that filter means. Another account's notifications are
grouped under **its** client name and stay untouched; a `null` group key is not
another account — it is our own fallback, and it belongs to whichever room its
id names. So the walk keeps ungrouped entries, and the existing room lookup
(`plotinaNotificationIdIsForRoom`) decides: a room of this client that is not
unread is cancelled, everything else — still unread, unknown room, another
account — is left alone. The fallback show moved into
`plotinaShowFallbackNotification()`, the body of that `catch`, so the test posts
the notification through production instead of hand-building one, and it returns
the id it posted under.

The test fake also stopped lying about the group key: it used to stamp
`_clientName` on everything it was shown, which hid exactly this class of
notification. It now records the key the details carry, which is why the new
case fails on `.35-dev.2`'s code with `Expected: [672513629] Actual: []` — the
id from the device report.

Three cases are added, 14 in total: the fallback of a room that is read is
cancelled; the fallback of a room that is still unread stays in the shade; and
an ungrouped notification of **another account** is never touched, which is what
keeps the widened filter from reaching into someone else's shade.

## Read while the app was in the background (`0027`)

`0025` and `0026` both hang off the sync: the client learns a room is read
because a sync says so. In the background there is no sync — `MatrixState` sets
`client.backgroundSync = false` the moment the app leaves the foreground — so a
room read in Element X or on the desktop keeps its notification in the shade
until the next foreground sync, or forever if nothing arrives to trigger one.

`0027` does not add another walk over the shade. It adds the missing moment: the
`resumed` lifecycle event in `MatrixState.didChangeAppLifecycleState` hands every
client of the session to `cancelNotificationsOfReadRoomsOnResume()`, which is a
thin guard over the very same `cancelNotificationsOfReadRooms()` the sync
listener calls. One place walks the shade, two things drive it.

The guard is the previous lifecycle state: a `resumed` that follows another
`resumed` means the app never left the foreground, so nothing about the rooms can
have changed and the shade is not walked at all — fast app switching does not
turn into a cancel/summary storm. A real round trip through the background still
walks it, and the walk itself already cancels only what is read and rebuilds the
summary only when something was cancelled.

Five cases are added, 19 in total: a room read while the app was in the
background is dismissed (and the other room's notification is not); a room that
is still unread keeps its own and the summary is not re-posted; a second
`resumed` without changes cancels nothing, re-posts nothing and does not even
walk the shade, while a genuine background round trip walks once and cancels
nothing; leaving the foreground dismisses nothing; and the lifecycle listener is
wired at the source, for every client of the session.

## Building

CI: `.github/workflows/build-fluffychat.yml`, triggered by a tag matching
`v*-plotina-mobile.*` (for example `v2.11.3-plotina-mobile.22`) or by
`workflow_dispatch`. The client-specific suffix matters: this repository also
builds Cinny, and the generic `v*-plotina.*` pattern used to start every client's
workflow at once.

The job clones upstream at the tag in `UPSTREAM_TAG`, applies the patches in
name order, builds the Rust library for arm64-v8a / armeabi-v7a / x86_64 with
`cargo ndk`, then runs `flutter build apk --split-per-abi --build-number
<versionCode>` (the tag suffix, see "In-app updater"). Two of the three
splits are published: **`Plotina-Mobile.apk`** (arm64-v8a, what every recent
phone needs, and what the updater downloads) and
**`Plotina-Mobile-armv7.apk`** (older devices, manual install); x86_64 stays
with emulators. Alongside them the release carries **`update-mobile.json`**, and
`scripts/publish-clients.sh` copies all three to `https://plotina.cc/dl/`.

### Signing

The key is a PKCS12 keystore with alias `plotina`, valid until 2126. Add these
under *Settings → Secrets and variables → Actions*:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 plotina-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `plotina` |
| `ANDROID_KEY_PASSWORD` | key password (falls back to the store password) |

With them the workflow writes `android/key.properties` and
`android/plotina-release.jks` into the upstream clone, which is exactly what
upstream's `build.gradle.kts` reads (it asks for `key.properties` in the Android
root and a `storeFile` relative to `android/app`).

**Without them the workflow builds a debug APK**, signed with the standard
Android debug key. It installs and is fine for testing the denoiser, but it
cannot update an installed Plotina build (nor an F-Droid/Play install): a
signature change always means uninstall first, which loses the local database
unless a backup exists. Note that upstream's release signing config points at a
`dummy.keystore` that is not in its repository, so a plain `--release` build
without the secrets would fail rather than produce an unsigned APK.

Locally: `fluffychat/scripts/build-android.sh` (needs Flutter 3.47.8, Rust with
Android targets, `cargo-ndk`, SDK+NDK, JDK 17).

## Crash reporting (GlitchTip)

Own integration (patch `0005`): `sentry_flutter 9.30.1` plus `lib/utils/plotina_sentry.dart`.
The DSN comes from the `SENTRY_DSN` repository variable; the release is `fluffy@<version>+<tag>`,
environment `production`; tracing, screenshots and PII are off.

CI uploads symbols (`--split-debug-info`, R8 mapping, native libraries) with `sentry-cli` when
`SENTRY_AUTH_TOKEN` is set and keeps them as the `Plotina-Mobile-symbols` artifact.
Smoke test: build with `--dart-define=PLOTINA_SENTRY_TEST_EVENT=true`.

## In-app updater (patch `0016`)

We do not ship through Google Play, so the app updates itself from
`https://plotina.cc/dl/update-mobile.json`, written by CI next to the APKs on
every release:

```json
{"client":"mobile","package":"cc.plotina.mobile","versionName":"2.11.3",
 "versionCode":2112323,"apkUrl":"https://plotina.cc/dl/Plotina-Mobile.apk",
 "sha256":"<hex>","size":<bytes>,"notes":"<short ru text>"}
```

(`versionCode` here is the arm64 APK's own number, build 23 plus Flutter's ABI
digit — see "versionCode grows with every build" below.)

Flow (`lib/utils/updater/plotina_updater.dart`, native half
`android/app/src/main/kotlin/…/PlotinaUpdaterChannel.kt`):

1. Once a day at start-up (from `UpdateNotifier.showUpdateAvailableBanner`,
   the gate FluffyChat already had for Windows) and on demand from
   **Settings → "Проверить обновления"** and the **About** dialog, the manifest
   is fetched. `client` and `package` must match this install, or it is ignored.
2. `versionCode` is read from the PackageManager (channel `getVersionCode`) and
   compared. Newer → dialog with the version, the notes and the size; the
   user's "Later" is remembered per version, so the silent check does not nag.
3. Before downloading, `canRequestPackageInstalls()` is checked. If the user has
   not allowed installs from this source, an explanation is shown and
   `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` is opened for our package.
4. The APK is streamed into `<cache>/updates/Plotina-Mobile.apk` while sha256
   and size are computed, and compared with the manifest. A mismatch deletes the
   file and aborts; a cached, already-verified file is reused instead of
   downloaded again.
5. The verified file is handed to the system installer as a FileProvider
   `content://` URI (`ACTION_VIEW`,
   `application/vnd.android.package-archive`,
   authority `cc.plotina.mobile.updater.fileprovider`).

Two things are deliberately narrower than "auto-update":

- The manifest carries only the **arm64** APK. A 32-bit-only device is told to
  fetch `Plotina-Mobile-armv7.apk` by hand instead of being offered an APK the
  installer would reject with `INSTALL_FAILED_NO_MATCHING_ABIS`.
- `plotina.cc/dl` is served by the edge host, not by GitHub:
  `scripts/publish-clients.sh` copies `Plotina-Mobile.apk`,
  `Plotina-Mobile-armv7.apk` and `update-mobile.json` out of the release. Until
  they are published there, the check answers "could not check for updates".

### versionCode grows with every build

`flutter build apk --build-number` sets it, so it must be derived from the
release tag rather than from upstream's `2.11.3+3574` (which repeats). With
`versionName = major.minor.patch` and the tag suffix `N`
(`v2.11.3-plotina-mobile.23` → 23):

```
build number = major * 1_000_000 + minor * 10_000 + patch * 100 + N
2.11.3 + build 23 → 2*1000000 + 11*10000 + 3*100 + 23 = 2110323
```

**The APK does not carry that number.** `--split-per-abi` makes Flutter's
Gradle plugin write `abi * 1000 + build number` into each split
(`FlutterPlugin.kt`; `armeabi-v7a` 1, `arm64-v8a` 2, `x86_64` 4), so the arm64
APK of build 23 reports **2112323** and the armv7 one **2111323** — the released
`.22` APKs show the same offset (build 32 → 2032 / 1032). The app compares its
own PackageManager versionCode with `update-mobile.json`, so the manifest
publishes the *arm64 APK's* number, read back out of the built APK; the two
families never compare against each other because 32-bit devices are pointed at
the armv7 APK by hand.

`minor < 100`, `patch < 10` and `0 ≤ N < 100`, so `patch * 100 + N ≤ 999` can
never carry into the ABI digit, and `scripts/version-code.py` exits non-zero
outside those slots — a mistake fails the build instead of emitting a number
that sorts below an older one. Untagged local builds use `N = 0`, which never
offers an update over a released APK. CI computes the expectation from
`GITHUB_REF_NAME`, `scripts/build-android.sh` from `git describe` (or
`PLOTINA_BUILD=<n>`), and the workflow reads both APKs back with
`aapt`/`apkanalyzer`, fails on a mismatch, and only then writes the manifest.
The first run of this check caught the offset for real: it expected 2110323,
the APK said 2112323, and the release was stopped.

Point the updater at a local server while testing with
`PLOTINA_UPDATE_URL=http://10.0.2.2:8000/update-mobile.json`
(build-android.sh forwards it as `--dart-define`).

`fluffychat/tests/updater_manifest_test.dart` covers the parser: the contract
above, numeric strings, uppercase sha256, missing fields and garbage all either
parse or get rejected without throwing out of the daily check.

### Dev update channel (`v<base>-plotina-mobile.<N>-dev.<M>`)

**Settings → "Канал обновлений" / "Update channel"** (patch `0016`,
`lib/pages/updater/update_channel_selector.dart`) lets one install opt into the
dev feed instead of `plotina.cc/dl`:

```
https://github.com/plotina-cc/clients/releases/download/dev-latest/update-mobile-dev.json
```

A dev build is tagged `v2.11.3-plotina-mobile.28-dev.1` and

- **keeps the versionCode of the stable `.N` it is based on** — 2110328, so the
  arm64 APK reports 2112328, exactly the published stable's number — and changes
  only the versionName to `2.11.3-dev.1` through `--build-name`. Same package,
  same signing key and an *equal* versionCode reinstall over the stable in place
  (AOSP `checkDowngrade` rejects lower codes, not equal ones), and the next
  stable (`.29` → 2112329) is an ordinary upgrade back;
- because the codes are equal, dev-to-dev ordering cannot use them: the app
  parses the `-dev.<M>` suffix of its own versionName
  (`PlotinaUpdater.devBuildOf`) and compares it against the `devBuild` field of
  the dev manifest, so dev 2 is offered over dev 1 and a dev manifest that
  omits `devBuild` offers nothing to an install that already carries that code
  (`compareUpdate` returns `upToDate`, never a reinstall of the same file);
- is published **only** to the fixed `dev-latest` prerelease (the workflow's
  "Attach to dev-latest release" step, which creates it on the first dev run).
  Dev artifacts never reach a per-tag release or `plotina.cc/dl`, so switching
  the setting back to Stable is enough to be governed by released builds again;
- must sit on the **latest published stable**: CI's "Check the dev base is
  published" step runs `scripts/version-code.py --check-dev-base` against the
  remote tag list and refuses a dev tag whose base was never released or is
  behind the current stable, before the 30-minute build is spent.

Locally: `PLOTINA_DEV=1 PLOTINA_BUILD=28 scripts/build-android.sh` produces
`2.11.3-dev.1` with the stable `.28` versionCode, and
`PLOTINA_DEV_UPDATE_URL=…` points the dev feed at a local server the same way
`PLOTINA_UPDATE_URL` points the stable one.

`fluffychat/tests/test_version_code.py` pins the tag grammar, the shared
versionCode and the dev-base check; `upstream/test/utils/updater/`
(`update_channel_test.dart`, `plotina_updater_flow_test.dart`) pins the channel
default (stable, also when the store is unreadable), the `devBuild` tie-break and
the feed URLs, and `flutter test test/utils/updater/` is the harness for it.
The Python half now also runs in CI as a build gate ("Run updater and
versionCode tests").

## Updates screen, donations, manifest encoding (patches `0018`-`0021`)

Four small patches ride on top of `0016`, all inside the updater's own files:

- **`0018` no donation/support prompts.** `possibleByYou` ("This release was
  only possible thanks to your support…") becomes a plain thank-you in
  `intl_en.arb` and `intl_ru.arb`, the `support` entry is gone from the chat-list
  menu (`client_chooser_button.dart`: the `SettingsAction.support` case and the
  enum value) and the "поддержать" button is gone from the update snackbar's
  dialog actions. Nothing links to ko-fi any more.
- **`0019` one "Обновления" settings row.** `Settings → "Обновления"` opens
  `lib/pages/updater/plotina_updates_page.dart` — the manual check first, then
  the `UpdateChannelTile` below a divider — instead of exposing "Проверить
  обновления" and "Канал обновлений" as two rows of the top-level list. New
  l10n key `updates`.
- **`0020` build number in the update status.** New key `updateBuild`
  ("build {code}" / "сборка {code}"), appended to the version in the
  *up to date* / *waiting for stable* states and on the update card, read from
  `PlotinaUpdater.currentVersionCode()` — so a dev build (same versionCode as
  its stable base, different `-dev.<M>`) can be told apart on screen.
- **`0021` UTF-8 update manifests.** The manifest is decoded from
  `response.bodyBytes` with `utf8.decode(..., allowMalformed: true)`: GitHub
  serves release assets without a charset, `package:http` then falls back to
  Latin-1 and the Russian `notes` came out as mojibake on the `dev-latest` feed.

The Dart coverage from `0016` (`flutter test test/utils/updater/`) exercises
these paths; `0018`-`0021` add no separate harness.

## Licensing

Our code: AGPL-3.0-or-later, like upstream. DeepFilterNet (`deep_filter`
crate and the model) is MIT/Apache-2.0; the model is redistributed unchanged
from the upstream release. Its licence texts are in `plotina_dfn/assets/` and
are declared as Flutter assets, so they travel inside the APK.

The APK is built from `krille-chan/fluffychat` at `v2.11.3` plus `patches/` and
`plotina_dfn/`. The release notes and `../SOURCE.md` name the upstream tag and
the rebuild command; the same repository and tag are the corresponding source.
