// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for patches/0023-plotina-contact-names.patch:
// personal names for contacts, stored in the account data event
// `cc.plotina.contact_names` and applied through the single resolver the app
// installs on the matrix SDK (`Client.localNameResolver`).
//
// What it pins down:
//  * a name that is set is what the SDK shows for that user;
//  * a name that is not set leaves the real displayname alone;
//  * an empty map leaves every name alone;
//  * junk in the account data falls back to the real name and never throws;
//  * a reset removes the key, so no empty values are left behind;
//  * the write goes to account data only — no `m.room.member`, no room state.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   flutter gen-l10n
//   flutter test test/plotina_contact_names_test.dart   # after copying it there
//
// No homeserver and no encryption is needed: the write is asserted on the HTTP
// request that reaches the (fake) http client.
// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';

import 'package:fluffychat/utils/plotina_contact_names.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:matrix/matrix.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const _me = '@plotina:homeserver.test';
const _bob = '@bob:homeserver.test';
const _alice = '@alice:homeserver.test';

/// Answers every request with `{}` and remembers it, so the test can prove
/// exactly which endpoints the contact-name code hit.
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
}

Future<Client> _prepareClient(_RecordingHttpClient recorder) async {
  sqfliteFfiInit();
  final client = Client(
    'Plotina contact names test',
    httpClient: recorder,
    database: await MatrixSdkDatabase.init(
      'plotina_contact_names_test',
      database: await databaseFactoryFfi.openDatabase(':memory:'),
      sqfliteFactory: databaseFactoryFfi,
    ),
  );
  await client.init(
    newToken: 'plotina-test-token',
    newUserID: _me,
    newDeviceID: 'PLOTINATEST',
    newDeviceName: 'Plotina contact names test',
    newHomeserver: Uri.parse('https://homeserver.test'),
    waitForFirstSync: false,
  );
  PlotinaContactNames.install(client);
  return client;
}

/// A room carrying a real member state for each of [users], so the SDK has a
/// displayname to fall back to.
Room _roomWith(Client client, Map<String, String> users) {
  final room = Room(id: '!chat:homeserver.test', client: client);
  for (final entry in users.entries) {
    room.setState(
      User(
        entry.key,
        membership: 'join',
        displayName: entry.value,
        room: room,
      ),
    );
  }
  return room;
}

