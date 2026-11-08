// Plotina Lite Desktop — update channel policy (pure logic, no Electron).
//
// Two channels, one app:
//
//   stable  the shipping feed: the electron-builder metadata on OUR EDGE —
//           https://plotina.cc/dl/latest-lite-linux.yml (AppImage) and
//           https://plotina.cc/dl/latest-lite.yml (NSIS). One direct GET, no
//           api.github.com listing, no API quota. The artifact comes from the
//           stable alias on the same path (/dl/Plotina-Lite-Desktop.AppImage
//           / /dl/Plotina-Lite-Desktop-setup.exe); infra pull-release.py
//           mirrors both from the newest Lite release, so the metadata's
//           sha512+size describe exactly the bytes /dl serves.
//   dev     opt-in test feed on GitHub (NOT the edge host): one fixed release
//           tag `dev-latest` SHARED between products, whose assets are
//           re-uploaded on command, read by direct download URL — no release
//           listing, no API quota. Lite-scoped file names only (Desktop
//           publishes latest-dev.yml / latest-linux-dev.yml there):
//             …/releases/download/dev-latest/latest-lite-dev.yml        (NSIS)
//             …/releases/download/dev-latest/latest-lite-linux-dev.yml  (AppImage)
//
// Dev builds keep ordinary semver-shaped versions with a `-dev.<M>` tail
// (4.12.8-plotina.19-dev.2), so comparison is plain tuple ordering — no
// same-code workaround, no Android-style versionCode constraint. A dev build
// of the same `-plotina.N` rev compares HIGHER than that stable rev, which is
// why returning to stable must be an explicit, downgrade-allowed action.
//
// The two hard rules encoded here:
//   * a `-dev.` build is never a candidate on the stable channel (even if the
//     stable feed is misconfigured and advertises one), and
//   * a version reduction is never applied automatically; only the explicit
//     'Вернуться на стабильный' action sets allowDowngrade.
//
// Everything that decides (URLs, grammar, comparison, persistence, user-facing
// strings) lives here so src/updater.js stays glue and the rules are unit-
// testable in plain node (tests/dev-channel.test.mjs).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ channels
const STABLE = 'stable';
const DEV = 'dev';
const CHANNELS = [STABLE, DEV];
const DEFAULT_CHANNEL = STABLE;

