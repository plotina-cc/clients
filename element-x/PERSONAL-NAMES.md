# Personal names for personal dialogues (patch 0015)

Wish: a user can give a private dialogue (a DM) their own name, in every Plotina client. In
Element Web/Desktop this lives in `element-web/plotina-dm-aliases.js`; this is the Element X
(Android) half of the same wish.

## The contract (shared, unchanged)

Account data of the account, type `cc.plotina.room_aliases`, content
`{"<room_id>": "<personal name>"}`.

- The name belongs to the account that wrote it: it is account data, so no other member of the room
  receives it.
- `m.room.name` is **never** written. The room's state, and therefore the name the other side sees,
  does not change.
- An empty value means "no personal name": the key is dropped, and resetting the last alias leaves
  `{}` behind rather than an empty string.
- Content that is blank, broken or not a JSON object of room id to non-blank string is ignored: the
  client behaves as if no personal name existed. That includes keys that are not room ids (v12
  opaque ids without a colon are room ids and are accepted).

The web client wrote this event first, so the Android parser is the lenient one: it accepts what the
web client writes and drops what it cannot understand instead of failing.

## Where the name is applied

The SDK computes the room's display name (`RoomInfo.displayName` from the Rust
`Room::cached_display_name`) and Element X reads it in three places. All three are covered, none by a
Rust change:

| What | Where |
| --- | --- |
| Room list rows | `RoomListRoomSummaryFactory` (`features/home/impl`), through `RoomInfo.withPlotinaAlias` |
| Open chat title, and the room details header | `RustBaseRoom.roomInfoFlow` (`libraries/matrix/impl`), which combines the SDK room info with the account's aliases |
| Room name in the room details screen (and anything else reading `roomInfoFlow`) | same flow |

The overlay replaces `RoomInfo.name` only. `RoomInfo.rawName` - the value that mirrors the
`m.room.name` state event - is left as the SDK reported it, and nothing in this patch sends a room
state event.

A name is only applied to a personal dialogue: the SDK's `isDirect` (`m.direct`) or `isDm` (the
two-member rooms the app already presents as a DM). A group keeps its own name even if an alias for
it is left over from somewhere.

## Where the event is read

`RoomAliasStore` (`libraries/matrix/api`, implemented by `RustRoomAliasStore` in
`libraries/matrix/impl`) is session scoped and publishes the parsed map as a `StateFlow`:

- read through the SDK's account data API (`client.accountData`), written through `setAccountData` -
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
«Отмена». Saving a blank field is the same as resetting. The dialog is only offered in the details
screen of a personal dialogue; groups have no such entry.

## What is not covered

- **Search by personal name.** The room list search is a filter the SDK applies to the room's real
  name (`RoomListFilter.NormalizedMatchRoomName`); matching on the overlay would need a client-side
  search over all rooms, which is a separate change. The name is *shown* in search results, it just
  is not matched.
- **Global search** room results (`GlobalSearchView`) print `RoomInfo.name` straight from the SDK
  search result, so a personal name is not applied there.
- **Notifications** are produced from the SDK's own notification pipeline, which does not see this
  overlay: a push or a local notification carries the room's real name.
- **Ordering**: the room list keeps the SDK's ordering; a personal name does not re-sort the list.

## Tests

- `libraries/matrix/api` — `PlotinaRoomAliasesTest`: applying, reset, groups untouched,
  broken/foreign payloads, stable and round-tripping serialisation, v12 opaque ids.
- `libraries/matrix/impl` — `RustRoomAliasStoreTest`: the write touches only the account data event,
  trimming, reset removes the key and writes `{}`, other names of the account are preserved, broken
  JSON reads as empty, a failed write/read leaves the published map untouched.
- `features/home/impl` — `RoomListRoomSummaryFactoryTest` (a DM shows the personal name, a group
  keeps its own) and `RoomListDataSourceTest` (a name change rebuilds the list).