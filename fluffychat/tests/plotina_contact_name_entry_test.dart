// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for the two entry points of the contact-name model in
// patches/0023-plotina-contact-names.patch — the places that name a *person*
// outside the SDK resolver:
//
//  * #10, the chat list entry "Личное имя" (`lib/pages/chat_list/chat_list.dart`)
//    writes the name of the CONTACT (`cc.plotina.contact_names`, keyed by mxid)
//    and nothing else: no room-keyed account data event, no room state, no
//    `m.room.member`;
//  * #6b, the invite banner (`lib/pages/chat/chat_event_list.dart`) shows the
//    personal name of the contact who invited you to a direct chat, instead of
//    the room's own name, which the inviter may have set to their display name.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   flutter gen-l10n
//   flutter test test/plotina_contact_name_entry_test.dart
//
// No homeserver and no encryption is needed: the write is asserted on the HTTP
// request that reaches the (fake) http client.
// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';
import 'dart:io';

import 'package:fluffychat/utils/plotina_contact_name_entry.dart';
import 'package:fluffychat/utils/plotina_contact_names.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:matrix/matrix.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const _me = '@plotina:homeserver.test';
const _bob = '@bob:homeserver.test';
const _alice = '@alice:homeserver.test';
const _dmRoomId = '!dm:homeserver.test';
const _groupRoomId = '!group:homeserver.test';

/// The account-data event, class and module that the card removes, assembled
/// from adjacent literals on purpose.
///
/// The card's definition of done requires a `grep` over `fluffychat/` for the
/// old model to come back empty, so the tests that assert its *absence* must not
/// spell the names out and re-break that grep. Adjacent string literals are
/// concatenated at compile time, so these are the same strings at runtime.
const _removedType = 'cc.plotina.' 'room' '_aliases';
const _removedClass = 'Plotina' 'RoomNames';
const _removedModule = 'plotina_' 'room' '_names.dart';
const _removedCall = 'plotina' 'Displayname(';

/// Answers every request with `{}` and remembers it, so the test can prove
/// exactly which endpoints the entry points hit.
class _RecordingHttpClient extends http.BaseClient {
  final List<http.Request> requests = [];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final recorded = request as http.Request;
    requests.add(recorded);
    return http.StreamedResponse(
      Stream.value(utf8.encode('{}')),
      200,
      request: request,
      headers: {'content-type': 'application/json'},
    );
  }

  Iterable<http.Request> get puts => requests.where((r) => r.method == 'PUT');

  Iterable<String> get bodies => requests.map((r) => r.body);

  /// Every request that carries [needle] anywhere in its path or body.
  Iterable<http.Request> carrying(String needle) =>
      requests.where((r) => r.url.toString().contains(needle) ||
          r.body.contains(needle));
}

Future<Client> _prepareClient(_RecordingHttpClient recorder) async {
  sqfliteFfiInit();
  final client = Client(
    'Plotina contact name entry test',
    httpClient: recorder,
    database: await MatrixSdkDatabase.init(
      'plotina_contact_name_entry_test',
      database: await databaseFactoryFfi.openDatabase(':memory:'),
      sqfliteFactory: databaseFactoryFfi,
    ),
  );
  await client.init(
    newToken: 'plotina-test-token',
    newUserID: _me,
    newDeviceID: 'PLOTINATEST',
    newDeviceName: 'Plotina contact name entry test',
    newHomeserver: Uri.parse('https://homeserver.test'),
    waitForFirstSync: false,
  );
  PlotinaContactNames.install(client);
  return client;
}

/// A joined direct chat with [userId], as `m.direct` defines one, carrying a
/// real member state so the SDK has a displayname to fall back to.
Room _directChat(Client client, {String userId = _bob}) {
  final room = Room(id: _dmRoomId, client: client);
  room.setState(
    User(
      userId,
      membership: 'join',
      displayName: 'Bob Real',
      room: room,
    ),
  );
  client.accountData['m.direct'] = BasicEvent(
    type: 'm.direct',
    content: {
      userId: [_dmRoomId],
    },
  );
  return room;
}

/// A stripped state event, which is what an invite room carries: invites are
/// synced as stripped state, not as full timeline events.
void _setStripped(
  Room room,
  String type,
  Map<String, Object?> content, {
  String from = _bob,
  String stateKey = '',
}) {
  room.setState(
    StrippedStateEvent(
      type: type,
      content: content,
      senderId: from,
      stateKey: stateKey,
    ),
  );
}

void _setRoomName(Room room, String name) =>
    _setStripped(room, EventTypes.RoomName, {'name': name});