void _storeAccountData(Client client, Object? content) {
  client.accountData[plotinaContactNamesType] = BasicEvent(
    type: plotinaContactNamesType,
    content: content is Map<String, Object?> ? content : const {},
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('parsePlotinaContactNames', () {
    test('reads the documented shape', () {
      expect(
        parsePlotinaContactNames({_bob: 'Боб', _alice: ' Алиса '}),
        {_bob: 'Боб', _alice: 'Алиса'},
      );
    });

    test('empty, missing and foreign values give an empty map', () {
      expect(parsePlotinaContactNames(null), isEmpty);
      expect(parsePlotinaContactNames(const <String, Object?>{}), isEmpty);
      expect(parsePlotinaContactNames(const <Object?>[1, 2]), isEmpty);
      expect(parsePlotinaContactNames(42), isEmpty);
      expect(parsePlotinaContactNames(''), isEmpty);
      expect(parsePlotinaContactNames('   '), isEmpty);
      expect(parsePlotinaContactNames(true), isEmpty);
    });

    test('broken JSON does not throw', () {
      expect(parsePlotinaContactNames('{not json'), isEmpty);
      expect(parsePlotinaContactNames('"just a string"'), isEmpty);
      expect(parsePlotinaContactNames('null'), isEmpty);
      expect(parsePlotinaContactNames('[1,2,3]'), isEmpty);
    });

    test('accepts a JSON string holding the object', () {
      expect(parsePlotinaContactNames('{"$_bob":" Боб "}'), {_bob: 'Боб'});
    });

    test('skips blank names, non-string values and non-mxid keys', () {
      expect(
        parsePlotinaContactNames({
          _bob: '',
          _alice: '   ',
          '@carol:homeserver.test': 42,
          'not-an-mxid': 'X',
          '@': 'X',
          '@:server': 'X',
          '@nocolon': 'X',
          '@ok:homeserver.test': 'Ok',
        }),
        {'@ok:homeserver.test': 'Ok'},
      );
    });

    test('the lookup helper tolerates a missing id', () {
      expect(plotinaContactNameFor({_bob: 'Боб'}, _bob), 'Боб');
      expect(plotinaContactNameFor({_bob: 'Боб'}, _alice), isNull);
      expect(plotinaContactNameFor({_bob: 'Боб'}, null), isNull);
      expect(plotinaContactNameFor({_bob: 'Боб'}, ''), isNull);
    });
  });

  group('plotinaContactNamesAfterSet', () {
    test('adds a name and keeps the others', () {
      expect(
        plotinaContactNamesAfterSet({_alice: 'Алиса'}, _bob, ' Боб '),
        {_alice: 'Алиса', _bob: 'Боб'},
      );
    });

    test('a blank or null name removes the key and leaves no empty value', () {
      expect(plotinaContactNamesAfterSet({_bob: 'Боб'}, _bob, ''), isEmpty);
      expect(plotinaContactNamesAfterSet({_bob: 'Боб'}, _bob, null), isEmpty);
      expect(plotinaContactNamesAfterSet({_bob: 'Боб'}, _bob, '   '), isEmpty);
      expect(
        plotinaContactNamesAfterSet({_bob: 'Боб', _alice: 'Алиса'}, _bob, ''),
        {_alice: 'Алиса'},
      );
    });

    test('replaces an existing name', () {
      expect(
        plotinaContactNamesAfterSet({_bob: 'Боб'}, _bob, 'Роберт'),
        {_bob: 'Роберт'},
      );
    });

    test('junk in the stored event is dropped, not carried over', () {
      expect(
        plotinaContactNamesAfterSet({
          _bob: '',
          'junk': 'X',
          _alice: 42,
          '@ok:homeserver.test': ' Ok ',
        }, _bob, 'Боб'),
        {'@ok:homeserver.test': 'Ok', _bob: 'Боб'},
      );
      expect(plotinaContactNamesAfterSet('not a map', _bob, 'Боб'), {
        _bob: 'Боб',
      });
    });
  });

  group('the resolver the SDK reads', () {
    late _RecordingHttpClient recorder;
    late Client client;
    late Room room;

    setUp(() async {
      recorder = _RecordingHttpClient();
      client = await _prepareClient(recorder);
      room = _roomWith(client, {_bob: 'Bob', _alice: 'Alice M'});
    });

    tearDown(() async {
      await client.logout();
    });

    /// The user as the SDK would resolve it from the room's member state — the
    /// `StrippedStateEvent` stored in the room carries no `asUser`, so rebuild
    /// the `User` from exactly that content.
    User user(String id) {
      final state = room.getState(EventTypes.RoomMember, id)!;
      return User.fromState(
        stateKey: state.stateKey!,
        content: state.content,
        typeKey: state.type,
        senderId: state.senderId,
        room: room,
      );
    }

    test('is installed on the client, so the SDK uses it', () {
      expect(client.localNameResolver, isNotNull);
    });

    test('an empty map leaves the real names alone', () {
      _storeAccountData(client, const <String, Object?>{});
      expect(user(_bob).displayName, 'Bob');
      expect(user(_bob).calcDisplayname(), 'Bob');
      expect(user(_alice).calcDisplayname(), 'Alice M');
    });

    test('no event at all leaves the real names alone', () {
      client.accountData.remove(plotinaContactNamesType);
      expect(user(_bob).displayName, 'Bob');
    });

    test('a name that is set is what the SDK shows', () {
      _storeAccountData(client, {_bob: 'Боб'});
      expect(user(_bob).displayName, 'Боб');
      expect(user(_bob).calcDisplayname(), 'Боб');
      // The member state itself is untouched.
      expect(
        room.getState(EventTypes.RoomMember, _bob)?.content['displayname'],
        'Bob',
      );
      expect(user(_bob).rawDisplayName, 'Bob');
      // Users the map does not mention are unaffected.
      expect(user(_alice).displayName, 'Alice M');
    });

    test('junk in the account data falls back to the real name', () {
      for (final junk in <Object?>[
        'not json',
        '{broken',
        <Object?>[1, 2, 3],
        42,
        {_bob: 42},
        {_bob: ''},
        {'junk': 'X'},
      ]) {
        _storeAccountData(client, junk);
        expect(user(_bob).displayName, 'Bob', reason: 'junk: $junk');
        expect(user(_bob).calcDisplayname(), 'Bob', reason: 'junk: $junk');
      }
    });

    test('the chat title built from heroes uses the name', () {
      room.summary.mHeroes = [_bob];
      expect(room.getLocalizedDisplayname(), contains('Bob'));
      _storeAccountData(client, {_bob: 'Боб'});
      expect(room.getLocalizedDisplayname(), contains('Боб'));
    });

    test('mentions are built from the name', () {
      _storeAccountData(client, {_bob: 'Robert'});
      expect(user(_bob).mention, '@Robert');
      // A name with spaces is bracketed, and only Bob's name changed, so no
      // disambiguating hash is added.
      _storeAccountData(client, {_bob: 'Robert P'});
      expect(user(_bob).mention, '@[Robert P]');
    });
  });

  group('PlotinaContactNames.setName', () {
    late _RecordingHttpClient recorder;
    late Client client;

    setUp(() async {
      recorder = _RecordingHttpClient();
      client = await _prepareClient(recorder);
    });

    tearDown(() async {
      await client.logout();
    });

    test('writes only the contact-names account data event', () async {
      recorder.requests.clear();
      await PlotinaContactNames.setName(client, _bob, 'Боб');

      final puts = recorder.puts.toList();
      expect(puts, hasLength(1));
      expect(puts.single.url.path, contains('/account_data/'));
      expect(puts.single.url.path, contains(plotinaContactNamesType));
      expect(puts.single.url.path, isNot(contains('/state/')));
      expect(puts.single.url.path, isNot(contains('m.room.member')));
      expect(jsonDecode(puts.single.body), {_bob: 'Боб'});
    });

    test('applies the change locally as well', () async {
      await PlotinaContactNames.setName(client, _bob, 'Боб');
      expect(client.accountData[plotinaContactNamesType]?.content, {
        _bob: 'Боб',
      });
      expect(PlotinaContactNames.nameOf(client, _bob), 'Боб');
    });

    test('a reset writes {} and leaves no empty value behind', () async {
      await PlotinaContactNames.setName(client, _bob, 'Боб');
      recorder.requests.clear();
      await PlotinaContactNames.setName(client, _bob, '');

      final puts = recorder.puts.toList();
      expect(puts, hasLength(1));
      expect(jsonDecode(puts.single.body), <String, Object?>{});
      expect(PlotinaContactNames.nameOf(client, _bob), isNull);
    });

    test('a reset keeps the names of other contacts', () async {
      await PlotinaContactNames.setName(client, _bob, 'Боб');
      await PlotinaContactNames.setName(client, _alice, 'Алиса');
      recorder.requests.clear();
      await PlotinaContactNames.setName(client, _bob, null);

      expect(jsonDecode(recorder.puts.single.body), {_alice: 'Алиса'});
    });

    test('a name is trimmed before it is stored', () async {
      await PlotinaContactNames.setName(client, _bob, '  Боб  ');
      expect(jsonDecode(recorder.puts.single.body), {_bob: 'Боб'});
    });
  });
}
