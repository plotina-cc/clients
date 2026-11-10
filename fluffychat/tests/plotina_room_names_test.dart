// Regression test for patches/0017-plotina-personal-dm-names.patch:
// personal names of direct chats from the account data event
// `cc.plotina.room_aliases`, shared with Plotina Element Web/Desktop.
//
// What it pins down:
//  * the alias is applied to the room name (the single point
//    `plotinaDisplayname()`), and only for direct chats;
//  * a reset removes the key and never leaves an empty value behind;
//  * the write goes to account data only — no `m.room.name`, no room state;
//  * empty, missing or corrupt account data never throws.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   flutter test test/plotina_room_names_test.dart   # after copying this file there
//
// No homeserver and no encryption is needed: the write is asserted on the HTTP
// request that reaches the (fake) http client.
// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';

import 'package:fluffychat/utils/plotina_room_names.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:matrix/matrix.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const _dmRoomId = '!dm:homeserver.test';
const _groupRoomId = '!group:homeserver.test';
const _bob = '@bob:homeserver.test';

/// Answers every request with `{}` and remembers it, so the test can prove
/// exactly which endpoints the alias code hit.
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
    'Plotina room names test',
    httpClient: recorder,
    database: await MatrixSdkDatabase.init(
      'plotina_room_names_test',
      database: await databaseFactoryFfi.openDatabase(':memory:'),
      sqfliteFactory: databaseFactoryFfi,
    ),
  );
  await client.init(
    newToken: 'plotina-test-token',
    newUserID: '@plotina:homeserver.test',
    newDeviceID: 'PLOTINATEST',
    newDeviceName: 'Plotina room names test',
    newHomeserver: Uri.parse('https://homeserver.test'),
    waitForFirstSync: false,
  );
  return client;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('parsePlotinaRoomAliases', () {
    test('reads the shared contract shape', () {
      expect(
        parsePlotinaRoomAliases({_dmRoomId: 'Денчик', _groupRoomId: ' Work '}),
        {_dmRoomId: 'Денчик', _groupRoomId: 'Work'},
      );
    });

    test('empty, missing and foreign values give an empty map', () {
      expect(parsePlotinaRoomAliases(null), isEmpty);
      expect(parsePlotinaRoomAliases(const <String, Object?>{}), isEmpty);
      expect(parsePlotinaRoomAliases(const <Object?>[1, 2]), isEmpty);
      expect(parsePlotinaRoomAliases(42), isEmpty);
      expect(parsePlotinaRoomAliases(''), isEmpty);
    });

    test('broken JSON does not throw', () {
      expect(parsePlotinaRoomAliases('{not json'), isEmpty);
      expect(parsePlotinaRoomAliases('"just a string"'), isEmpty);
      expect(parsePlotinaRoomAliases('null'), isEmpty);
    });

    test('accepts a JSON string holding the object', () {
      expect(parsePlotinaRoomAliases('{"$_dmRoomId":" Денчик "}'), {
        _dmRoomId: 'Денчик',
      });
    });

    test('accepts opaque room v12 ids, which have no localpart', () {
      expect(parsePlotinaRoomAliases({'!AbCdEf0123456789': 'Денчик'}), {
        '!AbCdEf0123456789': 'Денчик',
      });
    });

    test('skips blank names and non-string values', () {
      expect(
        parsePlotinaRoomAliases({
          _dmRoomId: '   ',
          _groupRoomId: 42,
          '': 'no room id',
          '!ok:homeserver.test': 'Fine',
        }),
        {'!ok:homeserver.test': 'Fine'},
      );
    });
  });

  group('plotinaDisplaynameFor', () {
    test('a personal name wins for a direct chat', () {
      expect(
        plotinaDisplaynameFor(
          fallback: 'Bob',
          aliases: {_dmRoomId: 'Денчик'},
          roomId: _dmRoomId,
          isDirectChat: true,
        ),
        'Денчик',
      );
    });

    test('groups are never renamed', () {
      expect(
        plotinaDisplaynameFor(
          fallback: 'Team',
          aliases: {_groupRoomId: 'Денчик'},
          roomId: _groupRoomId,
          isDirectChat: false,
        ),
        'Team',
      );
    });

    test('falls back without a personal name', () {
      expect(
        plotinaDisplaynameFor(
          fallback: 'Bob',
          aliases: const {},
          roomId: _dmRoomId,
          isDirectChat: true,
        ),
        'Bob',
      );
    });
  });

  group('plotinaAliasesAfterSet', () {
    test('sets a trimmed name and keeps the other rooms', () {
      expect(
        plotinaAliasesAfterSet({_groupRoomId: 'Team'}, _dmRoomId, ' Денчик  '),
        {_groupRoomId: 'Team', _dmRoomId: 'Денчик'},
      );
    });

    test('overwrites the name of the same room', () {
      expect(plotinaAliasesAfterSet({_dmRoomId: 'Old'}, _dmRoomId, 'New'), {
        _dmRoomId: 'New',
      });
    });

    test('a reset drops the key and writes no empty values', () {
      final next = plotinaAliasesAfterSet(
        {_dmRoomId: 'Денчик', _groupRoomId: ''},
        _dmRoomId,
        '',
      );
      expect(next, isEmpty);
      expect(
        plotinaAliasesAfterSet({_dmRoomId: 'Денчик'}, _dmRoomId, null),
        isEmpty,
      );
      expect(
        plotinaAliasesAfterSet({_dmRoomId: 'Денчик'}, _dmRoomId, '   '),
        isEmpty,
      );
    });

    test('tolerates corrupt current content', () {
      expect(plotinaAliasesAfterSet('{broken', _dmRoomId, 'Денчик'), {
        _dmRoomId: 'Денчик',
      });
      expect(plotinaAliasesAfterSet(null, _dmRoomId, 'Денчик'), {
        _dmRoomId: 'Денчик',
      });
    });
  });

  group('PlotinaRoomNames on a client', () {
    late Client client;
    late _RecordingHttpClient recorder;
    late Room dm;
    late Room group;

    setUp(() async {
      recorder = _RecordingHttpClient();
      client = await _prepareClient(recorder);
      dm = Room(id: _dmRoomId, client: client);
      group = Room(id: _groupRoomId, client: client);
      // A direct chat is what `m.direct` says it is — same rule as upstream.
      client.accountData['m.direct'] = BasicEvent(
        type: 'm.direct',
        content: {
          _bob: [_dmRoomId],
        },
      );
    });

    test('the personal name is applied to a direct chat', () async {
      expect(dm.isDirectChat, isTrue);
      expect(dm.plotinaDisplayname(), isNot('Денчик'));

      await PlotinaRoomNames.setAlias(dm, 'Денчик');

      expect(PlotinaRoomNames.aliasOf(dm), 'Денчик');
      expect(dm.plotinaDisplayname(), 'Денчик');
      expect(PlotinaRoomNames.aliasesOf(client), {_dmRoomId: 'Денчик'});
    });

    test('the write goes to account data only, never to room state', () async {
      await PlotinaRoomNames.setAlias(dm, 'Денчик');

      expect(recorder.puts, hasLength(1));
      final put = recorder.puts.single;
      expect(put.url.path, contains('/user/'));
      expect(put.url.path, endsWith('/account_data/$plotinaRoomAliasesType'));
      expect(jsonDecode(put.body), {_dmRoomId: 'Денчик'});

      // No m.room.name for anyone: no state endpoint, no name event, and the
      // room itself still has no name.
      expect(
        recorder.requests.where((r) => r.url.path.contains('/state/')),
        isEmpty,
      );
      expect(recorder.bodies.where((b) => b.contains('m.room.name')), isEmpty);
      expect(dm.getState(EventTypes.RoomName), isNull);
    });

    test('a reset returns the room to its own name', () async {
      await PlotinaRoomNames.setAlias(dm, 'Денчик');
      final withAlias = dm.plotinaDisplayname();

      await PlotinaRoomNames.setAlias(dm, '');

      expect(PlotinaRoomNames.aliasesOf(client), isEmpty);
      expect(PlotinaRoomNames.aliasOf(dm), isNull);
      expect(dm.plotinaDisplayname(), isNot(withAlias));
      expect(jsonDecode(recorder.puts.last.body), isEmpty);
      expect(dm.getState(EventTypes.RoomName), isNull);
    });

    test('groups are ignored by both the display and the write', () async {
      expect(group.isDirectChat, isFalse);

      await PlotinaRoomNames.setAlias(group, 'Денчик');

      expect(recorder.requests, isEmpty);
      expect(PlotinaRoomNames.aliasesOf(client), isEmpty);
      expect(group.plotinaDisplayname(), isNot('Денчик'));

      // Even a stale entry written by another client does not rename a group.
      client.accountData[plotinaRoomAliasesType] = BasicEvent(
        type: plotinaRoomAliasesType,
        content: {_groupRoomId: 'Денчик'},
      );
      expect(group.plotinaDisplayname(), isNot('Денчик'));
    });

    test('corrupt account data does not throw and does not rename', () async {
      client.accountData[plotinaRoomAliasesType] = BasicEvent(
        type: plotinaRoomAliasesType,
        content: {
          _dmRoomId: 42,
          '!blank:homeserver.test': '   ',
          'not a room': 'x',
        },
      );

      expect(() => dm.plotinaDisplayname(), returnsNormally);
      expect(PlotinaRoomNames.aliasOf(dm), isNull);
      expect(PlotinaRoomNames.aliasesOf(client), isEmpty);
    });

    test('a second room keeps its own name', () async {
      final other = Room(id: '!other:homeserver.test', client: client);
      client.accountData['m.direct'] = BasicEvent(
        type: 'm.direct',
        content: {
          _bob: [_dmRoomId, other.id],
        },
      );

      await PlotinaRoomNames.setAlias(other, 'Второй');

      expect(PlotinaRoomNames.aliasesOf(client), {other.id: 'Второй'});
      expect(other.plotinaDisplayname(), 'Второй');
      expect(dm.plotinaDisplayname(), isNot('Второй'));
    });
  });
}