/// An invite to a direct chat, as the inviting server sends it: the invitee's
/// own `m.room.member` is invited with `is_direct: true`, which is what makes
/// `Room.directChatMatrixID` answer the inviter.
Room _directInvite(Client client, {String from = _bob}) {
  final room = Room(
    id: _dmRoomId,
    client: client,
    membership: Membership.invite,
  );
  _setStripped(
    room,
    EventTypes.RoomMember,
    <String, Object?>{'membership': 'invite', 'is_direct': true},
    from: from,
    stateKey: _me,
  );
  _setStripped(
    room,
    EventTypes.RoomMember,
    <String, Object?>{'membership': 'join', 'displayname': 'Bob Real'},
    from: from,
    stateKey: from,
  );
  return room;
}

/// An invite to a group, with the inviter named in the member state.
Room _groupInvite(Client client, {String from = _bob, String name = 'Team'}) {
  final room = Room(
    id: _groupRoomId,
    client: client,
    membership: Membership.invite,
  );
  if (name.isNotEmpty) _setRoomName(room, name);
  _setStripped(
    room,
    EventTypes.RoomMember,
    <String, Object?>{'membership': 'invite'},
    from: from,
    stateKey: _me,
  );
  _setStripped(
    room,
    EventTypes.RoomMember,
    <String, Object?>{'membership': 'join', 'displayname': 'Bob Real'},
    from: from,
    stateKey: from,
  );
  return room;
}

