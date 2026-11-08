// Plotina Lite Desktop updater (Electron).
//
// Adapted from element-desktop/desktop/updater.ts (the proven reference:
// electron-builder latest*.yml metadata + sha512 + size + AppImage atomic
// swap + NSIS silent `/S --updated`). Differences for
// Lite (per docs/LITE_ELECTRON_MIGRATION.md §7 and the Phase-2 decision):
//
//   * Install-kind detection lives here and is reported to the renderer over
//     IPC (preload: plotinaLite.updater). Kinds: appimage | nsis | package
//     (deb/rpm) | msi | dev | unknown. The Windows kind is decided by the
//     `install-kind` marker the NSIS customInstall macro writes next to the
//     binary (build/installer.nsh); a packaged Windows install WITHOUT the
//     marker is an MSI and gets the manual-download state (open
//     https://plotina.cc/dl/), never a broken download.
//   * latest-linux.yml may list several files; we select the .AppImage entry
//     explicitly and never "first url" (a deb first would swap a package onto
//     an AppImage).
//   * No Tauri cross-grade paths: `.17` never had a working updater, and the
//     installed base is negligible; updates are Electron -> Electron only.
//   * QA feed override: PLOTINA_QA_UPDATES=1 reads
//     PLOTINA_UPDATE_FEED_URL (a local http server hosting latest*.yml +
//     artifacts, same layout as a release). Production ignores both.
//   * Two update channels. src/update-channel.js owns the policy (URLs, the
//     version grammar, the downgrade rules, the persisted preference, the
//     strings); this module is the glue. 'stable' is the DIRECT edge feed:
//     one GET of https://plotina.cc/dl/latest-lite-linux.yml (AppImage) /
//     /dl/latest-lite.yml (NSIS) and the artifact from the stable alias
//     /dl/Plotina-Lite-Desktop.AppImage / /dl/Plotina-Lite-Desktop-setup.exe
//     — no api.github.com call anywhere on the stable path, no release
//     listing, no anonymous rate limit. 'dev' is opt-in and reads the fixed
//     `dev-latest` release by direct download URL — also no API call.
//     The preference lives in <userData>/update-channel.json and is switched
//     from the app/tray menu entry 'Канал обновлений: Стабильный / Dev' or by
//     the renderer through the preload contract. Two invariants:
//       - a `-dev.` build is never offered on the stable channel, even if the
//         stable feed is misconfigured and advertises one;
//       - a version reduction is never applied automatically — only through
//         returnToStable(), the explicit 'Вернуться на стабильный' action,
//         because a dev build of the same -plotina.N rev sorts HIGHER than
//         that stable release and so needs a downgrade to leave.
//
// SECURITY (same trade-off as Plotina Desktop): builds are unsigned (no
// Authenticode cert yet), so trust in an update = TLS to plotina.cc (our edge;
// /dl is mirrored from the GitHub release by infra scripts/pull-release.py) or
// to github.com for the dev feed, plus the sha512 AND size published in the
// latest*.yml metadata (dev feed included: same verification, same placement
// code). This stops corruption and casual tampering, not a compromised release
// or a compromised edge host. When a certificate is added,
// electron-builder writes `publisherName` into app-update.yml and this module
// should verify it via PowerShell Get-AuthenticodeSignature before install.
'use strict';

const { app, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const policy = require('./update-channel');

const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // our own edge: a check is one small GET; stay polite
const INITIAL_UPDATE_DELAY_MS = process.env.PLOTINA_QA_UPDATES === '1' ? 1000 : 30 * 1000;
const DOWNLOAD_PAGE = 'https://plotina.cc/dl/';
const USER_AGENT = 'Plotina-Lite-Desktop';

// ---------------------------------------------------------------- install kind
/**
 * @returns {'appimage'|'nsis'|'package'|'msi'|'dev'|'unknown'}
 */
function detectInstallKind() {
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') {
    // NSIS writes install-kind=nsis next to the exe (installer.nsh). Absence
    // means the MSI build (or a hand-copied tree): both must not self-update.
    try {
      const marker = fsSync.readFileSync(path.join(path.dirname(process.execPath), 'install-kind'), 'utf8').trim();
      if (marker === 'nsis') return 'nsis';
    } catch { /* no marker */ }
    return 'msi';
  }
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'appimage';
    const exe = (() => { try { return fsSync.realpathSync(process.execPath); } catch { return process.execPath; } })();
    if (exe.startsWith('/opt/') || exe.startsWith('/usr/')) return 'package';
    return 'unknown';
  }
  return 'unknown';
}

