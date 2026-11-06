// stage-release-assets.mjs — stable aliases + SHA256SUMS for a built dist/.
//
// Layout follows the /dl contract (migration plan §7.5): versioned assets stay
// in dist/, the stable-name copies (what install scripts and plotina.cc/dl
// link to) are written to dist/stable/. Runs after electron-builder; refuses
// to invent files that are missing.
//
//   node scripts/stage-release-assets.mjs <APP_VERSION>
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = path.resolve(import.meta.dirname, '..');
const DIST = path.join(HERE, 'dist');
const OUT = path.join(DIST, 'stable');
const version = process.argv[2];
if (!version || !fs.existsSync(DIST)) {
  console.error('usage: node scripts/stage-release-assets.mjs <version>   (dist/ must exist)');
  process.exit(1);
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha512b64 = (p) => crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64');

// versioned artifact name shape: Plotina-Lite-Desktop-<ver>-<arch>.<ext>
const list = fs.readdirSync(DIST).filter((f) => f.startsWith('Plotina-Lite-Desktop-'));
const pick = (needle) => list.find((f) => f.endsWith(needle)) || null;

const kinds = {
  appimage: '.AppImage', deb: '.deb', rpm: '.rpm',
  setupExe: '.exe', msi: '.msi', blockmap: '.exe.blockmap',
};
// stable alias contract (task §7.1 naming): drop the version+arch.
const ALIASES = {
  appimage: 'Plotina-Lite-Desktop.AppImage',
  deb: 'Plotina-Lite-Desktop.deb',
  rpm: 'Plotina-Lite-Desktop.rpm',
  msi: 'Plotina-Lite-Desktop.msi',
};
// NSIS and MSI are both Windows files; alias -setup.exe for the NSIS one.
const found = {};
for (const [kind, suffix] of Object.entries(kinds)) {
  const f = pick(suffix);
  if (f) found[kind] = f;
}
// The NSIS exe is the .exe that is NOT the blockmap.
if (found.blockmap) {
  const exe = found.blockmap.replace(/\.blockmap$/, '');
  if (fs.existsSync(path.join(DIST, exe))) found.setupExe = exe;
}

fs.mkdirSync(OUT, { recursive: true });
const staged = [];
for (const [kind, file] of Object.entries(found)) {
  const alias = kind === 'setupExe' ? 'Plotina-Lite-Desktop-setup.exe' : ALIASES[kind];
  if (alias) {
    fs.copyFileSync(path.join(DIST, file), path.join(OUT, alias));
    staged.push({ kind, versioned: file, alias });
  } else {
    staged.push({ kind, versioned: file, alias: null });
  }
}
for (const meta of ['latest.yml', 'latest-linux.yml']) {
  if (fs.existsSync(path.join(DIST, meta))) {
    fs.copyFileSync(path.join(DIST, meta), path.join(OUT, meta));
    staged.push({ kind: meta, versioned: meta, alias: meta });
  }
}
const installScript = path.join(HERE, 'scripts', 'install-lite-electron.sh');
if (fs.existsSync(installScript)) {
  fs.copyFileSync(installScript, path.join(OUT, 'Plotina-Lite-Desktop-install.sh'));
  staged.push({ kind: 'installScript', versioned: 'scripts/install-lite-electron.sh', alias: 'Plotina-Lite-Desktop-install.sh' });
}

// SHA256SUMS over every release asset (versioned names; stable copies are
// byte-identical, /dl verification uses these).
const sumLines = [];
for (const f of list.filter((f) => !fs.statSync(path.join(DIST, f)).isDirectory())) {
  sumLines.push(`${sha256(path.join(DIST, f))}  ${f}`);
}
fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), sumLines.join('\n') + '\n');

// electron-updater metadata: electron-builder already emits latest*.yml when
// it can; if a target built but its yml is missing, synthesize the exact
// electron-builder schema (sha512 base64 + size) so the feed contract holds.
function ensureYml(ymlName, suffix, { blockmap } = {}) {
  const target = path.join(DIST, ymlName);
  if (fs.existsSync(target)) return 'from electron-builder';
  const file = pick(suffix);
  if (!file) return 'skipped (no artifact)';
  const stat = fs.statSync(path.join(DIST, file));
  const entry = { url: file, sha512: sha512b64(path.join(DIST, file)), size: stat.size };
  if (blockmap && found.blockmap) entry.blockMapSize = fs.statSync(path.join(DIST, found.blockmap)).size;
  const lines = [
    `version: ${version}`,
    'files:',
    `  - url: ${entry.url}`,
    `    sha512: ${entry.sha512}`,
    `    size: ${entry.size}`,
    ...(entry.blockMapSize ? [`    blockMapSize: ${entry.blockMapSize}`] : []),
    `path: ${entry.url}`,
    `sha512: ${entry.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ];
  fs.writeFileSync(target, lines.join('\n'));
  return 'synthesized (fallback; schema = electron-builder)';
}
const ymlStatus = {
  'latest-linux.yml': ensureYml('latest-linux.yml', '.AppImage'),
  'latest.yml': ensureYml('latest.yml', '-x64.exe', { blockmap: true }),
};
for (const meta of Object.keys(ymlStatus)) {
  if (fs.existsSync(path.join(DIST, meta))) fs.copyFileSync(path.join(DIST, meta), path.join(OUT, meta));
}

const report = { version, staged, ymlStatus };
fs.writeFileSync(path.join(OUT, 'staging-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
