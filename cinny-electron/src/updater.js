// Plotina Lite Desktop updater (Electron).
//
// Adapted from element-desktop/desktop/updater.ts (the proven reference:
// GitHub releases + electron-builder latest.yml/latest-linux.yml metadata +
// sha512 + AppImage atomic swap + NSIS silent `/S --updated`). Differences for
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
//
// SECURITY (same trade-off as Plotina Desktop): builds are unsigned (no
// Authenticode cert yet), so trust in an update = TLS to api.github.com +
// the sha512 published in latest*.yml. This stops corruption and casual
// tampering, not a compromised release. When a certificate is added,
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

const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // GitHub API: 60 req/h/IP
const INITIAL_UPDATE_DELAY_MS = process.env.PLOTINA_QA_UPDATES === '1' ? 1000 : 30 * 1000;
const MAX_METADATA_CHECKS = 5;
const WINDOWS_METADATA_FILE = 'latest.yml';
const LINUX_METADATA_FILE = 'latest-linux.yml';
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
const SELF_UPDATE_KINDS = new Set(['appimage', 'nsis']);

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
function readUpdateFeed() {
  if (!process.resourcesPath) return null; // unpackaged dev run
  const ymlPath = path.join(process.resourcesPath, 'app-update.yml');
  let text;
  try { text = fsSync.readFileSync(ymlPath, 'utf8'); } catch { return null; }
  const field = (name) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(name + ':'));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  };
  if (field('provider') !== 'github') return null;
  const owner = field('owner');
  const repo = field('repo');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function qaFeedOverride() {
  if (process.env.PLOTINA_QA_UPDATES !== '1') return null;
  const base = process.env.PLOTINA_UPDATE_FEED_URL;
  if (!base) return null;
  return { local: true, base };
}

// ----------------------------------------------------------------- parsers
/** Numeric tokens of a version. STRICT shape: x.y.z-plotina.N — the tag
 *  contract (§7.1). Anything else (notably the mangled 4-segment form
 *  4.12.818 — the Element `.30` lesson) is NOT a candidate for update. */
