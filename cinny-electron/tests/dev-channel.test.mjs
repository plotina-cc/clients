// Unit tests for the update-channel policy (src/update-channel.js):
// feed-URL selection per (install kind x channel), the dev version grammar and
// ordering, the channel firewall, downgrade/stable-return decisions, the
// persisted preference, and the user-facing strings the Settings entry uses.
// Pure node, no Electron:  node tests/dev-channel.test.mjs
'use strict';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ch = require('../src/update-channel.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plotina-channel-'));

// ---------------------------------------------------------------- C1 feed URLs
t('C1 metadata file per install kind x channel', () => {
  assert.strictEqual(ch.metadataFileFor({ installKind: 'appimage', channel: 'stable' }), 'latest-lite-linux.yml');
  assert.strictEqual(ch.metadataFileFor({ installKind: 'appimage', channel: 'dev' }), 'latest-linux-dev.yml');
  assert.strictEqual(ch.metadataFileFor({ installKind: 'nsis', channel: 'stable' }), 'latest-lite.yml');
  assert.strictEqual(ch.metadataFileFor({ installKind: 'nsis', channel: 'dev' }), 'latest-dev.yml');
  // channel omitted -> stable is the default
  assert.strictEqual(ch.metadataFileFor({ installKind: 'nsis' }), 'latest-lite.yml');
  // kinds that never self-update read no feed at all
  for (const kind of ['package', 'msi', 'unknown', 'dev']) {
    assert.strictEqual(ch.metadataFileFor({ installKind: kind, channel: 'dev' }), null, kind);
    assert.strictEqual(ch.metadataFileFor({ installKind: kind, channel: 'stable' }), null, kind);
  }
  assert.strictEqual(ch.metadataFileFor({ installKind: 'appimage', channel: 'nonsense' }), null);
});

t('C1b dev feed URL is the GitHub dev-latest release, never edge', () => {
  assert.strictEqual(
    ch.devFeedUrl({ installKind: 'nsis', channel: 'dev' }),
    'https://github.com/plotina-cc/clients/releases/download/dev-latest/latest-dev.yml');
  assert.strictEqual(
    ch.devFeedUrl({ installKind: 'appimage', channel: 'dev' }),
    'https://github.com/plotina-cc/clients/releases/download/dev-latest/latest-linux-dev.yml');
  // stable channel never points at the dev release
  assert.strictEqual(ch.devFeedUrl({ installKind: 'appimage', channel: 'stable' }), null);
  assert.strictEqual(ch.devFeedUrl({ installKind: 'package', channel: 'dev' }), null);
  assert.ok(!ch.devFeedUrl({ installKind: 'appimage', channel: 'dev' }).includes('edge'));
  // env override for local QA kits, trailing slash normalized
  assert.strictEqual(
    ch.devFeedUrl({ installKind: 'appimage', channel: 'dev', devFeedBase: ch.resolveDevFeedBase({ LITE_DEV_FEED_URL: 'http://127.0.0.1:8099/dev/' }) }),
    'http://127.0.0.1:8099/dev/latest-linux-dev.yml');
  assert.strictEqual(ch.resolveDevFeedBase({}), ch.DEV_FEED_BASE);
});

t('C1c QA local feed override keeps the stable layout and follows the channel', () => {
  assert.strictEqual(
    ch.qaFeedUrl({ base: 'http://127.0.0.1:9/', installKind: 'appimage', channel: 'stable' }),
    'http://127.0.0.1:9/latest-lite-linux.yml');
  assert.strictEqual(
    ch.qaFeedUrl({ base: 'http://127.0.0.1:9', installKind: 'appimage', channel: 'dev' }),
    'http://127.0.0.1:9/latest-linux-dev.yml');
  assert.strictEqual(ch.qaFeedUrl({ base: '', installKind: 'appimage', channel: 'dev' }), null);
  assert.strictEqual(ch.qaFeedUrl({ base: 'http://h/', installKind: 'msi', channel: 'dev' }), null);
});