const RELEASE_OWNER = 'plotina-cc';
const RELEASE_REPO = 'clients';
const DEV_RELEASE_TAG = 'dev-latest';
const DEV_FEED_BASE = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/${DEV_RELEASE_TAG}`;

// Product-scoped stable metadata. The repository hosts several clients;
// generic latest.yml/latest-linux.yml belong to Plotina Desktop, which older
// Desktop builds scan without a tag filter. Lite must never publish those
// names or an old Desktop can install a Lite release over itself. The same
// product-scoped names are mirrored to the edge /dl, which IS the stable
// feed now (see the header; DL_BASE + these file names).
const WINDOWS_METADATA_FILE = 'latest-lite.yml';
const LINUX_METADATA_FILE = 'latest-lite-linux.yml';
// Direct edge feed (infra scripts/pull-release.py mirrors the newest stable
// Lite release under exactly these names; the alias bytes are byte-identical
// to the versioned artifacts the metadata names).
const DL_BASE = 'https://plotina.cc/dl';
const WINDOWS_ARTIFACT_ALIAS = 'Plotina-Lite-Desktop-setup.exe';
const LINUX_ARTIFACT_ALIAS = 'Plotina-Lite-Desktop.AppImage';
// The dev release `dev-latest` is shared the same way: Desktop publishes its
// rolling latest-dev.yml / latest-linux-dev.yml there, so Lite reads (and its
// CI publishes) only the product-scoped dev names.
const DEV_WINDOWS_METADATA_FILE = 'latest-lite-dev.yml';
const DEV_LINUX_METADATA_FILE = 'latest-lite-linux-dev.yml';

// Only these install kinds can move their own bits (see src/updater.js).
const SELF_UPDATE_KINDS = new Set(['appimage', 'nsis']);

const isSelfUpdateKind = (kind) => SELF_UPDATE_KINDS.has(kind);

/** Which electron-builder metadata file this (kind, channel) pair reads.
 *  Returns null for kinds that never self-update (package/msi/unknown/dev). */
function metadataFileFor({ installKind, channel = DEFAULT_CHANNEL } = {}) {
  if (channel !== STABLE && channel !== DEV) return null;
  if (installKind === 'appimage') return channel === DEV ? DEV_LINUX_METADATA_FILE : LINUX_METADATA_FILE;
  if (installKind === 'nsis') return channel === DEV ? DEV_WINDOWS_METADATA_FILE : WINDOWS_METADATA_FILE;
  return null;
}

/** Direct download URL of the dev metadata, or null when the channel is not
 *  dev (the stable channel is read from the edge /dl feed instead — see
 *  stableFeedUrl; dev is the only path that still uses github.com, and only
 *  as a direct release asset, never the API). */
function devFeedUrl({ installKind, channel = DEFAULT_CHANNEL, devFeedBase = DEV_FEED_BASE } = {}) {
  if (channel !== DEV) return null;
  const file = metadataFileFor({ installKind, channel: DEV });
  if (!file) return null;
  return `${devFeedBase.replace(/\/$/, '')}/${file}`;
}

/**
 * Stable feed: direct metadata URL on the edge host for this install kind —
 * https://plotina.cc/dl/latest-lite-linux.yml (AppImage) or
 * https://plotina.cc/dl/latest-lite.yml (NSIS). null for kinds that never
 * self-update (package/msi/unknown/dev) and for the dev channel. dlBase is a
 * parameter so local-QA runs can point at a fixture server.
 */
function stableFeedUrl({ installKind, channel = DEFAULT_CHANNEL, dlBase = DL_BASE } = {}) {
  if (channel !== STABLE) return null;
  const file = metadataFileFor({ installKind, channel: STABLE });
  if (!file) return null;
  return `${dlBase.replace(/\/$/, '')}/${file}`;
}

/**
 * Stable artifact: the versionless alias on the same edge path. The metadata
 * names the VERSIONED file, but /dl serves byte-identical copies under these
 * fixed names, so this URL — not the metadata fileName — is what to download,
 * verified against the metadata's sha512+size.
 */
function stableArtifactUrl({ installKind, dlBase = DL_BASE } = {}) {
  if (installKind !== 'appimage' && installKind !== 'nsis') return null;
  const alias = installKind === 'appimage' ? LINUX_ARTIFACT_ALIAS : WINDOWS_ARTIFACT_ALIAS;
  return `${dlBase.replace(/\/$/, '')}/${alias}`;
}

/** QA/local feed override (PLOTINA_QA_UPDATES=1): metadata and artifacts sit
 *  in one directory, same layout as a release, so the channel decides only
 *  which file name is fetched. */
function qaFeedUrl({ base, installKind, channel = DEFAULT_CHANNEL } = {}) {
  const file = metadataFileFor({ installKind, channel });
  if (!base || !file) return null;
  return `${base.replace(/\/$/, '')}/${file}`;
}

/** Where the dev feed base comes from: env override for local QA kits,
 *  otherwise the GitHub `dev-latest` release. */
function resolveDevFeedBase(env = process.env) {
  return (env && env.LITE_DEV_FEED_URL) || DEV_FEED_BASE;
}

// ------------------------------------------------------------------ versions
// Accepted grammar (the tag contract, §7.1, plus the dev tail):
//   X.Y.Z-plotina.N              stable   -> tokens [X,Y,Z,N,0]
//   X.Y.Z-plotina.N-dev.M        dev      -> tokens [X,Y,Z,N,M]
//   X.Y.Z-plotina.N[.local]      branch/local build, dev token 0
// Anything else — notably the mangled four-segment form 4.12.818 (the Element
// `.30` lesson) — is not a version at all and is never applied.
// No build metadata (`+…`) is accepted: the contract is exact, a stray suffix
// means we do not know what we are looking at.
const PLOTINA_VERSION = /^(\d+)\.(\d+)\.(\d+)-plotina\.(\d+)(?:-dev\.(\d+))?(?:\.local)?$/;
const PLOTINA_DEV_VERSION = /^(\d+)\.(\d+)\.(\d+)-plotina\.(\d+)-dev\.(\d+)(?:\.local)?$/;

/** @returns {[number,number,number,number,number]|null} [major,minor,patch,plotina,dev] */
function versionTokens(v) {
  const m = PLOTINA_VERSION.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0)];
}

/** -1 | 0 | 1, or null when either side is not a Plotina version. */
function compareVersions(a, b) {
  const x = versionTokens(a);
  const y = versionTokens(b);
  if (!x || !y) return null;
  for (let i = 0; i < 5; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

const isVersionNewer = (candidate, current) => compareVersions(candidate, current) === 1;
const isVersionLower = (candidate, current) => compareVersions(candidate, current) === -1;

const isDevVersion = (v) => PLOTINA_DEV_VERSION.test(String(v == null ? '' : v).trim());
const channelOfVersion = (v) => (versionTokens(v) ? (isDevVersion(v) ? DEV : STABLE) : null);
const isStableVersion = (v) => channelOfVersion(v) === STABLE;

/** Highest version of a list of version strings (unparseable entries ignored). */
function pickHighestVersion(versions = []) {
  let best = null;
  for (const v of versions) {
    if (!versionTokens(v)) continue;
    if (best === null || compareVersions(v, best) === 1) best = v;
  }
  return best;
}

// ------------------------------------------------------------------ decisions
/** Channel firewall: a dev build may only ever be installed while the dev
 *  channel is on. On stable, only stable-shaped versions are candidates. */
function isCandidateAllowed({ candidateVersion, channel = DEFAULT_CHANNEL } = {}) {
  const shape = channelOfVersion(candidateVersion);
  if (!shape) return false;
  if (channel === DEV) return true;
  if (channel === STABLE) return shape === STABLE;
  return false;
}

/** What to do with a candidate against the running version.
 *  'apply'      newer, install it
 *  'downgrade'  older but allowed (only the explicit return-to-stable action)
 *  'blocked'    older and downgrade not allowed -> stay put
 *  'same'       equal -> stay put
 *  'invalid'    either side unparseable -> never touch the install
 *  'foreign'    candidate belongs to another channel (dev on stable) */
function planUpdate({ candidateVersion, currentVersion, allowDowngrade = false, channel = DEFAULT_CHANNEL } = {}) {
  if (!isCandidateAllowed({ candidateVersion, channel })) {
    return channelOfVersion(candidateVersion) && channel === STABLE ? 'foreign' : 'invalid';
  }
  const cmp = compareVersions(candidateVersion, currentVersion);
  if (cmp === null) return 'invalid';
  if (cmp > 0) return 'apply';
  if (cmp === 0) return 'same';
  return allowDowngrade ? 'downgrade' : 'blocked';
}

// --------------------------------------------------------------- persistence
const CHANNEL_FILE_NAME = 'update-channel.json';
// Escape hatch for QA/manual feed testing: same values as the menu.
const CHANNEL_ENV = 'LITE_UPDATE_CHANNEL';

function channelFilePath(userDataDir) {
  return path.join(userDataDir, CHANNEL_FILE_NAME);
}

/** Read the channel. Anything unreadable/invalid is the default (stable):
 *  a broken preference must never silently turn on the dev feed. */
function readChannel(userDataDir, env = process.env) {
  const fromEnv = env && env[CHANNEL_ENV];
  if (fromEnv && CHANNELS.includes(fromEnv)) {
    return { channel: fromEnv, source: 'env', devAcknowledgedAt: null };
  }
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(channelFilePath(userDataDir), 'utf8'));
  } catch { /* first run or damaged file -> default */ }
  if (data && CHANNELS.includes(data.channel)) {
    return { channel: data.channel, source: 'file', devAcknowledgedAt: data.devAcknowledgedAt || null };
  }
  return { channel: DEFAULT_CHANNEL, source: 'default', devAcknowledgedAt: null };
}

/** Write the channel (atomic: tmp + rename). Dev is only stored when the
 *  caller says the user acknowledged the warning. */
function writeChannel(userDataDir, nextChannel, { acknowledged = true, now = new Date() } = {}) {
  if (!CHANNELS.includes(nextChannel)) {
    throw new TypeError(`unknown update channel: ${nextChannel}`);
  }
  if (nextChannel === DEV && !acknowledged) {
    return { ok: false, needsConfirmation: true, channel: readChannel(userDataDir).channel };
  }
  const stamp = now.toISOString();
  const payload = {
    channel: nextChannel,
    devAcknowledgedAt: nextChannel === DEV ? stamp : null,
    updatedAt: stamp,
  };
  const file = channelFilePath(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { ok: true, ...payload };
}

// ------------------------------------------------------------------ user text
// One source of truth for the Settings/menu strings so tests can pin the
// contract and main.js, preload.js and dialogs cannot drift apart.
const UI_TEXT = {
  updatesMenu: 'Обновления',
  checkForUpdates: 'Проверить обновления…',
  channelLabel: 'Канал обновлений',
  stableLabel: 'Стабильный',
  devLabel: 'Dev',
  returnToStable: 'Вернуться на стабильный',
  devWarningTitle: 'Канал обновлений: Dev',
  devWarningMessage: 'Включить Dev-канал обновлений?',
  devWarningDetail:
    'Dev-канал получает тестовые сборки (вида 4.12.8-plotina.N-dev.M) с GitHub-релиза dev-latest. ' +
    'Они не проверяются так же строго, как стабильные, могут откатываться и меняться без предупреждения. ' +
    'Когда стабильный релиз с тем же номером выходит, он считается более старым, чем dev-сборка: ' +
    'возврат на стабильный выполняется отдельной командой и может установить версию ниже текущей.',
  devWarningButtons: ['Включить Dev-канал', 'Отмена'],
  channelChangedTitle: 'Канал обновлений изменён',
  returnToStableTitle: 'Возврат на стабильный канал',
  restartButtons: ['Перезапустить сейчас', 'Позже'],
  manualKindsNote: 'Для этого типа установки обновления управляются вручную или пакетным менеджером.',
  /** 'Канал обновлений: Стабильный' / 'Канал обновлений: Dev' */
  channelEntry(channel) {
    return `${UI_TEXT.channelLabel}: ${channel === DEV ? UI_TEXT.devLabel : UI_TEXT.stableLabel}`;
  },
  /** Version-reduction wording for the return-to-stable confirmation. */
  downgradeDetail(from, to) {
    return `Устанавливается стабильная версия ${to} вместо текущей ${from} — это понижение версии. ` +
      `Файл проверяется по sha512 из релиза; сборка не подписана.`;
  },
  upgradeDetail(from, to) {
    return `Обновление ${from} -> ${to}. Файл проверяется по sha512 из релиза; сборка не подписана.`;
  },
};

module.exports = {
  STABLE, DEV, CHANNELS, DEFAULT_CHANNEL, CHANNEL_FILE_NAME, CHANNEL_ENV,
  RELEASE_OWNER, RELEASE_REPO, DEV_RELEASE_TAG, DEV_FEED_BASE,
  DL_BASE, WINDOWS_ARTIFACT_ALIAS, LINUX_ARTIFACT_ALIAS,
  WINDOWS_METADATA_FILE, LINUX_METADATA_FILE, DEV_WINDOWS_METADATA_FILE, DEV_LINUX_METADATA_FILE,
  SELF_UPDATE_KINDS,
  isSelfUpdateKind, metadataFileFor, devFeedUrl, stableFeedUrl, stableArtifactUrl, qaFeedUrl, resolveDevFeedBase,
  versionTokens, compareVersions, isVersionNewer, isVersionLower,
  isDevVersion, isStableVersion, channelOfVersion, pickHighestVersion,
  isCandidateAllowed, planUpdate,
  channelFilePath, readChannel, writeChannel,
  UI_TEXT,
};
