// Updater unit tests (pure logic, no Electron runtime needed):
//   node scripts/test-updater.mjs
// Covers the feed-parsing contract from the migration plan §7.2 / U6 / U7:
// AppImage entry must be selected explicitly from latest-linux.yml (never
// first-url), version ordering across -plotina.N tags, sha512 fields, and
// rejection of garbage.
'use strict';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Stub the electron module BEFORE requiring updater.js.
const stub = {
  app: { isPackaged: false, getVersion: () => '4.12.8-plotina.18', getPath: () => '/tmp', quit: () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => {} },
  shell: { openExternal: async () => {} },
};
try {
  require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: stub };
} catch {
  // electron not installed (pure-logic run): register a fake module path.
  require.cache['electron'] = { id: 'electron', filename: 'electron', loaded: true, exports: stub };
}

const { _internals } = require('../src/updater.js');
const { isVersionNewer, parseLatestYml, versionTokens } = _internals;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('U7 version ordering', () => {
  assert.strictEqual(isVersionNewer('4.12.8-plotina.19', '4.12.8-plotina.18'), true);
  assert.strictEqual(isVersionNewer('4.12.8-plotina.17', '4.12.8-plotina.18'), false);
  assert.strictEqual(isVersionNewer('4.12.8-plotina.18', '4.12.8-plotina.18'), false);
  assert.strictEqual(isVersionNewer('4.13.0-plotina.1', '4.12.8-plotina.18'), true);
  assert.strictEqual(isVersionNewer('4.12.8-plotina.19', '4.12.8-plotina.0.local'), true);
  // The 4-segment mangle and any other shape are NEVER applied.
  assert.strictEqual(isVersionNewer('4.12.818', '4.12.8-plotina.18'), false, '4-segment mangle rejected');
  assert.strictEqual(isVersionNewer('4.12.8', '4.12.8-plotina.18'), false);
  assert.deepStrictEqual(versionTokens('4.12.8-plotina.19'), [4, 12, 8, 19]);
  assert.strictEqual(versionTokens('4.12.818'), null);
});

const LINUX_YML = `version: 4.12.8-plotina.19
files:
  - url: Plotina-Lite-Desktop-4.12.8-plotina.19-amd64.deb
    sha512: DEBSHA
    size: 99999
  - url: Plotina-Lite-Desktop-4.12.8-plotina.19-x86_64.AppImage
    sha512: AISHA
    size: 88888
path: Plotina-Lite-Desktop-4.12.8-plotina.19-amd64.deb
sha512: DEBSHA
releaseDate: '2026-11-07T10:00:00.000Z'
`;

t('U6 AppImage chosen even when deb is first', () => {
  const y = parseLatestYml(LINUX_YML, { requireAppImage: true });
  assert.strictEqual(y.fileName, 'Plotina-Lite-Desktop-4.12.8-plotina.19-x86_64.AppImage');
  assert.strictEqual(y.sha512, 'AISHA', 'per-file sha512, not the top-level deb sha');
  assert.strictEqual(y.size, 88888);
  assert.strictEqual(y.version, '4.12.8-plotina.19');
});

t('windows latest.yml first entry + blockMapSize tolerant', () => {
  const y = parseLatestYml(`version: 4.12.8-plotina.19
files:
  - url: Plotina-Lite-Desktop-4.12.8-plotina.19-x64.exe
    sha512: EXE
    blockMapSize: 4242
    size: 999
path: Plotina-Lite-Desktop-4.12.8-plotina.19-x64.exe
sha512: EXE
releaseDate: '2026-11-07T10:00:00.000Z'
`, { requireAppImage: false });
  assert.strictEqual(y.fileName, 'Plotina-Lite-Desktop-4.12.8-plotina.19-x64.exe');
  assert.strictEqual(y.sha512, 'EXE');
});

t('garbage yml rejected', () => {
  assert.strictEqual(parseLatestYml('hello: world', { requireAppImage: true }), null);
  // No AppImage entry at all must throw, not silently pick the deb.
  assert.throws(() => parseLatestYml(`version: 1\nfiles:\n  - url: a.deb\n    sha512: X\n`, { requireAppImage: true }));
});

console.log(`\n${n} updater unit tests passed`);