const INSTALL_KIND = detectInstallKind();
// Only these kinds can move their own bits; everything else is manual or
// package-manager owned.
const SELF_UPDATE_KINDS = policy.SELF_UPDATE_KINDS;

const PACKAGE_GUIDANCE = {
  deb: 'Plotina Lite Desktop (system package) is updated by the package manager: run `sudo apt update && sudo apt install plotina-lite-desktop`.',
  rpm: 'Plotina Lite Desktop (system package) is updated by the package manager: run `sudo dnf upgrade plotina-lite-desktop`.',
};
function packageGuidance() {
  // Pick the right wording by asking which db owns us; default to apt wording.
  try {
    if (fsSync.existsSync('/var/lib/rpm') || fsSync.existsSync('/usr/lib/sysimage/rpm')) return PACKAGE_GUIDANCE.rpm;
  } catch { /* ignore */ }
  return PACKAGE_GUIDANCE.deb;
}

// ------------------------------------------------------------------- feed
/** Stable feed coordinates. electron-builder writes resources/app-update.yml
 *  from the `publish` block. If it is absent or unusable we still know this
 *  product's own home (plotina-cc/clients, the same constants the dev feed
 *  uses), so a hand-assembled tree keeps updating instead of going silently
 *  dead — which source was used is logged at init(). */
function readUpdateFeed() {
  const builtin = { owner: policy.RELEASE_OWNER, repo: policy.RELEASE_REPO, source: 'builtin' };
  if (!process.resourcesPath) return builtin; // unpackaged dev run
  const ymlPath = path.join(process.resourcesPath, 'app-update.yml');
  let text;
  try { text = fsSync.readFileSync(ymlPath, 'utf8'); } catch { return builtin; }
  const field = (name) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(name + ':'));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  };
  if (field('provider') !== 'github') return builtin;
  const owner = field('owner') || builtin.owner;
  const repo = field('repo') || builtin.repo;
  return { owner, repo, source: ymlPath };
}

function qaFeedOverride() {
  if (process.env.PLOTINA_QA_UPDATES !== '1') return null;
  const base = process.env.PLOTINA_UPDATE_FEED_URL;
  if (!base) return null;
  return { local: true, base };
}

// ----------------------------------------------------------------- channel
const userDataDir = () => app.getPath('userData');

function currentChannelInfo() { return policy.readChannel(userDataDir(), process.env); }
function currentChannel() { return currentChannelInfo().channel; }

/** UI_TEXT projected onto structured-clone-safe values (strings and string
 *  arrays). The full UI_TEXT carries helper functions (channelEntry,
 *  downgradeDetail) which electron's IPC cannot serialize — DataCloneError —
 *  so over the bridge we ship the parts and the renderer composes the labels.
 *  Menu code in main.js keeps using UI_TEXT directly (same process). */
function uiTextForBridge() {
  const out = {};
  for (const [key, value] of Object.entries(policy.UI_TEXT)) {
    if (typeof value === 'string' || Array.isArray(value)) out[key] = value;
  }
  return out;
}
const BRIDGE_UI_TEXT = uiTextForBridge();

