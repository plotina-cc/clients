// Flow tests for the channel-aware updater (src/updater.js) driven with the
// fake electron + a fake fetch, so no network and no Electron are involved:
//
//   F1 stable channel reads ONLY the GitHub releases listing (never dev URLs)
//   F2 dev channel reads the dev-latest direct URL and installs the dev build
//   F3 a -dev. build advertised on the STABLE feed is refused (never offered)
//   F4 'Вернуться на стабильный' installs a LOWER stable version (downgrade)
//   F5 an automatic check never downgrades
//   F6 the preload IPC contract (get/set + confirmation + return-to-stable)
//   F7 feed/asset metadata parsing for a dev feed file (deb-first selection)
//
// node tests/updater-channel-flow.test.mjs
'use strict';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { installElectronStub } = require('./helpers/electron-stub.cjs');
const policy = require('../src/update-channel.js');

const DEV_BASE = 'https://github.com/plotina-cc/clients/releases/download/dev-latest';
const API_URL = 'https://api.github.com/repos/plotina-cc/clients/releases?per_page=100';

// ------------------------------------------------------------------ fixtures
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plotina-flow-'));
const profile = path.join(root, 'profile');
const resources = path.join(root, 'resources');
const appImagePath = path.join(root, 'Plotina-Lite-Desktop-4.12.8-plotina.18-x86_64.AppImage');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(resources, { recursive: true });
fs.writeFileSync(path.join(resources, 'app-update.yml'),
  'provider: github\nowner: plotina-cc\nrepo: clients\nreleaseType: release\n');
fs.writeFileSync(appImagePath, '#!/bin/sh\necho running-image\n');
process.env.APPIMAGE = appImagePath;
process.resourcesPath = resources;
delete process.env.PLOTINA_QA_UPDATES;
delete process.env.PLOTINA_UPDATE_FEED_URL;
delete process.env.LITE_NO_UPDATES;
delete process.env.LITE_UPDATE_CHANNEL;
delete process.env.LITE_DEV_FEED_URL;

const state = installElectronStub({ version: '4.12.8-plotina.18', userData: profile });
const updater = require('../src/updater.js');
// init() installs the status target (so sendStatus payloads are observable)
// and the IPC handlers F6 exercises; its polling timers are unref'd and the
// suite finishes long before the first one fires (dispose() clears them).
updater.init(() => state.webContents);

const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const artifactBytes = (label) => Buffer.from(`#!/bin/sh\necho '${label}'\n` + 'x'.repeat(4096));
const aiName = (version) => `Plotina-Lite-Desktop-${version}-x86_64.AppImage`;

/** latest-linux-dev.yml / latest-linux.yml body, deb listed FIRST (the trap
 *  the AppImage picker must survive) with per-file sha512/size. */
function linuxYml({ version, bytes }) {
  const file = aiName(version);
  return `version: ${version}\nfiles:\n  - url: Plotina-Lite-Desktop-${version}-amd64.deb\n` +
    `    sha512: ${sha512b64(Buffer.from('deb-bytes'))}\n    size: 9\n  - url: ${file}\n` +
    `    sha512: ${sha512b64(bytes)}\n    size: ${bytes.length}\npath: ${file}\n` +
    `sha512: ${sha512b64(bytes)}\nreleaseDate: '2026-11-07T10:00:00.000Z'\n`;
}