// ------------------------------------------------------------ C2 dev versions
t('C2 dev version parsing', () => {
  assert.deepStrictEqual(ch.versionTokens('4.12.8-plotina.19-dev.2'), [4, 12, 8, 19, 2]);
  assert.deepStrictEqual(ch.versionTokens('4.12.8-plotina.19'), [4, 12, 8, 19, 0]);
  assert.deepStrictEqual(ch.versionTokens('4.12.8-plotina.0.local'), [4, 12, 8, 0, 0]);
  assert.deepStrictEqual(ch.versionTokens('4.12.8-plotina.20-dev.11'), [4, 12, 8, 20, 11]);
  // garbage / foreign shapes are NOT versions
  for (const bad of ['4.12.8-plotina.19-dev.x', '4.12.8-plotina.19-dev', '4.12.818',
                     '4.12.8', '4.12.8-dev.1', '4.12.8-plotina.19+build', '', null, undefined,
                     '4.12.8-plotina.19-dev.2-extra']) {
    assert.strictEqual(ch.versionTokens(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

t('C2b dev version comparison is plain ordering', () => {
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.19-dev.2', '4.12.8-plotina.19-dev.1'), true);
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.19-dev.1', '4.12.8-plotina.19-dev.2'), false);
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.19-dev.9', '4.12.8-plotina.19-dev.9'), false);
  // a dev build of the same -plotina.N rev sorts above that stable rev
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.19-dev.1', '4.12.8-plotina.19'), true);
  assert.strictEqual(ch.isVersionLower('4.12.8-plotina.19', '4.12.8-plotina.19-dev.1'), true);
  // and the stable rev that follows is newer than any dev of the previous rev
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.20', '4.12.8-plotina.19-dev.7'), true);
  assert.strictEqual(ch.isVersionNewer('4.13.0-plotina.1-dev.1', '4.12.8-plotina.19-dev.7'), true);
  assert.strictEqual(ch.compareVersions('4.12.818', '4.12.8-plotina.19'), null);
  assert.strictEqual(ch.isVersionNewer('4.12.8-plotina.20', '4.12.8-plotina.19-dev.7'), true);
});

t('C2c version shape -> channel classification', () => {
  assert.strictEqual(ch.channelOfVersion('4.12.8-plotina.19-dev.2'), 'dev');
  assert.strictEqual(ch.channelOfVersion('4.12.8-plotina.19'), 'stable');
  assert.strictEqual(ch.channelOfVersion('4.12.8-plotina.0.local'), 'stable');
  assert.strictEqual(ch.channelOfVersion('4.12.818'), null);
  assert.strictEqual(ch.isDevVersion('4.12.8-plotina.19-dev.2'), true);
  assert.strictEqual(ch.isDevVersion('4.12.8-plotina.19'), false);
  assert.strictEqual(ch.isStableVersion('4.12.8-plotina.19-dev.2'), false);
  assert.strictEqual(ch.pickHighestVersion(['4.12.8-plotina.19', '4.12.8-plotina.21', 'junk', '4.12.8-plotina.20-dev.3']), '4.12.8-plotina.21');
  assert.strictEqual(ch.pickHighestVersion(['junk']), null);
});

// -------------------------------------------------------------- C3 the firewall
t('C3 a dev build is never a candidate on the stable channel', () => {
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.8-plotina.19-dev.2', channel: 'stable' }), false);
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.8-plotina.19', channel: 'stable' }), true);
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.8-plotina.19-dev.2', channel: 'dev' }), true);
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.8-plotina.20', channel: 'dev' }), true);
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.818', channel: 'dev' }), false);
  assert.strictEqual(ch.isCandidateAllowed({ candidateVersion: '4.12.8-plotina.19', channel: 'bogus' }), false);
});

t('C4 planUpdate: upgrade / same / blocked / downgrade / invalid / foreign', () => {
  const base = '4.12.8-plotina.18';
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.19', currentVersion: base }), 'apply');
  assert.strictEqual(ch.planUpdate({ candidateVersion: base, currentVersion: base }), 'same');
  // automatic checks never reduce a version
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.17', currentVersion: base }), 'blocked');
  // only the explicit return-to-stable action may downgrade
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.17', currentVersion: base, allowDowngrade: true }), 'downgrade');
  // dev -> stable of the same rev IS a reduction (dev sorts higher)
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.19', currentVersion: '4.12.8-plotina.19-dev.4' }), 'blocked');
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.19', currentVersion: '4.12.8-plotina.19-dev.4', allowDowngrade: true, channel: 'stable' }), 'downgrade');
  // foreign candidate on stable is refused regardless of allowDowngrade
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.19-dev.4', currentVersion: base, allowDowngrade: true, channel: 'stable' }), 'foreign');
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.818', currentVersion: base }), 'invalid');
  assert.strictEqual(ch.planUpdate({ candidateVersion: '4.12.8-plotina.19', currentVersion: 'not-a-version' }), 'invalid');
});

// ------------------------------------------------------------- C5 persistence
t('C5 channel preference: default stable, roundtrip, damage falls back', () => {
  const dir = tmpDir();
  try {
    assert.deepStrictEqual(ch.readChannel(dir, {}), { channel: 'stable', source: 'default', devAcknowledgedAt: null });
    assert.strictEqual(ch.writeChannel(dir, 'dev', { acknowledged: false }).needsConfirmation, true,
      'dev without acknowledgement is not stored');
    assert.strictEqual(ch.readChannel(dir, {}).channel, 'stable');
    const written = ch.writeChannel(dir, 'dev', { acknowledged: true, now: new Date('2026-11-07T00:00:00.000Z') });
    assert.strictEqual(written.ok, true);
    assert.strictEqual(ch.readChannel(dir, {}).channel, 'dev');
    assert.strictEqual(ch.readChannel(dir, {}).devAcknowledgedAt, '2026-11-07T00:00:00.000Z');
    assert.strictEqual(ch.writeChannel(dir, 'stable').channel, 'stable');
    assert.strictEqual(ch.readChannel(dir, {}).channel, 'stable');
    // damaged / nonsense files must not turn dev on
    fs.writeFileSync(ch.channelFilePath(dir), '{not json');
    assert.strictEqual(ch.readChannel(dir, {}).channel, 'stable');
    fs.writeFileSync(ch.channelFilePath(dir), JSON.stringify({ channel: 'nightly' }));
    assert.strictEqual(ch.readChannel(dir, {}).channel, 'stable');
    // env override (QA / manual feed testing) wins over the file
    fs.writeFileSync(ch.channelFilePath(dir), JSON.stringify({ channel: 'stable' }));
    assert.deepStrictEqual(ch.readChannel(dir, { LITE_UPDATE_CHANNEL: 'dev' }),
      { channel: 'dev', source: 'env', devAcknowledgedAt: null });
    assert.strictEqual(ch.readChannel(dir, { LITE_UPDATE_CHANNEL: 'bogus' }).channel, 'stable');
    assert.throws(() => ch.writeChannel(dir, 'nightly'), TypeError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --------------------------------------------------------------- C6 UI strings
t('C6 the Settings entry strings are the approved Russian labels', () => {
  assert.strictEqual(ch.UI_TEXT.channelEntry('stable'), 'Канал обновлений: Стабильный');
  assert.strictEqual(ch.UI_TEXT.channelEntry('dev'), 'Канал обновлений: Dev');
  assert.strictEqual(ch.UI_TEXT.returnToStable, 'Вернуться на стабильный');
  assert.strictEqual(ch.UI_TEXT.stableLabel, 'Стабильный');
  assert.strictEqual(ch.UI_TEXT.devLabel, 'Dev');
  assert.match(ch.UI_TEXT.devWarningDetail, /тестовые сборки/);
  assert.match(ch.UI_TEXT.devWarningDetail, /возврат на стабильный/i);
  assert.match(ch.UI_TEXT.downgradeDetail('4.12.8-plotina.19-dev.3', '4.12.8-plotina.19'), /понижение версии/);
  assert.ok(ch.UI_TEXT.devWarningButtons.length === 2);
});

t('C7 only appimage and nsis self-update', () => {
  assert.strictEqual(ch.isSelfUpdateKind('appimage'), true);
  assert.strictEqual(ch.isSelfUpdateKind('nsis'), true);
  for (const kind of ['package', 'msi', 'unknown', 'dev']) assert.strictEqual(ch.isSelfUpdateKind(kind), false, kind);
});

console.log(`\n${n} update-channel unit tests passed`);