/** Everything the Settings entry needs to render itself (menu + renderer). */
function channelState() {
  const info = currentChannelInfo();
  const channelName = info.channel;
  return {
    channel: channelName,
    source: info.source, // file | env | default
    pinnedByEnv: info.source === 'env',
    devAcknowledgedAt: info.devAcknowledgedAt,
    installKind: INSTALL_KIND,
    selfUpdate: SELF_UPDATE_KINDS.has(INSTALL_KIND),
    currentVersion: app.getVersion(),
    metadataFile: policy.metadataFileFor({ installKind: INSTALL_KIND, channel: channelName }),
    devFeedUrl: policy.devFeedUrl({
      installKind: INSTALL_KIND,
      channel: policy.DEV,
      devFeedBase: policy.resolveDevFeedBase(process.env),
    }),
    text: BRIDGE_UI_TEXT,
  };
}

let channelListeners = [];
function onChannelChanged(fn) { if (typeof fn === 'function') channelListeners.push(fn); }
function notifyChannelChanged(channelName) {
  for (const fn of channelListeners) {
    try { fn(channelName); } catch (e) { console.warn('[updater] channel listener failed', e); }
  }
}

/** Switch channel. Dev requires an acknowledgement — the caller (menu or
 *  renderer) must have shown the warning first; an unacknowledged request
 *  changes nothing and reports that confirmation is required. */
function setChannel(nextChannel, { acknowledged = false, manual = true } = {}) {
  if (!policy.CHANNELS.includes(nextChannel)) {
    return { ok: false, error: `unknown channel: ${nextChannel}`, state: channelState() };
  }
  const result = policy.writeChannel(userDataDir(), nextChannel, {
    acknowledged: acknowledged || nextChannel === policy.STABLE,
  });
  if (!result.ok) {
    if (manual) sendStatus({ state: 'channel-confirmation-required', channel: currentChannel() });
    return { ...result, state: channelState() };
  }
  // A pending download came from the other channel's feed; dropping it is the
  // safe reading of "I changed my mind".
  if (pendingUpdate && pendingUpdate.channel !== nextChannel) {
    console.log(`[updater] dropping pending ${pendingUpdate.version} (${pendingUpdate.channel}) after channel change`);
    pendingUpdate = null;
  }
  console.log(`[updater] channel -> ${nextChannel}`);
  sendStatus({ state: 'channel', ...channelState() });
  notifyChannelChanged(nextChannel);
  return { ok: true, channel: nextChannel, state: channelState() };
}

// ----------------------------------------------------------------- parsers
/** Version grammar: [major,minor,patch,plotina,dev] — delegated to the policy
 *  module so the grammar exists in exactly one place. Unparseable shapes
 *  (notably the mangled four-segment 4.12.818, the Element `.30` lesson) are
 *  never candidates for update. */
const versionTokens = policy.versionTokens;
const isVersionNewer = policy.isVersionNewer;

/**
 * electron-builder's latest*.yml. Returns {version, fileName, sha512, size,
 * releaseDate, blockMapSize?}. For latest-linux.yml we MUST pick the
 * .AppImage entry from `files:` (never first-url: a deb first would break
 * the AppImage swap). Same parser for the dev metadata files, which are
 * produced by the same electron-builder run.
 */