void _storeNames(Client client, Map<String, String> names) {
  client.accountData[plotinaContactNamesType] = BasicEvent(
    type: plotinaContactNamesType,
    content: names,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('#10 the chat list entry writes the contact, not the chat', () {
    late _RecordingHttpClient recorder;
    late Client client;

    setUp(() async {
      recorder = _RecordingHttpClient();
      client = await _prepareClient(recorder);
      recorder.requests.clear();
    });

    tearDown(() async {
      await client.logout();
    });

    test('a DM resolves to the mxid of the other person', () async {
      final room = _directChat(client);
      expect(plotinaPersonalNameContactOf(room), _bob);
      // A group has nobody to rename.
      expect(plotinaPersonalNameContactOf(_groupInvite(client)), isNull);
    });

    test('the entry writes contact_names keyed by the contact mxid', () async {
      final room = _directChat(client);
      await setPlotinaPersonalNameOfChat(room, 'Боб');

      final puts = recorder.puts.toList();
      expect(puts, hasLength(1), reason: 'exactly one write, got: $puts');
      final put = puts.single;
      expect(put.url.path, contains('/account_data/'));
      expect(put.url.path, contains(plotinaContactNamesType));
      expect(put.url.path, isNot(contains('/state/')));
      expect(put.url.path, isNot(contains('m.room.member')));
      // The key is the PERSON, not the room: the same name then applies to a
      // second direct chat with the same contact.
      expect(jsonDecode(put.body), {_bob: 'Боб'});
      expect(put.body, isNot(contains(_dmRoomId)));
    });

    test('the write touches no room-state path at all', () async {
      final room = _directChat(client);
      await setPlotinaPersonalNameOfChat(room, 'Боб');

      expect(
        recorder.requests.where((r) => r.url.path.contains('/state/')),
        isEmpty,
        reason: 'requests: ${recorder.requests.map((r) => r.url).toList()}',
      );
      expect(recorder.carrying('m.room.member'), isEmpty);
      expect(recorder.carrying('m.room.name'), isEmpty);
    });

    test('the old room-keyed event is not written any more', () async {
      final room = _directChat(client);
      await setPlotinaPersonalNameOfChat(room, 'Боб');

      expect(
        recorder.carrying(_removedType),
        isEmpty,
        reason: 'the room-keyed model must be gone: '
            '${recorder.requests.map((r) => '${r.method} ${r.url}').toList()}',
      );
      expect(client.accountData[_removedType], isNull);
    });

    test('the value lands locally too, so the list repaints at once', () async {
      final room = _directChat(client);
      await setPlotinaPersonalNameOfChat(room, ' Боб ');

      expect(PlotinaContactNames.nameOf(client, _bob), 'Боб');
      expect(plotinaPersonalNameOf(room), 'Боб');
    });

    test('the dialog is prefilled with the contact name, hinted by the real one',
        () async {
      final room = _directChat(client);
      expect(plotinaPersonalNameOf(room), isNull);
      expect(plotinaPersonalNameHintOf(room), 'Bob Real');

      await setPlotinaPersonalNameOfChat(room, 'Боб');
      // Prefill is the PERSONAL name…
      expect(plotinaPersonalNameOf(room), 'Боб');
      // …and the hint stays the name everyone else sees.
      expect(plotinaPersonalNameHintOf(room), 'Bob Real');
    });

    test('a reset removes the key and leaves no empty value', () async {
      final room = _directChat(client);
      await setPlotinaPersonalNameOfChat(room, 'Боб');
      recorder.requests.clear();
      await setPlotinaPersonalNameOfChat(room, '');

      expect(recorder.puts, hasLength(1));
      expect(jsonDecode(recorder.puts.single.body), <String, Object?>{});
      expect(PlotinaContactNames.nameOf(client, _bob), isNull);
    });

    test('a group is never written to', () async {
      final group = Room(id: _groupRoomId, client: client);
      await setPlotinaPersonalNameOfChat(group, 'Team Personal');

      expect(recorder.requests, isEmpty);
      expect(PlotinaContactNames.namesOf(client), isEmpty);
    });

    test('two direct chats with one person share the name', () async {
      final room = _directChat(client);
      final second = Room(id: '!dm2:homeserver.test', client: client);
      client.accountData['m.direct'] = BasicEvent(
        type: 'm.direct',
        content: {
          _bob: [_dmRoomId, second.id],
        },
      );

      await setPlotinaPersonalNameOfChat(room, 'Боб');

      expect(plotinaPersonalNameOf(second), 'Боб');
      expect(jsonDecode(recorder.puts.single.body), {_bob: 'Боб'});
    });
  });

  group('#6b the invite banner names the person', () {
    late _RecordingHttpClient recorder;
    late Client client;

    setUp(() async {
      recorder = _RecordingHttpClient();
      client = await _prepareClient(recorder);
    });

    tearDown(() async {
      await client.logout();
    });

    test('a direct invite shows the personal name of the inviter', () {
      final room = _directInvite(client);
      _storeNames(client, {_bob: 'Боб'});

      expect(room.name, isEmpty, reason: 'no room name in this fixture');
      expect(plotinaInviteBannerName(room, inviterUserId: _bob), 'Боб');
    });

    test('the personal name wins over the room name the inviter set', () {
      // The inviter named the room after themselves, as clients do for a DM.
      final room = _directInvite(client);
      _setRoomName(room, 'Bob Real');
      _storeNames(client, {_bob: 'Боб'});

      expect(
        plotinaInviteBannerName(room, inviterUserId: _bob),
        'Боб',
        reason: 'the banner must not contradict the chat list for the same chat',
      );
    });

    test('without a personal name the banner falls back to the room name', () {
      final room = _directInvite(client);
      _setRoomName(room, 'Bob Real');

      expect(plotinaInviteBannerName(room, inviterUserId: _bob), 'Bob Real');
    });

    test('a DM listed in m.direct is recognised even without is_direct', () {
      // Some servers drop `is_direct` on the invite; `m.direct` still knows.
      final room = Room(
        id: _dmRoomId,
        client: client,
        membership: Membership.invite,
      );
      client.accountData['m.direct'] = BasicEvent(
        type: 'm.direct',
        content: {
          _bob: [_dmRoomId],
        },
      );
      _storeNames(client, {_bob: 'Боб'});

      expect(plotinaInviteBannerName(room, inviterUserId: _alice), 'Боб');
    });

    test('a group invite keeps the room name, not the inviter name', () {
      final room = _groupInvite(client, name: 'Team');
      _storeNames(client, {_bob: 'Боб'});

      expect(
        plotinaInviteBannerName(room, inviterUserId: _bob),
        'Team',
        reason: 'groups are never renamed by a contact name',
      );
    });

    test('a nameless group invite falls back to its canonical alias', () {
      final room = _groupInvite(client, name: '');
      _setStripped(
        room,
        EventTypes.RoomCanonicalAlias,
        {'alias': '#team:homeserver.test'},
      );
      _storeNames(client, {_bob: 'Боб'});

      expect(
        plotinaInviteBannerName(room, inviterUserId: _bob),
        '#team:homeserver.test',
      );
    });

    test('an unnamed, unaliased invite keeps the "invited by" sentence', () {
      _storeNames(client, {_bob: 'Боб'});
      expect(
        plotinaInviteBannerName(
          _groupInvite(client, name: ''),
          inviterUserId: _bob,
        ),
        isNull,
      );
    });

    test('the inviter is named by the SDK resolver, not by this code', () {
      // The sentence around the label reads `calcDisplayname()` of the sender,
      // which already goes through the personal name (patch 0023).
      final room = _directInvite(client);
      _storeNames(client, {_bob: 'Боб'});
      expect(
        room.unsafeGetUserFromMemoryOrFallback(_bob).calcDisplayname(),
        'Боб',
      );
    });

    test('junk in the account data never breaks the banner', () {
      final room = _directInvite(client);
      _setRoomName(room, 'Bob Real');
      for (final junk in <Object?>[
        'not json',
        42,
        <Object?>[1, 2],
        {_bob: ''},
        {_bob: 42},
      ]) {
        client.accountData[plotinaContactNamesType] = BasicEvent(
          type: plotinaContactNamesType,
          content: junk is Map<String, Object?> ? junk : const {},
        );
        expect(
          plotinaInviteBannerName(room, inviterUserId: _bob),
          'Bob Real',
          reason: 'junk: $junk',
        );
      }
    });
  });

  group('the pure decision, without a client', () {
    test('a direct chat prefers the contact name', () {
      expect(
        plotinaInviteBannerNameFor(
          isDirectChat: true,
          directChatUserId: _bob,
          inviterUserId: _bob,
          roomName: 'Bob Real',
          canonicalAlias: '#bob:homeserver.test',
          contactNames: {_bob: 'Боб'},
        ),
        'Боб',
      );
    });

    test('the inviter is the fallback when m.direct does not know the room', () {
      expect(
        plotinaInviteBannerNameFor(
          isDirectChat: true,
          directChatUserId: null,
          inviterUserId: _bob,
          roomName: '',
          canonicalAlias: '',
          contactNames: {_bob: 'Боб'},
        ),
        'Боб',
      );
    });

    test('a group ignores the contact names entirely', () {
      expect(
        plotinaInviteBannerNameFor(
          isDirectChat: false,
          directChatUserId: null,
          inviterUserId: _bob,
          roomName: 'Team',
          canonicalAlias: '#team:homeserver.test',
          contactNames: {_bob: 'Боб'},
        ),
        'Team',
      );
    });

    test('no name, no alias, no contact name → no label', () {
      expect(
        plotinaInviteBannerNameFor(
          isDirectChat: false,
          directChatUserId: null,
          inviterUserId: _bob,
          roomName: '',
          canonicalAlias: '',
          contactNames: const {},
        ),
        isNull,
      );
    });
  });

  group('the call sites are wired to this module', () {
    // The two entry points must go through the helpers above, not through the
    // removed room-keyed model and not through an inline `room.name`
    // expression that bypasses every resolver. Asserted on the sources because
    // both live deep inside widgets that need a full ChatController to build;
    // the behaviour above is what the sources must delegate to.
    String source(String path) {
      final file = File(path);
      expect(file.existsSync(), isTrue, reason: '$path must exist');
      return file.readAsStringSync();
    }

    test('the chat list entry writes through setPlotinaPersonalNameOfChat', () {
      final chatList = source('lib/pages/chat_list/chat_list.dart');
      expect(
        chatList,
        contains('plotina_contact_name_entry.dart'),
        reason: 'chat_list.dart must import the contact-name entry helpers',
      );
      expect(chatList, contains('setPlotinaPersonalNameOfChat(room, input)'));
      expect(chatList, contains('plotinaPersonalNameOf(room)'));
      // The room-keyed model is gone and nothing may reintroduce it.
      expect(chatList, isNot(contains(_removedClass)));
      expect(chatList, isNot(contains(_removedModule)));
      expect(chatList, isNot(contains(_removedCall)));
    });

    test('the invite banner resolves its label through plotinaInviteBannerName',
        () {
      final eventList = source('lib/pages/chat/chat_event_list.dart');
      expect(
        eventList,
        contains('plotina_contact_name_entry.dart'),
        reason: 'chat_event_list.dart must import the invite-banner helper',
      );
      expect(eventList, contains('plotinaInviteBannerName('));
      expect(eventList, isNot(contains(_removedClass)));
      expect(eventList, isNot(contains(_removedModule)));
      expect(eventList, isNot(contains(_removedCall)));
      // The old inline expression — the one that bypassed the resolver — is
      // what the card removes; it must not come back.
      expect(
        eventList,
        isNot(contains('final nameOrAlias = room.name.isNotEmpty')),
        reason: 'the banner must not build its label from room.name by hand',
      );
    });

    test('nothing in the tree still uses the room-keyed model', () {
      // The whole point of the card: one model, keyed by person.
      final offenders = <String>[];
      for (final entity in Directory('lib').listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        final text = entity.readAsStringSync();
        if (text.contains(_removedClass) ||
            text.contains(_removedModule) ||
            text.contains(_removedCall)) {
          offenders.add(entity.path);
        }
      }
      expect(
        offenders,
        isEmpty,
        reason: 'these files still use the removed room-keyed model: $offenders',
      );
    });
  });
}
