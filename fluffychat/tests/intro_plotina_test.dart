// Regression test for patches/0012-plotina-intro-buttons.patch:
// boots the REAL patched app through the REAL router ('/' -> '/home' ->
// IntroPagePresenter -> IntroPage) in the OnePlus 13-sized window seen in
// the user's screenshot (1438x2411 px @ dpr 4.0 = 359.5x602.75 dp) and on
// the full screen (1440x3168). The fork default patch 0002 sets
// presetHomeserver='plotina.cc', so only 'Sign in' must be present — and it
// must be fully inside the visible viewport without any scrolling.
//
// How to run (inside a fully patched upstream checkout):
//   flutter pub get
//   # gen-l10n must disable deferred loading for the test VM; upstream's
//   # l10n.yaml sets use-deferred-loading: true, whose dynamic imports
//   # never complete under flutter_test.
//   sed -i 's/use-deferred-loading: true/use-deferred-loading: false/' l10n.yaml
//   flutter gen-l10n
//   flutter test test/pages/intro/intro_plotina_test.dart   # after copying this file there
import 'package:fluffychat/config/setting_keys.dart';
import 'package:fluffychat/widgets/fluffy_chat_app.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> pumpHome(WidgetTester tester, Size physical) async {
  tester.view.physicalSize = physical;
  tester.view.devicePixelRatio = 4.0;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  await AppSettings.init();
  final store = await SharedPreferences.getInstance();
  await tester.pumpWidget(
    FluffyChatApp(
      clients: const [],
      store: store,
      appLockSettings: (pincode: null, useBiometrics: false),
    ),
  );
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('plotina fork: sign in visible on the 1438x2411 window', (tester) async {
    await pumpHome(tester, const Size(1438, 2411));
    final exc = tester.takeException();
    if (exc != null) print('PUMP EXCEPTION: $exc');
    final signIn = find.widgetWithText(ElevatedButton, 'Sign in');
    expect(signIn, findsOneWidget);
    final rect = tester.getRect(signIn);
    final windowH = tester.view.physicalSize.height / 4.0;
    print('SIGNIN rect=${rect.top.toStringAsFixed(1)}..${rect.bottom.toStringAsFixed(1)} windowH=$windowH');
    expect(rect.top, greaterThanOrEqualTo(0));
    expect(rect.bottom, lessThanOrEqualTo(windowH));
    // Preset homeserver suppresses the other two buttons by design (patch 0002):
    expect(find.widgetWithText(ElevatedButton, 'Create new account'), findsNothing);
    expect(find.text('Login with Matrix-ID'), findsNothing);
    expect(exc, isNull);
  });

  testWidgets('plotina fork: sign in visible on the full 1440x3168 screen', (tester) async {
    await pumpHome(tester, const Size(1440, 3168));
    final exc = tester.takeException();
    if (exc != null) print('PUMP EXCEPTION: $exc');
    final signIn = find.widgetWithText(ElevatedButton, 'Sign in');
    expect(signIn, findsOneWidget);
    final rect = tester.getRect(signIn);
    print('FULLSIGNIN rect=${rect.top.toStringAsFixed(1)}..${rect.bottom.toStringAsFixed(1)}');
    expect(rect.bottom, lessThanOrEqualTo(tester.view.physicalSize.height / 4.0));
    // Regression gate for patch 0012: with the upstream `Spacer()` the button is
    // bottom-anchored to the *reported* viewport (gap here is >200 dp on 792 dp
    // tall layouts). The fix flows it directly after the description, so the gap
    // must be small. This assertion FAILS on unpatched v2.11.3 and PASSES on the
    // patched tree, independent of window-size reporting bugs.
    final descBottom = tester.getRect(find.textContaining('Communicate encrypted')).bottom;
    print('GAP desc->button = ${(rect.top - descBottom).toStringAsFixed(1)} dp');
    expect(rect.top - descBottom, lessThanOrEqualTo(64));
    expect(exc, isNull);
  });

}