function parseLatestYml(text, { requireAppImage } = {}) {
  const grab = (re) => { const m = re.exec(text); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  const version = grab(/^version:\s*(.+)$/m);
  const releaseDate = grab(/^releaseDate:\s*(.+)$/m);
  // files: list items are `- url:` blocks; split on items, then pull
  // url/sha512/size from each block.
  const entries = [];
  const blocks = text.split(/\n(?=\s*-\s*url:)/).filter((b) => /^\s*-\s*url:/.test(b));
  for (const b of blocks) {
    const u = /url:\s*(.+)$/m.exec(b);
    const s = /^ {2,}sha512:\s*(.+)$/m.exec(b);
    const z = /^ {2,}size:\s*(\d+)/m.exec(b);
    if (u) entries.push({ url: u[1].trim().replace(/^["']|["']$/g, ''), sha512: s && s[1].trim(), size: z && Number(z[1]) });
  }
  let picked = requireAppImage
    ? entries.find((e) => e.url.endsWith('.AppImage')) || null
    : entries[0] || null;
  if (requireAppImage && !picked && entries.length) {
    // The feed exists but names no AppImage (deb-only): a real feed bug,
    // never silently fall through to a package the AppImage cannot install.
    throw new Error(`latest-linux.yml has no .AppImage entry (files: ${entries.map((e) => e.url).join(', ')})`);
  }
  if (!picked) {
    // Older/flat format: top-level `path:` + top-level `sha512:`.
    const fileName = grab(/^path:\s*(.+)$/m);
    const sha512 = grab(/^sha512:\s*(.+)$/m);
    if (fileName && sha512) picked = { url: fileName, sha512 };
  } else if (!picked.sha512) {
    picked.sha512 = grab(/^sha512:\s*(.+)$/m);
  }
  if (!version || !picked || !picked.sha512) return null;
  if (requireAppImage && !picked.url.endsWith('.AppImage')) {
    throw new Error(`latest-linux.yml has no .AppImage entry (picked ${picked.url})`);
  }
  return { version, fileName: picked.url, sha512: picked.sha512, size: picked.size, releaseDate: releaseDate || '' };
}

// ------------------------------------------------------------------- status
let checking = false;
let pendingUpdate = null;   // { version, channel, plan, installerPath, releaseDate, mode }
let timers = [];            // polling handles, so tests can dispose()

let statusTarget = () => null; // () => webContents | null
function sendStatus(payload) {
  try {
    const wc = statusTarget();
    if (wc && !wc.isDestroyed()) wc.send('plotina:update-status', payload);
  } catch { /* window gone */ }
  console.log('[updater]', JSON.stringify(payload));
}

function matchesSha512(file, expected) {
  return fs.readFile(file)
    .then((data) => createHash('sha512').update(data).digest('base64') === expected)
    .catch(() => false);
}

/** Second, cheap gate next to the digest: the byte count the metadata claims.
 *  Absent/invalid sizes are skipped (older feeds), exactly like Desktop. */
async function matchesSize(file, expected) {
  if (expected === null || expected === undefined || !Number.isFinite(expected) || expected <= 0) return true;
  try {
    return (await fs.stat(file)).size === expected;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- download
async function downloadArtifact(url, dest, expectedSha512, expectedSize = null) {
  if (await matchesSha512(dest, expectedSha512)) {
    if (await matchesSize(dest, expectedSize)) {
      console.log(`[updater] reusing verified download ${dest}`);
      return;
    }
  }
  console.log(`[updater] downloading ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': `${USER_AGENT}/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = dest + '.part';
  await fs.rm(tmp, { force: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (!(await matchesSha512(tmp, expectedSha512))) {
    await fs.rm(tmp, { force: true }); // a corrupted artifact never survives
    throw new Error(`sha512 mismatch for ${path.basename(dest)}; refusing to install`);
  }
  if (!(await matchesSize(tmp, expectedSize))) {
    await fs.rm(tmp, { force: true }); // the digest matched a wrong-length stream: never install it
    throw new Error(`size mismatch for ${path.basename(dest)}; refusing to install`);
  }
  await fs.rm(dest, { force: true });
  await fs.rename(tmp, dest);
}

function isDirWritable(dir) {
  try { fsSync.accessSync(dir, fsSync.constants.W_OK | fsSync.constants.X_OK); return true; } catch { return false; }
}

function resolveCurrentAppImage() {
  const raw = process.env.APPIMAGE;
  try { return fsSync.realpathSync(raw); } catch { return raw; }
}

async function swapAppImage(stagedPath, currentPath) {
  // rename() within one directory is atomic; the running FUSE mount keeps the
  // old inode, the directory entry gets the new bytes (same as Plotina
  // Desktop). Fallbacks: copy+rename in-dir, then save-to-Downloads + tell
  // the user where it is. Works identically for a downgrade — the bytes are
  // simply older ones.
  try {
    await fs.rename(stagedPath, currentPath);
    await fs.chmod(currentPath, 0o755).catch(() => {});
    return { swapped: true };
  } catch (e) { console.warn('[updater] rename-over-AppImage failed', e); }
  try {
    const inDirTmp = currentPath + '.plotina-new';
    await fs.copyFile(stagedPath, inDirTmp);
    await fs.chmod(inDirTmp, 0o755);
    await fs.rename(inDirTmp, currentPath);
    await fs.rm(stagedPath, { force: true });
    return { swapped: true };
  } catch (e) { console.warn('[updater] copy-into-dir failed too', e); return { swapped: false, reason: String(e.message || e) }; }
}

// ------------------------------------------------------------------ checks
/** Attach the policy verdict to a parsed metadata document. */
function candidateFrom(yml, assetUrl, { channelName, allowDowngrade }) {
  const plan = policy.planUpdate({
    candidateVersion: yml.version,
    currentVersion: app.getVersion(),
    allowDowngrade,
    channel: channelName,
  });
  return { yml, assetUrl, plan, channel: channelName };
}

async function fetchMetadata(url, { requireAppImage }) {
  const name = path.basename(new URL(url).pathname);
  const res = await fetch(url, { headers: { 'User-Agent': `${USER_AGENT}/${app.getVersion()}` } });
  if (res.status === 404) return null; // feed not published yet: not an error
  if (!res.ok) throw new Error(`feed responded HTTP ${res.status} for ${name}`);
  const yml = parseLatestYml(await res.text(), { requireAppImage });
  if (!yml) throw new Error(`feed ${name} is not parseable`);
  return yml;
}

/** QA local feed: metadata + artifacts sit in one directory; the channel
 *  decides only which file name is fetched. */
async function metadataUrlAndAssets(base, { channelName, allowDowngrade }) {
  const url = policy.qaFeedUrl({ base, installKind: INSTALL_KIND, channel: channelName });
  if (!url) return null;
  const yml = await fetchMetadata(url, { requireAppImage: INSTALL_KIND === 'appimage' });
  if (!yml) return null;
  const assetUrl = new URL(encodeURI(yml.fileName), url.replace(/[^/]*$/, '')).toString();
  return candidateFrom(yml, assetUrl, { channelName, allowDowngrade });
}

/** Dev channel: the fixed `dev-latest` release read by direct download URL.
 *  Artifacts live next to the metadata in the same release, so the asset URL
 *  is resolved against it — the same layout as the QA feed. */
async function findDevUpdate({ allowDowngrade, devFeedBase }) {
  const url = policy.devFeedUrl({ installKind: INSTALL_KIND, channel: policy.DEV, devFeedBase });
  if (!url) return null;
  const yml = await fetchMetadata(url, { requireAppImage: INSTALL_KIND === 'appimage' });
  if (!yml) { console.log('[updater] dev feed not published yet (HTTP 404)'); return null; }
  if (!policy.isDevVersion(yml.version)) {
    // Installable for a dev-channel user (no rule against a stable-shaped
    // build), but it means the dev tag was repurposed — say so loudly.
    console.warn(`[updater] dev feed advertises a non-dev version ${yml.version}`);
  }
  const assetUrl = new URL(encodeURI(yml.fileName), url.replace(/[^/]*$/, '')).toString();
  return candidateFrom(yml, assetUrl, { channelName: policy.DEV, allowDowngrade });
}

/** Stable channel: ONE direct GET of the electron-builder metadata on our
 *  edge (policy.stableFeedUrl: /dl/latest-lite-linux.yml / /dl/latest-lite.yml
 *  — no api.github.com listing), plus the channel firewall (a stray `-dev.`
 *  build advertised there is refused) and the downgrade pass for the explicit
 *  return-to-stable. The artifact is the stable ALIAS on the same path — the
 *  versioned fileName in the metadata is never used to build a URL; the alias
 *  is byte-identical and its sha512+size are what the metadata certifies. */
async function findStableUpdate({ channelName = policy.STABLE, allowDowngrade = false } = {}) {
  const url = policy.stableFeedUrl({ installKind: INSTALL_KIND, channel: channelName });
  const assetUrl = policy.stableArtifactUrl({ installKind: INSTALL_KIND });
  if (!url || !assetUrl) return null;
  const yml = await fetchMetadata(url, { requireAppImage: INSTALL_KIND === 'appimage' });
  if (!yml) { console.log('[updater] stable feed not published yet (HTTP 404)'); return null; }
  if (!yml.fileName.startsWith('Plotina-Lite-Desktop')) {
    // Belt and braces: /dl is Lite-scoped by file name, but never accept
    // another product's artifact if the edge ever serves the wrong yml.
    throw new Error(`stable feed ${url} names ${yml.fileName}, which is not a Plotina Lite Desktop artifact`);
  }
  const cand = candidateFrom(yml, assetUrl, { channelName, allowDowngrade });
  if (cand.plan === 'foreign') {
    console.warn(`[updater] refusing ${yml.version} from the stable feed: a dev build is never offered on the stable channel`);
  }
  return cand;
}

/** Download + verify + place the artifact, then prompt for a restart. Shared
 *  by the upgrade path and the return-to-stable (downgrade) path, so both keep
 *  sha512 verification and the atomic AppImage swap / silent NSIS install. */
async function applyCandidate(found, { manual }) {
  const { yml, assetUrl, plan, channel: channelName } = found;
  const downgrade = plan === 'downgrade';
  sendStatus({ state: 'available', version: yml.version, channel: channelName, downgrade });

  if (INSTALL_KIND === 'appimage') {
    const currentPath = resolveCurrentAppImage();
    const dir = path.dirname(currentPath);
    const stagingDir = isDirWritable(dir) ? dir : path.join(app.getPath('userData'), 'plotina-updates');
    await fs.mkdir(stagingDir, { recursive: true });
    const staged = path.join(stagingDir, `${yml.fileName}.plotina-new`);
    await downloadArtifact(assetUrl, staged, yml.sha512, yml.size);
    const swap = await swapAppImage(staged, currentPath);
    if (!swap.swapped) {
      sendStatus({ state: 'error', message: `downloaded but could not replace ${currentPath} (${swap.reason}); the running AppImage is untouched` });
      await dialog.showMessageBox({
        type: 'warning', title: 'Plotina Lite Desktop',
        message: `Plotina Lite Desktop ${yml.version} was downloaded and verified but cannot replace the running AppImage.`,
        detail: `${swap.reason || ''}\nCopy ${staged} over ${currentPath} yourself, then restart.`,
        buttons: ['OK'], noLink: true,
      });
      return;
    }
    pendingUpdate = { version: yml.version, channel: channelName, plan, mode: 'appimage-restart', installerPath: currentPath };
  } else { // nsis
    const dir = path.join(app.getPath('userData'), 'plotina-updates');
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, yml.fileName);
    await downloadArtifact(assetUrl, dest, yml.sha512, yml.size);
    pendingUpdate = { version: yml.version, channel: channelName, plan, mode: 'windows-installer', installerPath: dest };
  }
  sendStatus({ state: 'downloaded', version: yml.version, channel: channelName, releaseDate: yml.releaseDate, downgrade });

  const T = policy.UI_TEXT;
  const isRestart = pendingUpdate.mode === 'appimage-restart';
  const detail = downgrade
    ? `${T.downgradeDetail(app.getVersion(), yml.version)}\n` +
      (isRestart ? 'Новый образ уже установлен поверх текущего — перезапустите приложение.'
        : 'Установщик будет запущен после перезапуска; установка выполняется автоматически (/S).')
    : (isRestart
      ? 'The new AppImage has been installed over the old one. Restart to run it. The image is checked against the sha512 published with the release; it is not code-signed.'
      : 'Restart to install the update. The installer is checked against the sha512 published with the release; it is not code-signed.');
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: downgrade ? T.returnToStableTitle : 'Plotina Lite Desktop',
    message: downgrade ? `${T.returnToStable}: ${yml.version}` : `Plotina Lite Desktop ${yml.version} is ready.`,
    detail,
    buttons: downgrade ? T.restartButtons : [isRestart ? 'Restart now' : 'Restart to update', 'Later'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 0) installUpdate();
}

async function runCheck(manual = false, opts = {}) {
  if (INSTALL_KIND === 'dev' || process.env.LITE_NO_UPDATES === '1') {
    if (manual) sendStatus({ state: 'not-packaged' });
    return;
  }
  if (!SELF_UPDATE_KINDS.has(INSTALL_KIND)) {
    // package (deb/rpm), msi, unknown: manual-download / package-manager state.
    const detail = INSTALL_KIND === 'package'
      ? packageGuidance()
      : INSTALL_KIND === 'msi'
        ? 'Automatic updates are not available for the MSI install. Download the latest installer and run it yourself.'
        : 'Automatic updates are not available for this install type. Use ' + DOWNLOAD_PAGE;
    sendStatus({ state: 'manual-required', installKind: INSTALL_KIND, message: detail, downloadPage: DOWNLOAD_PAGE });
    if (manual) {
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'Plotina Lite Desktop',
        message: 'Updates are installed manually for this kind of installation.',
        detail, buttons: ['Open download page', 'OK'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (response === 0) shell.openExternal(DOWNLOAD_PAGE).catch(() => {});
    }
    return;
  }

  const channelName = opts.channelName || currentChannel();
  const allowDowngrade = !!opts.allowDowngrade;
  if (pendingUpdate && !allowDowngrade) { sendStatus({ state: 'downloaded', ...pendingUpdate }); return; }
  if (checking) return;
  checking = true;
  try {
    const qa = qaFeedOverride();
    const feed = readUpdateFeed();
    if (!feed) { if (manual) sendStatus({ state: 'no-feed' }); return; }

    let found;
    if (qa) found = await metadataUrlAndAssets(qa.base, { channelName, allowDowngrade });
    else if (channelName === policy.DEV) found = await findDevUpdate({ allowDowngrade, devFeedBase: policy.resolveDevFeedBase(process.env) });
    else found = await findStableUpdate({ channelName: policy.STABLE, allowDowngrade });

    if (!found) {
      if (manual) sendStatus({ state: 'up-to-date', version: app.getVersion(), channel: channelName });
      return;
    }
    if (found.plan !== 'apply' && found.plan !== 'downgrade') {
      // 'same' | 'blocked' | 'invalid' | 'foreign': stay exactly where we are.
      if (found.plan === 'blocked') {
        console.log(`[updater] ${channelName} feed offers ${found.yml.version}, older than running ${app.getVersion()}; not applied (use '${policy.UI_TEXT.returnToStable}')`);
      }
      if (found.plan === 'foreign' || found.plan === 'invalid') {
        console.warn(`[updater] refusing ${found.yml && found.yml.version} on the ${channelName} channel (plan=${found.plan})`);
      }
      if (manual) sendStatus({ state: 'up-to-date', version: app.getVersion(), channel: channelName, offered: found.yml && found.yml.version, plan: found.plan });
      return;
    }
    await applyCandidate(found, { manual });
  } catch (e) {
    console.warn('[updater] check failed', e);
    sendStatus({ state: 'error', message: String(e && e.message || e), channel: channelName });
  } finally {
    checking = false;
  }
}

/** The explicit 'Вернуться на стабильный' action: pin the preference to stable
 *  and install the current stable build even when it is a REDUCTION from a dev
 *  build (plain comparison would refuse it). Verification and placement use
 *  the same code path as any other update. */
async function returnToStable({ manual = true } = {}) {
  const stored = policy.writeChannel(userDataDir(), policy.STABLE);
  if (!stored.ok) return { ok: false, ...stored };
  console.log(`[updater] ${policy.UI_TEXT.returnToStable}: channel pinned to stable`);
  sendStatus({ state: 'channel', ...channelState() });
  notifyChannelChanged(policy.STABLE);
  await runCheck(manual, { channelName: policy.STABLE, allowDowngrade: true });
  return { ok: true, channel: policy.STABLE, state: channelState() };
}

function installUpdate(spawnImpl = spawn) {
  if (!pendingUpdate) { console.log('[updater] nothing to install'); return; }
  app.quit();
  if (pendingUpdate.mode === 'appimage-restart') {
    // Swap already done; relaunch the same path (new inode) once we exit.
    const child = spawnImpl(pendingUpdate.installerPath, [], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error('[updater] restart failed', e));
    child.unref();
    return;
  }
  // /S silent NSIS; --updated marks an update run (electron-builder NSIS
  // script uses it to skip first-run side effects). A return-to-stable run is
  // the same silent install: NSIS replaces the payload either way.
  const child = spawnImpl(pendingUpdate.installerPath, ['/S', '--updated'], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('[updater] installer failed', e));
  child.unref();
}

// -------------------------------------------------------------------- api
function init(getStatusTarget, { onChannelChange } = {}) {
  statusTarget = getStatusTarget || (() => null);
  if (onChannelChange) onChannelChanged(onChannelChange);
  ipcMain.handle('plotina:install-kind', () => INSTALL_KIND);
  ipcMain.handle('plotina:check-updates', () => { void runCheck(true); return INSTALL_KIND; });
  ipcMain.handle('plotina:install-update', () => installUpdate());
  // Channel contract (the Settings entry is the app/tray menu today and the
  // web app's Settings later; both speak this through src/preload.js).
  ipcMain.handle('plotina:update-channel-get', () => channelState());
  ipcMain.handle('plotina:update-channel-set', (_e, args = {}) =>
    setChannel(args && args.channel, { acknowledged: !!(args && args.acknowledged), manual: !args || args.manual !== false }));
  ipcMain.handle('plotina:update-return-stable', () => returnToStable({ manual: true }));

  if (!SELF_UPDATE_KINDS.has(INSTALL_KIND)) {
    console.log(`[updater] install kind '${INSTALL_KIND}': no self-update polling (manual or package-manager path)`);
    return;
  }
  if (!app.isPackaged || process.env.LITE_NO_UPDATES === '1') {
    console.log('[updater] disabled (dev build or LITE_NO_UPDATES=1)');
    return;
  }
  const info = currentChannelInfo();
  if (qaFeedOverride()) {
    console.log(`[updater] QA feed override active (channel=${info.channel})`);
  } else {
    const feed = readUpdateFeed();
    const where = info.channel === policy.DEV
      ? policy.devFeedUrl({ installKind: INSTALL_KIND, channel: policy.DEV, devFeedBase: policy.resolveDevFeedBase(process.env) })
      : `${policy.stableFeedUrl({ installKind: INSTALL_KIND, channel: policy.STABLE })} (app-update.yml source: ${feed.source})`;
    console.log(`[updater] channel=${info.channel}(${info.source}) feed ${where} kind=${INSTALL_KIND} version=${app.getVersion()}`);
  }
  timers = [
    setTimeout(() => void runCheck(false), INITIAL_UPDATE_DELAY_MS),
    setInterval(() => void runCheck(false), UPDATE_POLL_INTERVAL_MS),
  ];
  // unref so a headless test run can exit; Electron's own loop is unaffected.
  for (const timer of timers) { if (typeof timer.unref === 'function') timer.unref(); }
}

function dispose() {
  for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
  timers = [];
  channelListeners = [];
}

module.exports = {
  init, dispose, installUpdate, runCheck, detectInstallKind,
  channelState, setChannel, returnToStable, onChannelChanged,
  // pure helpers, exported for unit tests (scripts/test-updater.mjs,
  // tests/updater-channel-flow.test.mjs)
  _internals: {
    isVersionNewer, parseLatestYml, readUpdateFeed, versionTokens,
    PACKAGE_GUIDANCE, packageGuidance, candidateFrom, fetchMetadata,
    INSTALL_KIND, policy,
  },
};
