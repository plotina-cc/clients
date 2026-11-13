// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for patches/0025-plotina-cancel-on-read.patch.
//
// The bug: a message arrives in a room, the notification shows up in the
// Android shade, the user opens that room in the app and reads it — and the
// notification stays there until it is tapped. The same happens when the room
// was read on another device: the notification is never dismissed either.
//
// Upstream context: upstream cancels notifications from the sync stream
// (`cancelNotificationsOnSync`, commit ceb1331 "clear up active notifications
// on sync on all platforms"). That commit is in the upstream tags v2.11.2 and
// v2.11.5 and absent from v2.11.3 — the tag in `fluffychat/UPSTREAM_TAG` we
// build on — where the walk over the shade existed only in the push helper's
// clearing branch and nothing drove it from a sync. So this is not a Plotina
// patch that broke it; the base tag never had the path.
//
// What this file pins, on a real `Client` fed with sync responses and a fake
// notifications platform:
//  * read inside the app (the chat page's read marker comes back in the sync):
//    that room's notification is cancelled, the other room's is not;
//  * read on another device (only the sync says so, no local action): same;
//  * a cold start, where the app never set a read marker and the first sync
//    already reports the room as read: same;
//  * a room that is still unread is never cancelled;
//  * the same state arriving again cancels nothing and rebuilds nothing
//    (idempotent, one `getActiveNotifications` walk, no repeat of the work);
//  * the Android summary notification is recalculated from what is left;
//  * the app is wired to this path and the tap handler is not the trigger.
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

const _clientName = 'plotina';
const _me = '@plotina:homeserver.test';
const _roomA = '!room-a:homeserver.test';
const _roomB = '!room-b:homeserver.test';

/// The id a room's notification is shown and cancelled under, exactly as
/// `FluffyChatPushPayload` and `local_notifications_extension.dart` compute it.
int _notificationId(String roomId) => '${_clientName}_$roomId'.hashCode;

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

/// Stands in for the Android notifications plugin: keeps the list of
/// notifications that are in the shade and records every call.
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
  }

  /// Cancels that target a room's notification, i.e. everything but the group
  /// summary, which `updateSummaryNotification` cancels under the client name's
  /// id when the last notification of that account is gone.
  List<int> get roomCancels =>
      cancelled.where((id) => id != _clientName.hashCode).toList();
}

ActiveNotification _notification(String roomId, String body) =>
    ActiveNotification(
      id: _notificationId(roomId),
      groupKey: _clientName,
      title: 'Chat',
      body: body,
    );

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
    platform.active.addAll([
      _notification(_roomA, 'message in A'),
      _notification(_roomB, 'message in B'),
    ]);

    // The read marker the chat page sent for room A comes back in our sync.
    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0, receiptFromMe: true),
        _roomB: _joinedRoom(unread: 2),
      }),
    );
    await pumpEventQueue();

    expect(platform.roomCancels, [_notificationId(_roomA)]);
    expect(platform.cancelled, isNot(contains(_notificationId(_roomB))));
    expect(
      platform.active.map((notification) => notification.id),
      [_notificationId(_roomB)],
    );
    // The summary is rebuilt from what is left, not from what was dismissed.
    expect(platform.shown, contains(_clientName.hashCode));
  });

  test('a room read on another device is dismissed too', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    platform.active.add(_notification(_roomA, 'message in A'));

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

    expect(platform.roomCancels, [_notificationId(_roomA)]);
    expect(platform.active, isEmpty);
  });

  test('a cold start dismisses a room that is already read', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    // The notification was posted while the app was closed; by the time it
    // starts, the message has been read on the desktop and the first sync
    // already reports the room as read. No local read marker ever ran.
    platform.active.add(_notification(_roomA, 'message in A'));

    await client.handleSync(
      _syncUpdate({_roomA: _joinedRoom(unread: 0)}),
    );
    await pumpEventQueue();

    expect(client.rooms.single.notificationCount, 0);
    expect(platform.roomCancels, [_notificationId(_roomA)]);
  });

  test('a room that is still unread keeps its notification', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    platform.active.add(_notification(_roomB, 'message in B'));

    await client.handleSync(
      _syncUpdate({
        _roomA: _joinedRoom(unread: 0),
        _roomB: _joinedRoom(unread: 3),
      }),
    );
    await pumpEventQueue();

    expect(platform.roomCancels, isEmpty);
    expect(
      platform.active.map((notification) => notification.id),
      [_notificationId(_roomB)],
    );
  });

  test('the same read state arriving again does nothing twice', () async {
    final subscription = listenLikeTheApp();
    addTearDown(subscription.cancel);
    platform.active.addAll([
      _notification(_roomA, 'message in A'),
      _notification(_roomB, 'message in B'),
    ]);

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
      expect(matrixState, contains('onReadRooms[name] ??= c.onSync.stream.listen('));
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

    test('the chat page still sets a read marker on its own', () {
      // The cancel path must not depend on the tap handler: the receipt the
      // chat page sends is what triggers it.
      expect(chatPage, matches(RegExp(r'timeline\s*\.setReadMarker\(')));
      expect(chatPage, isNot(contains('cancelNotificationsOfReadRooms')));
    });
  });
}
