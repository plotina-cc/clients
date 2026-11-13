// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for the LIVE half of `cc.plotina.contact_names`
// (patches/0023-plotina-contact-names.patch): the author line that prefixes the
// last message in a chat-list preview must follow a personal-name change or
// reset of that author **while the row is on screen**.
//
// What it pins down, and what the older suites do not:
//  * `plotina_contact_names_test.dart` proves the resolver returns the name;
//  * `plotina_contact_name_entry_test.dart` proves the two dialogs write it;
//  * neither renders the chat list, so neither can see a widget that computes
//    the name once and then keeps the old string.
//
// The bug this test was written for (QA t_f2f5b871, item 3): after the name of
// the last-message author changed, the DM title and the DM row updated but the
// group preview kept `QA-DOOR-B: привет из группы` for 30 s; only a cold start
// fixed it. The preview was fed by a `FutureBuilder` whose snapshot is created
// in `initState` and never re-derived, so re-rendering the row was not enough:
// the row did rebuild with fresh `initialData` and still painted the old string.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   flutter gen-l10n
//   flutter test test/plotina_contact_name_refresh_test.dart
// ignore_for_file: depend_on_referenced_packages

import 'dart:convert';

import 'package:fluffychat/config/setting_keys.dart';
import 'package:fluffychat/l10n/l10n.dart';
import 'package:fluffychat/pages/chat_list/chat_list_item.dart';
import 'package:fluffychat/utils/plotina_contact_names.dart';
import 'package:fluffychat/widgets/matrix.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:matrix/matrix.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const _me = '@qa-a:homeserver.test';
const _bob = '@qa-b:homeserver.test';
const _alice = '@qa-alice:homeserver.test';

/// The real displayname of the author, i.e. what everyone else sees.
const _bobRealName = 'Plotina QA QA-B';

/// The personal name set through the app before the scenario starts.
const _bobOldPersonalName = 'QA-DOOR-B';

/// What the group's last message says.
const _groupMessage = 'привет из группы';

/// Answers every request with `{}`; nothing here talks to a homeserver.
class _RecordingHttpClient extends http.BaseClient {
  final List<http.Request> requests = [];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request as http.Request);
    return http.StreamedResponse(
      Stream.value(utf8.encode('{}')),
      200,
      request: request,
      headers: {'content-type': 'application/json'},
    );
  }
}

class _FakeNotifications extends FlutterLocalNotificationsPlatform {}

/// Renders one chat-list row.
///
/// The real chat list re-renders after the "Personal name" dialog returns
/// (`setState(() {})` in `ChatListController.chatContextAction`), so the row is
/// rebuilt with the new name available. Pass a new [rebuildTick] to reproduce
/// that: the widget is a new instance, so the row rebuilds exactly as it does
/// in the app.
class _ChatListRowHost extends StatelessWidget {
  final Room room;
  final int rebuildTick;

