# Personal names for contacts (patch 0015)

Wish: a user can give a contact their own name, and every conversation with that person shows it —
in every Plotina client. The name belongs to the person, not to the room, so two dialogues with the
same person show one name and a new one shows it at once. In Element Web/Desktop the same contract
lives in `element-web/plotina-dm-aliases.js`, and in Mobile (FluffyChat) in patch `0023` + the
`matrix-dart-sdk` fork; this is the Element X (Android) half.

## The contract (shared with the other clients)

Account data of the account, type `cc.plotina.contact_names`, content
`{"<mxid>": "<personal name>"}`, e.g. `{"@bob:plotina.cc": "Денчик"}`.

- The key is the contact's matrix id (`@localpart:server`), never a room id. That is what makes one
  name cover every dialogue with the person.
- The name belongs to the account that wrote it: it is account data, so no other member of the room
  receives it. `m.room.member` is **never** written either.
- `m.room.name` is **never** written. The room's state, and therefore the name the other side sees,
  does not change.
- A blank or whitespace-only value means "no personal name": the key is dropped, and resetting the
  last name leaves `{}` behind rather than an empty string. Values are stored trimmed.
- Content that is blank, broken or not a JSON object of mxid to non-blank string is ignored: the
  client behaves as if no personal name existed. Keys that are not mxids are junk — which is exactly
  why the previous, room-keyed event `cc.plotina.room_aliases` is **not read and not migrated**: its
  keys are room ids, they fall out as junk, and the names in it are lost by decision of the owner.
  An account data event type cannot be deleted from Matrix, so the old event will stay on the server
  forever; nothing here reads it.
- The parser accepts what the other clients write and drops what it cannot understand instead of
  failing, so a payload from Mobile or Web is read byte for byte and a foreign one is not fatal.

## Where the name is applied

The SDK computes the room's display name (`RoomInfo.displayName` from the Rust
`Room::cached_display_name`) and Element X reads it in three places. All three are covered, none by a
Rust change:

| What | Where |
| --- | --- |
| Room list rows | `RoomListRoomSummaryFactory` (`features/home/impl`), through `RoomInfo.withPlotinaContactName` |
| Open chat title, and the room details header | `RustBaseRoom.roomInfoFlow` (`libraries/matrix/impl`), which combines the SDK room info with the account's names and `m.direct` |
| Room name in the room details screen (and anything else reading `roomInfoFlow`) | same flow |

The overlay replaces `RoomInfo.name` only. `RoomInfo.rawName` — the value that mirrors the
`m.room.name` state event — is left as the SDK reported it, and nothing in this patch sends a room
state event.