let requested = [];
function serve(routes) {
  requested = [];
  return async (url) => {
    requested.push(url);
    const hit = routes[url];
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (typeof hit === 'function') return hit(url);
    if (typeof hit === 'string') return new Response(hit, { status: 200 });
    if (Buffer.isBuffer(hit)) return new Response(hit, { status: 200 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
const ghRelease = (version, bytes, metaFile = 'latest-lite-linux.yml') => {
  const ymlUrl = `https://github.com/plotina-cc/clients/releases/download/v${version}/${metaFile}`;
  const artUrl = `https://github.com/plotina-cc/clients/releases/download/v${version}/${aiName(version)}`;
  return {
    routes: {
      [ymlUrl]: linuxYml({ version, bytes }),
      [artUrl]: bytes,
      [API_URL]: [{ tag_name: `v${version}`, draft: false, prerelease: false, assets: [
        { name: metaFile, browser_download_url: ymlUrl },
        { name: aiName(version), browser_download_url: artUrl },
      ] }],
    },
    ymlUrl, artUrl,
  };
};

function resetChannel(channelName) {
  state.statuses.length = 0;
  state.messages.length = 0;
  if (channelName) fs.writeFileSync(policy.channelFilePath(profile), JSON.stringify({ channel: channelName }));
  else fs.rmSync(policy.channelFilePath(profile), { force: true });
}

/** Switch channels the way the menu does. Besides writing the preference this
 *  drops a pending update that came from the other feed (a downloaded stable
 *  image must not be installed after the user asked for dev, or vice versa),
 *  which is exactly why the next runCheck performs a real fetch. */
function switchTo(channelName) {
  const r = updater.setChannel(channelName, { acknowledged: true, manual: true });
  assert.strictEqual(r.ok, true, `switch to ${channelName}`);
  assert.strictEqual(r.state.channel, channelName);
  assert.ok(state.statuses.some((s) => s.state === 'channel'), 'channel change reported');
  state.statuses.length = 0;
  state.messages.length = 0;
}
const statusFor = (s) => state.statuses.find((p) => p.state === s);
const appImageBytes = () => fs.readFileSync(appImagePath);

// ------------------------------------------------------------------- run
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('F1 stable channel reads the release listing only, never a dev URL', async () => {
  const version = '4.12.8-plotina.19';
  const bytes = artifactBytes('stable-19');
  const rel = ghRelease(version, bytes);
  const devYml = `${DEV_BASE}/latest-linux-dev.yml`;
  globalThis.fetch = serve({ ...rel.routes, [devYml]: linuxYml({ version: '4.12.8-plotina.99-dev.9', bytes }) });
  resetChannel('stable');
  fs.writeFileSync(appImagePath, '#!/bin/sh\necho running-image\n');
  state.version = '4.12.8-plotina.18';
  state.dialogResponse = 1;
  await updater.runCheck(true);
  assert.ok(requested.includes(API_URL), 'listed GitHub releases');
  assert.ok(requested.includes(rel.ymlUrl), 'read latest-lite-linux.yml');
  assert.ok(requested.includes(rel.artUrl), 'downloaded the AppImage asset');
  assert.ok(!requested.some((u) => u.includes('dev-latest') || u.includes('latest-linux-dev')), `no dev URL: ${requested}`);
  assert.strictEqual(statusFor('available').channel, 'stable');
  assert.strictEqual(statusFor('available').version, version);
  assert.strictEqual(statusFor('downloaded').channel, 'stable');
  assert.strictEqual(statusFor('downloaded').downgrade, false);
  assert.deepStrictEqual(appImageBytes(), bytes, 'AppImage swapped to the new bytes');
  assert.ok(!fs.existsSync(`${path.dirname(appImagePath)}/${aiName(version)}.plotina-new`), 'staging file consumed');
  assert.ok(!state.statuses.some((p) => p.state === 'error'), 'no error state');
});

await t('F2 dev channel reads the dev-latest direct URL and swaps in the dev build', async () => {
  const version = '4.12.8-plotina.19-dev.2';
  const bytes = artifactBytes('dev-19.2');
  const devYml = `${DEV_BASE}/latest-linux-dev.yml`;
  const devArt = `${DEV_BASE}/${aiName(version)}`;
  globalThis.fetch = serve({
    [devYml]: linuxYml({ version, bytes }),
    [devArt]: bytes,
    [API_URL]: 'SHOULD NOT BE CALLED',
    [`${DEV_BASE}/latest-linux.yml`]: 'SHOULD NOT BE CALLED',
  });
  switchTo('dev'); // drops F1's pending stable image
  fs.writeFileSync(appImagePath, '#!/bin/sh\necho stable-image\n');
  state.version = '4.12.8-plotina.18';
  await updater.runCheck(true);
  assert.deepStrictEqual(requested, [devYml, devArt], `dev feed by direct URL only: ${requested}`);
  assert.strictEqual(statusFor('available').channel, 'dev');
  assert.strictEqual(statusFor('downloaded').version, version);
  assert.strictEqual(statusFor('downloaded').channel, 'dev');
  assert.deepStrictEqual(appImageBytes(), bytes);
});

await t('F3 a dev build advertised on the stable feed is never offered', async () => {
  const version = '4.12.8-plotina.20-dev.1';
  const bytes = artifactBytes('dev-on-stable');
  const rel = ghRelease(version, bytes);
  globalThis.fetch = serve({ ...rel.routes });
  switchTo('stable');
  fs.writeFileSync(appImagePath, '#!/bin/sh\necho untouched\n');
  state.version = '4.12.8-plotina.18';
  await updater.runCheck(true);
  assert.ok(requested.includes(rel.ymlUrl), 'the metadata was inspected');
  assert.ok(!requested.includes(rel.artUrl), 'the artifact was NOT downloaded');
  assert.strictEqual(statusFor('up-to-date').plan, 'foreign');
  assert.strictEqual(statusFor('up-to-date').offered, version);
  assert.strictEqual(appImageBytes().toString(), '#!/bin/sh\necho untouched\n', 'install untouched');
  assert.ok(!state.statuses.some((p) => p.state === 'available'), 'nothing offered');
});

await t('F4 return-to-stable installs a lower stable version (explicit downgrade)', async () => {
  const stableVersion = '4.12.8-plotina.19';
  const bytes = artifactBytes('stable-19');
  const rel = ghRelease(stableVersion, bytes);
  const devYml = `${DEV_BASE}/latest-linux-dev.yml`;
  globalThis.fetch = serve({ ...rel.routes, [devYml]: linuxYml({ version: '4.12.8-plotina.19-dev.9', bytes }) });
  switchTo('dev');
  fs.writeFileSync(appImagePath, '#!/bin/sh\necho dev-image\n');
  state.version = '4.12.8-plotina.19-dev.4'; // dev of the same rev sorts HIGHER
  state.dialogResponse = 1; // 'Later' — restart is the user's choice
  const before = state.messages.length;
  const res = await updater.returnToStable({ manual: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.channel, 'stable');
  assert.strictEqual(policy.readChannel(profile, {}).channel, 'stable', 'preference pinned to stable');
  assert.ok(requested.includes(API_URL) && requested.includes(rel.ymlUrl) && requested.includes(rel.artUrl),
    `stable feed used: ${requested}`);
  assert.ok(!requested.some((u) => u.includes('dev-latest')), 'dev feed not read for the stable return');
  const dl = statusFor('downloaded');
  assert.strictEqual(dl.version, stableVersion);
  assert.strictEqual(dl.downgrade, true);
  assert.strictEqual(dl.channel, 'stable');
  assert.deepStrictEqual(appImageBytes(), bytes, 'older stable image IS the swap the user asked for');
  const prompt = state.messages[before];
  assert.ok(prompt, 'a prompt was shown');
  assert.match(prompt.message, /Вернуться на стабильный/);
  assert.match(prompt.detail, /понижение версии/);
  assert.match(prompt.detail, new RegExp(stableVersion));
  assert.match(prompt.detail, /4\.12\.8-plotina\.19-dev\.4/);
  assert.deepStrictEqual(prompt.buttons, policy.UI_TEXT.restartButtons);
  assert.strictEqual(statusFor('channel').channel, 'stable', 'UI told the channel changed');
});

await t('F5 an automatic check never downgrades a dev build to an older dev build', async () => {
  const version = '4.12.8-plotina.19-dev.3';
  const bytes = artifactBytes('dev-19.3');
  const devYml = `${DEV_BASE}/latest-linux-dev.yml`;
  const devArt = `${DEV_BASE}/${aiName(version)}`;
  globalThis.fetch = serve({ [devYml]: linuxYml({ version, bytes }), [devArt]: bytes });
  switchTo('dev');
  fs.writeFileSync(appImagePath, '#!/bin/sh\necho dev-image\n');
  state.version = '4.12.8-plotina.19-dev.4';
  await updater.runCheck(false);
  assert.deepStrictEqual(requested, [devYml], 'metadata read, nothing downloaded');
  assert.ok(!state.statuses.some((p) => p.state === 'available'), 'not offered automatically');
  assert.strictEqual(appImageBytes().toString(), '#!/bin/sh\necho dev-image\n');
});

await t('F6 preload IPC contract: get / set(needs confirmation) / return-to-stable', async () => {
  let seen = null;
  updater.onChannelChanged((c) => { seen = c; });
  resetChannel('stable'); // F5 left the dev preference in place
  for (const name of ['plotina:install-kind', 'plotina:check-updates', 'plotina:install-update',
                      'plotina:update-channel-get', 'plotina:update-channel-set', 'plotina:update-return-stable']) {
    assert.strictEqual(typeof state.handlers[name], 'function', `handler ${name}`);
  }
  const st = await state.handlers['plotina:update-channel-get']();
  assert.strictEqual(st.installKind, 'appimage');
  assert.strictEqual(st.selfUpdate, true);
  assert.strictEqual(st.channel, 'stable');
  assert.strictEqual(st.metadataFile, 'latest-lite-linux.yml');
  assert.strictEqual(st.devFeedUrl, `${DEV_BASE}/latest-linux-dev.yml`);
  assert.strictEqual(st.currentVersion, '4.12.8-plotina.19-dev.4');
  assert.strictEqual(st.text.channelEntry('dev'), 'Канал обновлений: Dev');

  const unconfirmed = await state.handlers['plotina:update-channel-set'](null, { channel: 'dev' });
  assert.strictEqual(unconfirmed.ok, false);
  assert.strictEqual(unconfirmed.needsConfirmation, true);
  assert.strictEqual(policy.readChannel(profile, {}).channel, 'stable', 'unacknowledged dev is not stored');

  const confirmed = await state.handlers['plotina:update-channel-set'](null, { channel: 'dev', acknowledged: true });
  assert.strictEqual(confirmed.ok, true);
  assert.strictEqual(confirmed.state.channel, 'dev');
  assert.strictEqual(confirmed.state.metadataFile, 'latest-linux-dev.yml');
  assert.strictEqual(seen, 'dev', 'menu listener notified');
  assert.ok(statusFor('channel'), 'renderer told');

  const bogus = await state.handlers['plotina:update-channel-set'](null, { channel: 'nightly' });
  assert.strictEqual(bogus.ok, false);
  assert.match(bogus.error, /unknown channel/);

  await state.handlers['plotina:update-channel-set'](null, { channel: 'stable' });
  assert.strictEqual(policy.readChannel(profile, {}).channel, 'stable');
});

await t('F7 dev metadata parsing keeps the AppImage-first rule and stable fallback', () => {
  const { parseLatestYml } = updater._internals;
  const bytes = artifactBytes('dev');
  const y = parseLatestYml(linuxYml({ version: '4.12.8-plotina.20-dev.1', bytes }), { requireAppImage: true });
  assert.strictEqual(y.fileName, aiName('4.12.8-plotina.20-dev.1'), 'deb listed first is skipped');
  assert.strictEqual(y.sha512, sha512b64(bytes), "the AppImage's own sha512, not the deb's");
  assert.strictEqual(y.size, bytes.length);
  assert.strictEqual(y.version, '4.12.8-plotina.20-dev.1');
  // flat/no-files dev feed (single-asset release) still parses
  const flat = `version: 4.12.8-plotina.21-dev.1\npath: ${aiName('4.12.8-plotina.21-dev.1')}\nsha512: ${sha512b64(bytes)}\n`;
  assert.strictEqual(parseLatestYml(flat, { requireAppImage: true }).fileName, aiName('4.12.8-plotina.21-dev.1'));
  // a dev feed without an AppImage entry is a feed bug, never a deb swap
  assert.throws(() => parseLatestYml('version: 1\nfiles:\n  - url: a.deb\n    sha512: X\n', { requireAppImage: true }));
});

await t('F8 stable feed coordinates fall back to plotina-cc/clients without app-update.yml', () => {
  const { readUpdateFeed } = updater._internals;
  const saved = readUpdateFeed();
  assert.strictEqual(saved.owner, 'plotina-cc');
  assert.strictEqual(saved.source, path.join(resources, 'app-update.yml'));
  fs.rmSync(path.join(resources, 'app-update.yml'));
  const fallback = readUpdateFeed();
  assert.deepStrictEqual([fallback.owner, fallback.repo, fallback.source], ['plotina-cc', 'clients', 'builtin']);
  fs.writeFileSync(path.join(resources, 'app-update.yml'),
    'provider: github\nowner: plotina-cc\nrepo: clients\nreleaseType: release\n');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${n} updater channel flow tests passed`);
