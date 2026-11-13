// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for patches/0025-plotina-cancel-on-read.patch.
//
// The bug: a message arrives in a room, the notification shows up in the
// Android shade, the user reads the room — in the app or on another device —
// and the notification stays there until it is tapped.
//
// The defect `.35-dev.1` shipped with is not "the path is not reached": QA
// (`t_ece478f5` §3-§5) saw `cancelNotificationsOfReadRooms()` run and cancel
// zero notifications. The shade held the notification under `roomId.hashCode`
// (672513629 for room A) while the cancel walk searched
// `'${clientName}_$roomId'.hashCode` (711748308), because the id a notification
// is *posted* under depends on the push payload: `devices[0].data.client_name`
// present → prefixed id, absent (UnifiedPush strips `devices`, FCM counts
// pushes have none) → the room id's own hash.
//
// So this file prepares the shade the way a device does: every notification is
// posted **through `plotinaShowRoomNotification()`**, the function the push
// helper itself calls, and the id it returns is the id asserted on. The test
// cannot invent an id that the production show path does not produce — the
// first version of this patch did exactly that and stayed green on a build that
// dismissed nothing (QA §6).
//
// What is pinned, on a real `Client` fed with sync responses and a fake
// notifications platform:
//  * read inside the app (the chat page's read marker comes back in the sync):
//    that room's notification is cancelled, the other room's is not;
//  * read on another device (only the sync says so, no local action): same;
//  * a cold start, where the app never set a read marker and the first sync
//    already reports the room as read: same;
//  * a notification posted from a payload that *does* carry a client name
//    (desktop-style push) is dismissed as well — both id shapes are matched;
//  * a room that is still unread is never cancelled;
//  * the same state arriving again cancels nothing and rebuilds nothing
//    (idempotent, one `getActiveNotifications` walk, no repeat of the work);
//  * the Android summary notification is recalculated from what is left;
//  * show, the messaging-style lookup and the cancel walk derive the id from
//    one function, and the app is wired to the sync stream.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   flutter gen-l10n
//   cp tests/plotina_push_cancel_test.dart test/
//   flutter test test/plotina_push_cancel_test.dart
//
// No emulator, no homeserver, no FCM: the sync update is the JSON the server
// would send, the client is a real `Client` with an in-memory database, and the
// platform call is the fake below.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fluffychat/l10n/l10n.dart';
import 'package:fluffychat/utils/push_helper.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:material_ui/material_ui.dart';
import 'package:matrix/matrix.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// The account's `clientName`: what a payload carrying `devices` puts in
/// `client_name` and what the Android notification group key is.
const _clientName = 'Plotina Mobile android';
const _me = '@plotina:homeserver.test';

/// The two rooms QA used on the emulator (`t_ece478f5` §2), so the ids in a
/// failing run are the ids from the device report.
const _roomA = '!-CFM_KhCIY4gX2nBTlmzP2zxKg5TYp4QQvCFcyd8MLY';
const _roomB = '!54EO0BMbBqT2nVNX6s4hYFwiyjE0bbmxOHDCJaoOKc8';

/// Answers every request with `{}` so `Client.init` can run its own bookkeeping
/// without a homeserver; the syncs that matter are injected with `handleSync`.
class _QuietHttpClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async =>
      http.StreamedResponse(
        Stream.value(utf8.encode('{}')),
        200,
        request: request,
        headers: {'content-type': 'application/json'},
      );
}

/// Stands in for the Android notifications plugin: `show` puts the notification
/// into the shade exactly as posted, `cancel` takes it out, every call is
/// recorded.
class _FakeNotifications extends AndroidFlutterLocalNotificationsPlugin {
  final active = <ActiveNotification>[];
  final cancelled = <int>[];
  final shown = <int>[];
  var walks = 0;

  @override
  Future<List<ActiveNotification>> getActiveNotifications() async {
    walks++;
    return List.of(active);
  }

  @override
  Future<void> cancel({required int id, String? tag}) async {
    cancelled.add(id);
    active.removeWhere((notification) => notification.id == id);
  }

  @override
  Future<void> cancelAll() async {
    cancelled.addAll(active.map((notification) => notification.id!));
    active.clear();
  }

  @override
  Future<void> show({
    required int id,
    String? title,
    String? body,
    AndroidNotificationDetails? notificationDetails,
    String? payload,
  }) async {
    shown.add(id);
    active.add(
      ActiveNotification(
        id: id,
        groupKey: _clientName,
        title: title,
        body: body,
      ),
    );
  }

  /// Cancels that target a room's notification, i.e. everything but the group
  /// summary, which `updateSummaryNotification` shows and cancels under the
  /// client name's id.
  List<int> get roomCancels =>
      cancelled.where((id) => id != _clientName.hashCode).toList();

  /// The room notifications still in the shade, the same way.
  List<int?> get shadeRoomIds => active
      .where((notification) => notification.id != _clientName.hashCode)
      .map((notification) => notification.id)
      .toList();
}