A name is only applied to a personal dialogue: the SDK's `isDirect` (`m.direct`) or `isDm` (the
two-member rooms the app already presents as a DM). A group keeps its own name even when a name
exists for one of its members. A room whose own `m.room.name` is set keeps it in the title: a
personal name renames a person, not a room (the same rule as the Mobile client, where
`getLocalizedDisplayname` returns the room's name before the heroes).

**Which contact a room is with** (`PlotinaContactNames.counterpart`): the SDK's single hero of a DM
(`RoomInfo.heroes`, filled by `elementHeroes()` only for a two-member DM), and for a room that is
only flagged direct an entry of the account's own `m.direct` map, read backwards by
`PlotinaDirectRooms.parse`.

## Where the event is read

`ContactNameStore` (`libraries/matrix/api`, implemented by `RustContactNameStore` in
`libraries/matrix/impl`) is session scoped and publishes two `StateFlow`s — the names, and the
inverted `m.direct` map:

- read through the SDK's account data API (`client.accountData`), written through `setAccountData` —
  the whole event is replaced with a map built from the stored one plus or minus the one key, so a
  concurrent name from another client of the same account is not lost;
- re-read after each sync round trip (and on sync state changes), so a name set from another client
  shows up without a restart;
- the room list reads it once when the session's room list starts, and the room details screen reads
  it when opened, so a client that goes straight into a chat still shows the name.

Failures never take the UI down: a read that fails keeps the names already displayed, a write that
fails leaves them untouched (the presenter shows the generic error snackbar and the dialog closes).

## The UI

Room details of a DM → **«Личное имя»** (below the read/unread actions). It shows the current name on
the right, opens a dialog with the name field, «Сохранить», «Сбросить» (only when a name is set) and
«Отмена». Saving a blank field is the same as resetting. The name field carries no example hint in
either locale: it is empty until the user types, as asked. The dialog is only offered in the details
screen of a personal dialogue; groups have no such entry. The dialog writes to the **contact** the
room is with, so saving it from one dialog updates every dialogue with that person.

## Names of people (patch 0016)

The name belongs to the person, so it is applied to the person everywhere the app prints one, in groups
included — not only to the title of a DM. All of it is Kotlin: the names enter the app through its own
mappers (`RoomMemberMapper`, `EventTimelineItemMapper`, `NotificationMapper`, the user search result
mapper), and `PlotinaPersonalNames` lays the account's names over the models they produce. Nothing
inside `matrix-rust-sdk` changes, which is why no fork of it exists.

| What | Where |
| --- | --- |
| Author of a message, forwarder, quote, last reply of a thread, "X invited Y" | `RustTimeline.timelineItems` — the items are mapped from the SDK without names and the names are laid over the mapped list |
| Author in the reply preview above the composer, and in the quote of a sent reply | `RustTimeline.loadReplyDetails` — both branches (the event already in the timeline, and the one fetched from the SDK) go through one overlay, so the preview and the sent quote name the person the same way |
| Member list, mention suggestions and pills, typing notice, read receipts and reactions sheets | `RustBaseRoom.membersStateFlow` (`PlotinaMembersStateFlow`) — everything that reads the room's members inherits it |
| Member profile screen, send-failure identity warnings | `RustBaseRoom.userDisplayName` |
| Room-list rows: the room's name, its heroes, the inviter and the author of the preview | `RoomListRoomSummaryFactory` (one overlay per row) |
| Invite preview, knock requests | `NotJoinedRustRoom`, `RustKnockRequest` |
| Push and local notifications | `RustNotificationService` reads the names before mapping, so the first push of a cold start already shows them |
| Profiles and user search results | `RustMatrixClient.getProfile` / `searchUsers` (a personal name is never applied to the account's own profile) |
| Thread list, message search results | `RustThreadsListService`, `MessageSearchResultMapper` |

**Group names are untouched.** A personal name renames a person: `m.room.name` and the name the SDK
computes for a nameless group stay as they are, and so does everything the other side sees.

**Reactivity.** The SDK maps a name once, so an already drawn object would keep it until the screen is
reopened. Each surface above is a flow that carries the names, and the store publishes a new map when
it changes: the room list rebuilds its rows (`RoomListDataSource`), the open timeline re-applies the
overlay to its mapped items, and the member list is published with the names applied on every read and
on every change. A rename therefore lands on the list, the open chat and the member list without
leaving the screen.

**Disambiguation.** `is_name_ambiguous` is computed by the SDK from real names, which is wrong in both
directions once personal names exist (two contacts named "Дима" get no marker; a person renamed away
from a duplicated name keeps a pointless one). A contact the user named is shown without the marker,
and the member list recomputes it over the names it actually shows: two people shown under one personal
name both carry `(@mxid)`.

## What is not covered

- **Search by personal name for strangers.** The "start a chat" search runs on the server
  (`/user_directory/search`) and matches server names; it can neither find a person by the name this
  account gave them nor rename someone the account has not named. A personal name is applied to the
  people the result list already contains.
- **Room list search.** The room list search is a filter the SDK applies to the room's real name
  (`RoomListFilter.NormalizedMatchRoomName`); a personal name is *shown* in the results, it is just
  not matched.
- **Global search** room results (`GlobalSearchView`) print `RoomInfo.name` straight from the SDK
  search result, so a personal name is not applied there.
- **Ordering**: the room list keeps the SDK's ordering; a personal name does not re-sort the list.
- **A collision of personal names outside the room being viewed**: the timeline marks a shared personal
  name only against the members of that room (the member list it has at hand); a second contact with
  the same name who is not in the room leaves the marker off in that timeline.

## Tests

- `libraries/matrix/api` — `PlotinaContactNamesTest`: applying by mxid, one person in two DMs, a
  group untouched, a room with its own `m.room.name` untouched, the `m.direct` fallback, reset,
  broken/foreign payloads (the old room-keyed event included), stable and round-tripping
  serialisation, the event type is `cc.plotina.contact_names`. `PlotinaContactNamesV12Test` covers the
  v12 opaque room ids the room-keyed model used to test: such an id is read as an `m.direct` value and
  resolves to its contact, and is rejected as a names key.
- `libraries/matrix/impl` — `RustContactNameStoreTest`: the write touches only the account data
  event, trimming, reset removes the key and writes `{}`, other names of the account are preserved,
  a name written by another client is read on refresh, the old room-keyed event is not read, broken
  JSON reads as empty, the `m.direct` inversion, a failed write/read leaves the published map
  untouched.
- `features/home/impl` — `RoomListRoomSummaryFactoryTest` (a DM shows the contact's name, two DMs with
  one person show one name, a group keeps its own, a DM with its own `m.room.name` keeps it, and a
  group's preview names its author with the personal name while the row keeps the group's name) and
  `RoomListDataSourceTest` (a name change rebuilds the list).
- `libraries/matrix/api` — `PlotinaPersonalNamesTest`: a contact is shown under the account's name, a
  person it did not name keeps the SDK's, a chosen name clears the SDK's ambiguity flag, two people
  named "Дима" are both marked `(@mxid)`, a person renamed away from a duplicated name loses the
  marker, an empty map changes nothing, every list of a members state is renamed, a sender profile is
  renamed but keeps the SDK's flag when that person has no name, and a group keeps its own name while
  its heroes carry personal names.
- `libraries/matrix/impl` — `RustTimelineTest`: `loadReplyDetails` for an event already in the timeline
  names the quoted author with the account's personal name (the reply preview the composer shows), as
  does the same call for an event the SDK has to fetch (the sent quote).
- `libraries/matrix/impl` — `RustBaseRoomPersonalNamesTest`: a member of a group is shown under the
  account's personal name, the members it did not name keep theirs, a rename reaches an open member
  list without a re-fetch, the room info names its heroes while the group keeps its own name, and
  `userDisplayName` follows the personal name.
- `features/roomdetails/impl` — `RoomDetailsPresenterTest`: the dialog is fed the contact's name,
  saving and resetting write for the contact rather than the room, a group has no contact.
