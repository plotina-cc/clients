// SPDX-FileCopyrightText: 2026 Plotina
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Covers patch 0016-plotina-self-updater: the JSON the CI writes as
// update-mobile.json must parse into an UpdateManifest that the updater trusts
// only after `client`/`package`/sha256/size/versionCode check out, and a broken
// or hostile manifest must never throw out of the daily check.
//
// Run inside a fully patched upstream checkout:
//   cp ../tests/updater_manifest_test.dart test/
//   flutter test test/updater_manifest_test.dart

import 'package:fluffychat/utils/updater/update_manifest.dart';
import 'package:flutter_test/flutter_test.dart';

// The manifest publishes the number of the arm64 APK CI built: the build number
// of the tag plus the ABI digit Flutter's `--split-per-abi` writes into it
// (armeabi-v7a 1, arm64-v8a 2, x86_64 4). That is the number an installed app
// reads from its own PackageManager, so both sides live in the same space.
// See fluffychat/scripts/version-code.py and the CI step "Verify the APK
// versionCode", which reads it back out of the APK before writing the manifest.
int apkCode(int buildNumber, int abiDigit) => abiDigit * 1000 + buildNumber;

const _contract = '''
{
  "client": "mobile",
  "package": "cc.plotina.mobile",
  "versionName": "2.11.3",
  "versionCode": 2112323,
  "apkUrl": "https://plotina.cc/dl/Plotina-Mobile.apk",
  "sha256": "0f2e8c6b4a1d5f3c7b9e2a4c6d8f0b2d4e6a8c0e2f4a6b8d0e2f4a6b8d0e2f4a",
  "size": 118452311,
  "notes": "Plotina Mobile 2.11.3 (сборка 23): улучшения и исправления."
}
''';

void main() {
  test('parses the update-mobile.json contract', () {
    final m = UpdateManifest.tryParse(_contract);
    expect(m, isNotNull);
    expect(m!.client, 'mobile');
    expect(m.package, 'cc.plotina.mobile');
    expect(m.versionName, '2.11.3');
    expect(m.versionCode, 2112323);
    expect(m.apkUrl, 'https://plotina.cc/dl/Plotina-Mobile.apk');
    expect(m.size, 118452311);
    expect(m.notes, contains('23'));
  });

  test('every build of the arm64 APK outranks the one before it', () {
    // v2.11.3-plotina-mobile.22 -> .23 must increase, and a patch bump must
    // outrank every build of the older patch: patch * 100 + N stays below 1000,
    // so it never carries into the ABI digit (version-code.py enforces it).
    const build22 = 2 * 1000000 + 11 * 10000 + 3 * 100 + 22; // 2110322
    const build23 = 2 * 1000000 + 11 * 10000 + 3 * 100 + 23; // 2110323
    const nextPatch = 2 * 1000000 + 11 * 10000 + 4 * 100 + 1;
    expect(apkCode(build23, 2), 2112323);
    expect(apkCode(build23, 1), 2111323);
    expect(apkCode(build23, 2), greaterThan(apkCode(build22, 2)));
    expect(apkCode(nextPatch, 2), greaterThan(apkCode(build23, 2)));
    // Released .22 arm64 APKs report 2032 (build 32 + 2000): the first updater
    // build really does offer itself to a phone out in the field.
    expect(apkCode(build23, 2), greaterThan(2032));
    expect(
      UpdateManifest.tryParse(_contract)!.versionCode,
      apkCode(build23, 2),
    );
  });

  test('garbage and half-filled manifests are rejected, never thrown', () {
    for (final body in [
      '',
      'not json',
      '[]',
      '"a string"',
      // sha256 with the wrong length / non-hex
      _contract.replaceFirst(
        RegExp('"sha256": "[0-9a-f]*"'),
        '"sha256": "deadbeef"',
      ),
      // size missing
      _contract.replaceFirst('"size": 118452311,', ''),
      // versionCode as something unparsable
      _contract.replaceFirst('"versionCode": 2112323', '"versionCode": "x"'),
      // no path at all
      _contract.replaceFirst(
        RegExp('"apkUrl": "[^"]*"'),
        '"apkUrl": "https://plotina.cc"',
      ),
    ]) {
      expect(
        UpdateManifest.tryParse(body),
        isNull,
        reason:
            'must be rejected: ${body.length > 60 ? body.substring(0, 60) : body}',
      );
    }
  });

  test('numbers sent as strings still compare correctly', () {
    final m = UpdateManifest.tryParse(
      _contract
          .replaceFirst('"versionCode": 2112323', '"versionCode": "2112323"')
          .replaceFirst('"size": 118452311', '"size": 1.18452311e8'),
    );
    expect(m, isNotNull);
    expect(m!.versionCode, 2112323);
    expect(m.size, 118452311);
    // The updater's only decision: strictly newer than what is installed.
    expect(m.versionCode > 2112322, isTrue);
    expect(m.versionCode > 2112323, isFalse);
  });

  test('an uppercase sha256 from the manifest still matches the download', () {
    final m = UpdateManifest.tryParse(
      _contract.replaceFirst(
        RegExp('"sha256": "[^"]*"'),
        '"sha256": "0F2E8C6B4A1D5F3C7B9E2A4C6D8F0B2D4E6A8C0E2F4A6B8D0E2F4A6B8D0E2F4A"',
      ),
    );
    expect(m, isNotNull);
    // The Dart side compares against digest.toString(), which is lowercase.
    expect(m!.sha256, m.sha256.toLowerCase());
  });

  test('notes are optional, a manifest without them is still installable', () {
    final m = UpdateManifest.tryParse(
      _contract.replaceFirst(RegExp(',\\s*"notes": "[^"]*"'), ''),
    );
    expect(m, isNotNull);
    expect(m!.notes, isEmpty);
  });
}