/// One room in a `/sync` response: [unread] notifications left, and an
/// `m.receipt` event if [receiptFromMe] is set — the shape the server sends
/// after the user read a message, here or on another device.
Map<String, Object?> _joinedRoom({
  int unread = 0,
  bool receiptFromMe = false,
  bool privateReceipt = false,
}) => {
  'timeline': {
    'events': <Object?>[],
    'prev_batch': 'p1',
    'limited': false,
  },
  'unread_notifications': {
    'notification_count': unread,
    'highlight_count': 0,
  },
  if (receiptFromMe)
    'ephemeral': {
      'events': [
        {
          'type': 'm.receipt',
          'content': {
            r'$event': {
              privateReceipt ? 'm.read.private' : 'm.read': {
                _me: {'ts': 1794591602000},
              },
            },
          },
        },
      ],
    },
};

/// A `/sync` response; through JSON so every nested map is a
/// `Map<String, Object?>` like a real one.
SyncUpdate _syncUpdate(Map<String, Object?> join) => SyncUpdate.fromJson(
  jsonDecode(
        jsonEncode({
          'next_batch': 's1',
          'rooms': {'join': join},
        }),
      )
      as Map<String, Object?>,
);

Future<Client> _prepareClient() async {
  sqfliteFfiInit();
  final client = Client(
    _clientName,
    httpClient: _QuietHttpClient(),
    database: await MatrixSdkDatabase.init(
      'plotina_push_cancel_test',
      database: await databaseFactoryFfi.openDatabase(':memory:'),
      sqfliteFactory: databaseFactoryFfi,
    ),
  );
  await client.init(
    newToken: 'plotina-test-token',
    newUserID: _me,
    newDeviceID: 'PLOTINATEST',
    newDeviceName: 'Plotina push cancel test',
    newHomeserver: Uri.parse('https://homeserver.test'),
    waitForFirstSync: false,
  );
  return client;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _FakeNotifications platform;
  late FlutterLocalNotificationsPlugin plugin;
  late L10n l10n;
  late Client client;

  /// Posts a room's notification through the function the push helper calls.
  ///
  /// [clientName] is the `devices[0].data.client_name` of the payload: `null`
  /// is the shape the device actually receives (QA §5.1: `{room_id, event_id,
  /// prio, unread}`, no `devices`), a value is a payload that kept it.
  Future<int> post(
    String roomId,
    String body, {
    String? clientName,
  }) => plotinaShowRoomNotification(
    flutterLocalNotificationsPlugin: plugin,
    clientName: clientName,
    roomId: roomId,
    notificationDetails: NotificationDetails(
      android: AndroidNotificationDetails('messages', 'Messages'),
    ),
    title: 'Chat',
    body: body,
    payload: FluffyChatPushPayload(clientName, roomId, r'$event').toString(),
  );

  setUp(() async {
    // Android is the only platform we ship; it also makes the plugin dispatch
    // `show`/`cancel` to the Android implementation, which the fake is.
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    platform = _FakeNotifications();
    FlutterLocalNotificationsPlatform.instance = platform;
    plugin = FlutterLocalNotificationsPlugin();
    l10n = await L10n.delegate.load(const Locale('en'));
    client = await _prepareClient();
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    client.dispose();
  });

  /// The subscription `MatrixState` installs on every client: a sync arrived,
  /// dismiss what is read, keep what is not.
  StreamSubscription<SyncUpdate> listenLikeTheApp() =>
      client.onSync.stream.listen(
        (_) => cancelNotificationsOfReadRooms(
          clientName: client.clientName,
          rooms: client.rooms,
          l10n: l10n,
          flutterLocalNotificationsPlugin: plugin,
          updateSummary: true,
        ),
      );

  test('a room read inside the app is dismissed from the shade', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    // The payload the device gets has no `devices`, so the notification is
    // posted under the room id's own hash — not under the prefixed id.
    final idA = await post(_roomA, 'message in A');
    final idB = await post(_roomB, 'message in B');
    expect(
      idA,
      _roomA.hashCode,
      reason:
          'QA t_ece478f5 §4: the shade held 672513629 for this room, the '
          'room id hash, not the prefixed 711748308',
    );
    expect(idA, isNot('${_clientName}_$_roomA'.hashCode));

    // The read marker the chat page sent for room A comes back in our sync.
    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0, receiptFromMe: true),
        _roomB: _joinedRoom(unread: 2),
      }),
    );
    await pumpEventQueue();

    expect(platform.roomCancels, [idA]);
    expect(platform.cancelled, isNot(contains(idB)));
    expect(platform.shadeRoomIds, [idB]);
    // The summary is rebuilt from what is left, not from what was dismissed.
    expect(platform.shown, contains(_clientName.hashCode));
  });

  test('a room read on another device is dismissed too', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    final idA = await post(_roomA, 'message in A');

    // Nothing happened on this device: no `setReadMarker`, no tap. The only
    // thing that arrives is the sync saying the room is read — the receipt can
    // be a private one, which is what another device of the account sends when
    // public read receipts are off.
    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0, receiptFromMe: true, privateReceipt: true),
      }),
    );
    await pumpEventQueue();

    expect(platform.roomCancels, [idA]);
    expect(platform.shadeRoomIds, isEmpty);
  });

  test('a cold start dismisses a room that is already read', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    // The notification was posted while the app was closed; by the time it
    // starts, the message has been read on the desktop and the first sync
    // already reports the room as read. No local read marker ever ran.
    final idA = await post(_roomA, 'message in A');

    await client.handleSync(_syncUpdate({_roomA: _joinedRoom(unread: 0)}));
    await pumpEventQueue();

    expect(client.rooms.single.notificationCount, 0);
    expect(platform.roomCancels, [idA]);
  });

  test('a notification posted with a client name is dismissed too', () async {
    // A payload that still carries `devices` posts the prefixed id. The cancel
    // walk cannot know which payload posted what is in the shade, so it has to
    // match this shape as well.
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    final idA = await post(_roomA, 'message in A', clientName: _clientName);
    expect(idA, '${_clientName}_$_roomA'.hashCode);

    await client.handleSync(_syncUpdate({_roomA: _joinedRoom(unread: 0)}));
    await pumpEventQueue();

    expect(platform.roomCancels, [idA]);
    expect(platform.shadeRoomIds, isEmpty);
  });

  test('a room that is still unread keeps its notification', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    final idB = await post(_roomB, 'message in B');

    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0),
        _roomB: _joinedRoom(unread: 3),
      }),
    );
    await pumpEventQueue();

    expect(platform.roomCancels, isEmpty);
    expect(platform.shadeRoomIds, [idB]);
  });

  test('the same read state arriving again does nothing twice', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    await post(_roomA, 'message in A');
    await post(_roomB, 'message in B');

    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0, receiptFromMe: true),
        _roomB: _joinedRoom(unread: 2),
      }),
    );
    await pumpEventQueue();
    final cancelsAfterFirst = platform.cancelled.length;
    final shownAfterFirst = platform.shown.length;
    final walksAfterFirst = platform.walks;
    expect(cancelsAfterFirst, 1);

    // The next sync carries the same state (unread counters unchanged).
    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0, receiptFromMe: true),
        _roomB: _joinedRoom(unread: 2),
      }),
    );
    await pumpEventQueue();

    expect(platform.cancelled.length, cancelsAfterFirst);
    expect(platform.shown.length, shownAfterFirst);
    expect(platform.walks, walksAfterFirst + 1);
  });

  // The service above is only half the fix: if `MatrixState` does not subscribe
  // to the sync stream, nothing calls it on a device. Assert the wiring at the
  // source, the way the 0023 tests pin their two entry points.
  group('the app is wired to the read path', () {
    final matrixState = File('lib/widgets/matrix.dart').readAsStringSync();
    final pushHelper = File('lib/utils/push_helper.dart').readAsStringSync();
    final chatPage = File('lib/pages/chat/chat.dart').readAsStringSync();

    test('MatrixState listens on every client sync stream', () {
      expect(
        matrixState,
        contains('onReadRooms[name] ??= c.onSync.stream.listen('),
      );
      expect(matrixState, contains('cancelNotificationsOfReadRooms('));
    });

    test('the subscription is dropped with the client, not leaked', () {
      expect(matrixState, contains('onReadRooms[name]?.cancel();'));
      expect(matrixState, contains('onReadRooms.clear();'));
    });

    test('there is one walk over the shade, not two', () {
      // One definition, used by the push helper's clearing branch — and the
      // inline copy it replaced is gone, so the read path cannot drift from the
      // push path.
      expect(
        RegExp(
          r'Future<int> cancelNotificationsOfReadRooms\(',
        ).allMatches(pushHelper).length,
        1,
      );
      expect(pushHelper, contains('await cancelNotificationsOfReadRooms('));
      expect(pushHelper, isNot(contains('needsUpdateForSummaryNotification')));
    });

    test('the show path and the cancel path use one id function', () {
      // The defect of `.35-dev.1`: the show call and the cancel walk each had
      // their own formula, so the shade held an id nothing cancelled. The show
      // call goes through the helper, and no second formula is left behind.
      expect(pushHelper, contains('await plotinaShowRoomNotification('));
      expect(
        pushHelper,
        isNot(contains(r"'${clientName}_${room.id}'.hashCode")),
      );
      expect(
        pushHelper,
        isNot(contains(r"'${client.clientName}_${notification.roomId}'.hashCode")),
      );
    });

    test('the chat page still sets a read marker on its own', () {
      // The cancel path must not depend on the tap handler: the receipt the
      // chat page sends is what triggers it.
      expect(chatPage, matches(RegExp(r'timeline\s*\.setReadMarker\(')));
      expect(chatPage, isNot(contains('cancelNotificationsOfReadRooms')));
    });
  });
}