  const _ChatListRowHost(this.room, {this.rebuildTick = 0, super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: ChatListItem(room, onTap: () {}),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _RecordingHttpClient recorder;
  late Client client;
  late Room room;
  late SharedPreferences store;

  /// A joined group room whose last event was written by [_bob].
  ///
  /// A group on purpose: in a direct chat the preview never carries a sender
  /// prefix, so only a group can show the author line at all.
  Room groupRoom() {
    final room = Room(id: '!group:homeserver.test', client: client);
    for (final member in {
      _bob: _bobRealName,
      _alice: 'QA Alice',
      _me: 'QA A',
    }.entries) {
      room.setState(
        User(
          member.key,
          membership: 'join',
          displayName: member.value,
          room: room,
        ),
      );
    }
    room.summary.mHeroes = [_bob, _alice];
    // The row only loads heroes when the room has no name, and that path issues
    // real database IO which cannot complete inside the fake-async zone the
    // widget tester installs. Naming the room keeps the row on the pure-render
    // path this test is about.
    room.setState(
      Event(
        type: EventTypes.RoomName,
        stateKey: '',
        eventId: r'$group-name',
        senderId: _alice,
        originServerTs: DateTime.now(),
        content: {'name': 'QA group три'},
        room: room,
      ),
    );
    room.lastEvent = Event(
      type: EventTypes.Message,
      eventId: r'$group-last',
      senderId: _bob,
      originServerTs: DateTime.now(),
      content: {'msgtype': 'm.text', 'body': _groupMessage},
      room: room,
    );
    return room;
  }

  /// Builds the client and the room. Every step here touches real I/O (sqflite
  /// over FFI, the account-data PUT), so it has to run outside the fake-async
  /// zone the widget tester installs.
  Future<void> prepare(WidgetTester tester) async {
    await tester.runAsync(() async {
      sqfliteFfiInit();
      SharedPreferences.setMockInitialValues({});
      FlutterLocalNotificationsPlatform.instance = _FakeNotifications();
      await AppSettings.init(loadWebConfigFile: false);
      store = await SharedPreferences.getInstance();
      recorder = _RecordingHttpClient();
      client = Client(
        'Plotina contact name refresh test',
        httpClient: recorder,
        database: await MatrixSdkDatabase.init(
          'plotina_contact_name_refresh_test',
          database: await databaseFactoryFfi.openDatabase(':memory:'),
          sqfliteFactory: databaseFactoryFfi,
        ),
      );
      await client.init(
        newToken: 'plotina-test-token',
        newUserID: _me,
        newDeviceID: 'PLOTINAREFRESH',
        newDeviceName: 'Plotina contact name refresh test',
        newHomeserver: Uri.parse('https://homeserver.test'),
        waitForFirstSync: false,
      );
      PlotinaContactNames.install(client);
      // No server is reachable in this test; without this the sync loop retries
      // forever and the test never ends.
      client.backgroundSync = false;
      room = groupRoom();
    });
  }

  /// Writes a personal name the way the dialogs do — real account-data PUT, so
  /// again outside the fake-async zone.
  Future<void> setName(WidgetTester tester, String? name) async {
    await tester.runAsync(
      () => PlotinaContactNames.setName(client, _bob, name),
    );
  }

  Future<void> pumpRow(WidgetTester tester, {int tick = 0}) async {
    await tester.pumpWidget(
      Matrix(
        clients: [client],
        store: store,
        child: MaterialApp(
          localizationsDelegates: L10n.localizationsDelegates,
          supportedLocales: L10n.supportedLocales,
          home: _ChatListRowHost(room, rebuildTick: tick),
        ),
      ),
    );
    // Unmount before the test ends, so no widget-owned timer is left pending
    // for the next test to trip over.
    if (tick == 0) {
      addTearDown(() => tester.pumpWidget(const SizedBox.shrink()));
    }
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
  }

  /// The preview line as the user sees it.
  String previewText(WidgetTester tester) {
    final finder = find.textContaining(_groupMessage);
    expect(finder, findsOneWidget, reason: 'the group preview did not render');
    return tester.widget<Text>(finder).data ?? '';
  }

  tearDown(() async {
    if (client.isLogged()) {
      await client.logout();
    }
  });
  testWidgets(
    'a live rename rewrites the author line of the last message in the panel',
    (tester) async {
      await prepare(tester);
      await setName(tester, _bobOldPersonalName);
      await pumpRow(tester);
      expect(
        previewText(tester),
        '$_bobOldPersonalName: $_groupMessage',
        reason: 'the first render must already use the personal name',
      );

      // The user renames the author from the app while the list stays open. In
      // the real UI this is the same call the chat-list menu makes, followed by
      // the `setState(() {})` that re-renders the list.
      await setName(tester, 'QA-REFRESH-1');
      await pumpRow(tester, tick: 1);

      expect(
        previewText(tester),
        'QA-REFRESH-1: $_groupMessage',
        reason: 'the preview must follow the name without a restart',
      );
    },
  );

  testWidgets('a live reset falls back to the real displayname', (tester) async {
    await prepare(tester);
    await setName(tester, _bobOldPersonalName);
    await pumpRow(tester);
    expect(previewText(tester), '$_bobOldPersonalName: $_groupMessage');

    // Clearing the field writes `{}`; the author line must show the name
    // everybody else sees, again without a restart.
    await setName(tester, '');
    await pumpRow(tester, tick: 1);

    expect(previewText(tester), '$_bobRealName: $_groupMessage');
  });

  testWidgets('a contact with no personal name keeps the real displayname', (
    tester,
  ) async {
    await prepare(tester);
    await pumpRow(tester);
    expect(previewText(tester), '$_bobRealName: $_groupMessage');
  });

  testWidgets('junk in the account data never breaks the row', (tester) async {
    await prepare(tester);
    client.accountData[plotinaContactNamesType] = BasicEvent(
      type: plotinaContactNamesType,
      content: {_bob: 42, 'junk': 'X'},
    );
    await pumpRow(tester);
    expect(previewText(tester), '$_bobRealName: $_groupMessage');
  });

  testWidgets('a direct chat preview still carries no sender prefix', (
    tester,
  ) async {
    await prepare(tester);
    await setName(tester, _bobOldPersonalName);
    // Mark the room as the direct chat with bob: the preview drops the prefix
    // because the title already names them. `setAccountData` only writes to the
    // server, so the local copy the row reads has to be set too.
    client.accountData['m.direct'] = BasicEvent(
      type: 'm.direct',
      content: {
        _bob: [room.id],
      },
    );
    await tester.runAsync(
      () => client.setAccountData(client.userID!, 'm.direct', {
        _bob: [room.id],
      }),
    );
    await pumpRow(tester);
    expect(
      previewText(tester),
      _groupMessage,
      reason: 'a direct chat must not repeat the author name in the preview',
    );

    await setName(tester, 'QA-REFRESH-1');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(previewText(tester), _groupMessage);
  });
}