const PLOTINA_VERSION = /^(\d+)\.(\d+)\.(\d+)-plotina\.(\d+)/;
function versionTokens(v) {
  const m = PLOTINA_VERSION.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

function isVersionNewer(candidate, current) {
  const a = versionTokens(candidate);
  const b = versionTokens(current);
  if (!a || !b) return false; // unparseable shape: never auto-apply
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * electron-builder's latest*.yml. Returns {version, fileName, sha512, size,
 * releaseDate, blockMapSize?}. For latest-linux.yml we MUST pick the
 * .AppImage entry from `files:` (never first-url: a deb first would break
 * the AppImage swap).
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
let pendingUpdate = null;   // { version, installerPath, releaseDate, updateURL, mode }

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

// --------------------------------------------------------------- download
async function downloadArtifact(url, dest, expectedSha512) {
  if (await matchesSha512(dest, expectedSha512)) {
    console.log(`[updater] reusing verified download ${dest}`);
    return;
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
  // the user where it is.
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
async function metadataUrlAndAssets(base) {
  // QA local feed: metadata + artifacts sit in one directory.
  const metaFile = INSTALL_KIND === 'appimage' ? LINUX_METADATA_FILE : WINDOWS_METADATA_FILE;
  const res = await fetch(`${base.replace(/\/$/, '')}/${metaFile}`, { headers: { 'User-Agent': `${USER_AGENT}/${app.getVersion()}` } });
  if (!res.ok) throw new Error(`feed responded HTTP ${res.status} for ${metaFile}`);
  const yml = parseLatestYml(await res.text(), { requireAppImage: INSTALL_KIND === 'appimage' });
  if (!yml) throw new Error(`feed ${metaFile} is not parseable`);
  if (!isVersionNewer(yml.version, app.getVersion())) return null;
  return { yml, assetUrl: new URL(encodeURI(yml.fileName), base.replace(/[^/]*$/, '')).toString() };
}

async function findGitHubUpdate(feed) {
  const metaFile = INSTALL_KIND === 'appimage' ? LINUX_METADATA_FILE : WINDOWS_METADATA_FILE;
  const res = await fetch(`https://api.github.com/repos/${feed.owner}/${feed.repo}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${USER_AGENT}/${app.getVersion()}` },
  });
  if (!res.ok) throw new Error(`GitHub releases responded HTTP ${res.status}`);
  const releases = await res.json();
  const candidates = releases
    .filter((r) => !r.draft && !r.prerelease && r.assets.some((a) => a.name === metaFile))
    .slice(0, MAX_METADATA_CHECKS);
  let best = null;
  for (const release of candidates) {
    const asset = release.assets.find((a) => a.name === metaFile);
    const ymlRes = await fetch(asset.browser_download_url, { headers: { 'User-Agent': `${USER_AGENT}/${app.getVersion()}` } });
    if (!ymlRes.ok) continue;
    let yml;
    try { yml = parseLatestYml(await ymlRes.text(), { requireAppImage: INSTALL_KIND === 'appimage' }); }
    catch (e) { console.warn('[updater]', e.message); continue; }
    if (!yml || !isVersionNewer(yml.version, app.getVersion())) continue;
    const artifact = release.assets.find((a) => a.name === yml.fileName);
    if (!artifact) continue;
    if (!best || isVersionNewer(yml.version, best.yml.version)) best = { yml, assetUrl: artifact.browser_download_url };
  }
  return best;
}

async function runCheck(manual) {
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

  if (pendingUpdate) { sendStatus({ state: 'downloaded', ...pendingUpdate }); return; }
  if (checking) return;
  checking = true;
  try {
    const qa = qaFeedOverride();
    const feed = qa ? { local: true } : readUpdateFeed();
    if (!feed) { if (manual) sendStatus({ state: 'no-feed' }); return; }

    const found = qa
      ? await metadataUrlAndAssets(qa.base)
      : await findGitHubUpdate(feed);
    if (!found) { if (manual) sendStatus({ state: 'up-to-date', version: app.getVersion() }); return; }
    const { yml, assetUrl } = found;
    sendStatus({ state: 'available', version: yml.version });

    if (INSTALL_KIND === 'appimage') {
      const currentPath = resolveCurrentAppImage();
      const dir = path.dirname(currentPath);
      const stagingDir = isDirWritable(dir) ? dir : path.join(app.getPath('userData'), 'plotina-updates');
      await fs.mkdir(stagingDir, { recursive: true });
      const staged = path.join(stagingDir, `${yml.fileName}.plotina-new`);
      await downloadArtifact(assetUrl, staged, yml.sha512);
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
      pendingUpdate = { version: yml.version, mode: 'appimage-restart', installerPath: currentPath };
    } else { // nsis
      const dir = path.join(app.getPath('userData'), 'plotina-updates');
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, yml.fileName);
      await downloadArtifact(assetUrl, dest, yml.sha512);
      pendingUpdate = { version: yml.version, mode: 'windows-installer', installerPath: dest };
    }
    sendStatus({ state: 'downloaded', version: yml.version, releaseDate: yml.releaseDate });
    const isRestart = pendingUpdate.mode === 'appimage-restart';
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'Plotina Lite Desktop',
      message: `Plotina Lite Desktop ${yml.version} is ready.`,
      detail: isRestart
        ? 'The new AppImage has been installed over the old one. Restart to run it. The image is checked against the sha512 published with the release; it is not code-signed.'
        : 'Restart to install the update. The installer is checked against the sha512 published with the release; it is not code-signed.',
      buttons: [isRestart ? 'Restart now' : 'Restart to update', 'Later'],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) installUpdate();
  } catch (e) {
    console.warn('[updater] check failed', e);
    sendStatus({ state: 'error', message: String(e && e.message || e) });
  } finally {
    checking = false;
  }
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
  // script uses it to skip first-run side effects).
  const child = spawnImpl(pendingUpdate.installerPath, ['/S', '--updated'], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('[updater] installer failed', e));
  child.unref();
}

// -------------------------------------------------------------------- api
function init(getStatusTarget) {
  statusTarget = getStatusTarget || (() => null);
  ipcMain.handle('plotina:install-kind', () => INSTALL_KIND);
  ipcMain.handle('plotina:check-updates', () => { void runCheck(true); return INSTALL_KIND; });
  ipcMain.handle('plotina:install-update', () => installUpdate());

  if (!SELF_UPDATE_KINDS.has(INSTALL_KIND)) {
    console.log(`[updater] install kind '${INSTALL_KIND}': no self-update polling (manual or package-manager path)`);
    return;
  }
  if (!app.isPackaged || process.env.LITE_NO_UPDATES === '1') {
    console.log('[updater] disabled (dev build or LITE_NO_UPDATES=1)');
    return;
  }
  if (!qaFeedOverride()) {
    const feed = readUpdateFeed();
    if (!feed) { console.warn(`[updater] no usable GitHub feed in ${path.join(process.resourcesPath, 'app-update.yml')}; updater off`); return; }
    console.log(`[updater] feed ${feed.owner}/${feed.repo} kind=${INSTALL_KIND} version=${app.getVersion()}`);
  } else {
    console.log('[updater] QA feed override active');
  }
  setTimeout(() => void runCheck(false), INITIAL_UPDATE_DELAY_MS);
  setInterval(() => void runCheck(false), UPDATE_POLL_INTERVAL_MS);
}

module.exports = {
  init, installUpdate, runCheck, detectInstallKind,
  // pure helpers, exported for unit tests (scripts/test-updater.mjs)
  _internals: { isVersionNewer, parseLatestYml, readUpdateFeed, versionTokens, PACKAGE_GUIDANCE, packageGuidance },
};
