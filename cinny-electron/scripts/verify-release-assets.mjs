#!/usr/bin/env node
// verify-release-assets.mjs — gate between the Electron build jobs and the
// GitHub release (Phase 4). One job builds Linux artifacts, another builds
// Windows; this script proves they belong to the SAME release before anything
// is uploaded:
//
//   * every versioned artifact matches the tag-derived APP_VERSION in its
//     filename (no stale downloads from an older run can slip in);
//   * latest.yml / latest-linux.yml carry version == APP_VERSION and every
//     file they reference exists with the recorded sha512/size (this is the
//     exact feed src/updater.js parses — a mismatch there bricks auto-update
//     for every installed base at once);
//   * per-platform SHA256SUMS verify against the real bytes;
//   * stable aliases in stable/ are byte-identical to their versioned twin.
//
// On success it assembles a FLAT release-assets/ directory (GitHub release
// assets have no subdirectories; the two platform builds both ship a
// stable/SHA256SUMS, so a naive `files: **` upload would collide) and writes
// one combined SHA256SUMS covering exactly what gets uploaded.
//
//   node scripts/verify-release-assets.mjs \
//     --linux pkg-linux --windows pkg-windows \
//     --version 4.12.8-plotina.18 --out release-assets
//
// Collects ALL failures before exiting 1 so one CI run shows every problem.
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return argv[i + 1];
};
const LINUX_DIR = path.resolve(arg('linux'));
const WIN_DIR = path.resolve(arg('windows'));
const VERSION = arg('version');
const OUT_DIR = path.resolve(arg('out'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+-plotina\.[0-9]+$/.test(VERSION)) {
  console.error(`FATAL: --version '${VERSION}' is not <semver>-plotina.<rev> (tag contract §7.1)`);
  process.exit(2);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha512b64 = (p) => crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64');

const failures = [];
const fail = (m) => { failures.push(m); };
const rootFiles = (dir) => {
  if (!fs.existsSync(dir)) { fail(`directory missing: ${dir}`); return []; }
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
};

// Versioned artifact name: Plotina-Lite-Desktop-<APP_VERSION>-<arch>.<ext>
const namePattern = (ext) =>
  new RegExp(`^Plotina-Lite-Desktop-${esc(VERSION)}-[A-Za-z0-9_]+\\.${esc(ext)}$`);

// One required artifact per platform, exact filename contract, no doubles.
const SPEC = [
  { dir: LINUX_DIR, tag: 'linux', ext: 'AppImage' },
  { dir: LINUX_DIR, tag: 'linux', ext: 'deb' },
  { dir: LINUX_DIR, tag: 'linux', ext: 'rpm' },
  { dir: WIN_DIR, tag: 'windows', ext: 'exe' },        // NSIS setup
  { dir: WIN_DIR, tag: 'windows', ext: 'exe.blockmap' },
  { dir: WIN_DIR, tag: 'windows', ext: 'msi' },
];
const picked = [];   // {dir, file} entries to upload
for (const s of SPEC) {
  const files = rootFiles(s.dir).filter((f) => namePattern(s.ext).test(f));
  if (files.length === 0) {
    fail(`${s.tag}: no ${s.ext} named Plotina-Lite-Desktop-${VERSION}-<arch>.${s.ext} in ${s.dir}`);
  } else if (files.length > 1) {
    fail(`${s.tag}: ambiguous duplicate ${s.ext} artifacts: ${files.join(', ')}`);
  } else {
    picked.push({ dir: s.dir, file: files[0], ext: s.ext, tag: s.tag });
  }
}
// The NSIS exe must not be shadowed by its own blockmap (both end .exe*);
// namePattern('exe') already excludes '.exe.blockmap' via the $ anchor.

// ---- updater metadata --------------------------------------------------------
// Mirror of src/updater.js parseLatestYml: `files:` entries + top-level path.
function parseYml(text) {
  const grab = (re) => { const m = re.exec(text); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  const version = grab(/^version:\s*(.+)$/m);
  const entries = [];
  for (const b of text.split(/\n(?=\s*-\s*url:)/).filter((x) => /^\s*-\s*url:/.test(x))) {
    const u = /url:\s*(.+)$/m.exec(b);
    const s = /^ {2,}sha512:\s*(.+)$/m.exec(b);
    const z = /^ {2,}size:\s*(\d+)/m.exec(b);
    const bm = /^ {2,}blockMapSize:\s*(\d+)/m.exec(b);
    if (u) entries.push({ url: u[1].trim().replace(/^["']|["']$/g, ''), sha512: s?.[1]?.trim(), size: z ? Number(z[1]) : null, blockMapSize: bm ? Number(bm[1]) : null });
  }
  return { version, entries, pathTop: grab(/^path:\s*(.+)$/m), sha512Top: grab(/^sha512:\s*(.+)$/m) };
}

function checkMetadata(dir, ymlName, { requireAppImage, platform }) {
  const p = path.join(dir, ymlName);
  if (!fs.existsSync(p)) { fail(`${platform}: ${ymlName} missing from ${dir}`); return; }
  const y = parseYml(fs.readFileSync(p, 'utf8'));
  if (y.version !== VERSION) fail(`${platform}: ${ymlName} version '${y.version}' != ${VERSION} (tag-derived)`);
  if (!y.entries.length && !(y.pathTop && y.sha512Top)) {
    fail(`${platform}: ${ymlName} lists no files entries and no top-level path/sha512`);
  }
  if (requireAppImage && !y.entries.some((e) => e.url.endsWith('.AppImage'))) {
    fail(`${platform}: ${ymlName} has no .AppImage entry — the AppImage updater will refuse this feed`);
  }
  for (const e of y.entries) {
    const f = path.join(dir, e.url);
    if (!fs.existsSync(f)) { fail(`${platform}: ${ymlName} references ${e.url}, not present in ${dir}`); continue; }
    if (!e.sha512) { fail(`${platform}: ${ymlName} entry ${e.url} has no sha512`); continue; }
    if (sha512b64(f) !== e.sha512) fail(`${platform}: ${ymlName} sha512 mismatch for ${e.url}`);
    if (e.size !== null && fs.statSync(f).size !== e.size) fail(`${platform}: ${ymlName} size mismatch for ${e.url}`);
    if (e.blockMapSize !== null) {
      const bmp = path.join(dir, `${e.url}.blockmap`);
      if (!fs.existsSync(bmp)) fail(`${platform}: ${ymlName} advertises blockMapSize but ${e.url}.blockmap is absent`);
      else if (fs.statSync(bmp).size !== e.blockMapSize) fail(`${platform}: ${ymlName} blockMapSize != actual ${e.url}.blockmap size`);
    }
  }
  if (y.pathTop && !y.entries.length) {
    const f = path.join(dir, y.pathTop);
    if (!fs.existsSync(f)) fail(`${platform}: ${ymlName} path ${y.pathTop} not present`);
    else if (y.sha512Top && sha512b64(f) !== y.sha512Top) fail(`${platform}: ${ymlName} top-level sha512 mismatch for ${y.pathTop}`);
  }
  // Keep the generic parent file only as the build-time source; the release
  // upload must carry the Lite-scoped name and nothing a Desktop build scans.
  picked.push({ dir, file: ymlName, dest: platform === 'linux' ? 'latest-lite-linux.yml' : 'latest-lite.yml', tag: platform });
}
checkMetadata(LINUX_DIR, 'latest-linux.yml', { requireAppImage: true, platform: 'linux' });
checkMetadata(WIN_DIR, 'latest.yml', { requireAppImage: false, platform: 'windows' });

// ---- per-platform SHA256SUMS -------------------------------------------------
function checkSums(dir, platform) {
  const p = path.join(dir, 'stable', 'SHA256SUMS');
  if (!fs.existsSync(p)) { fail(`${platform}: stable/SHA256SUMS missing (build-packages.sh stage step did not run?)`); return; }
  const listed = new Set();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    if (!m) { fail(`${platform}: malformed SHA256SUMS line: ${line}`); continue; }
    const [, hash, name] = m;
    listed.add(name);
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) fail(`${platform}: SHA256SUMS lists ${name}, absent from ${dir}`);
    else if (sha256(f) !== hash) fail(`${platform}: SHA256SUMS digest wrong for ${name}`);
  }
  for (const f of rootFiles(dir)) {
    if (f.startsWith('Plotina-Lite-Desktop-') && !listed.has(f)) {
      fail(`${platform}: ${f} exists but is not covered by stable/SHA256SUMS`);
    }
  }
}
checkSums(LINUX_DIR, 'linux');
checkSums(WIN_DIR, 'windows');

// ---- stable aliases -----------------------------------------------------------
const ALIAS_OF = {
  'AppImage': 'Plotina-Lite-Desktop.AppImage',
  'deb': 'Plotina-Lite-Desktop.deb',
  'rpm': 'Plotina-Lite-Desktop.rpm',
  'exe': 'Plotina-Lite-Desktop-setup.exe',
  'msi': 'Plotina-Lite-Desktop.msi',
};
for (const s of SPEC) {
  const alias = ALIAS_OF[s.ext];
  if (!alias) continue;  // the blockmap is an update asset, not a downloadable alias
  const entry = picked.find((c) => c.dir === s.dir && c.ext === s.ext);
  if (!entry) continue;
  const ap = path.join(s.dir, 'stable', alias);
  if (!fs.existsSync(ap)) { fail(`${s.tag}: stable alias ${alias} missing`); continue; }
  if (sha256(ap) !== sha256(path.join(s.dir, entry.file))) {
    fail(`${s.tag}: stable alias ${alias} is not byte-identical to ${entry.file}`);
  }
  picked.push({ dir: s.dir, file: `stable/${alias}`, dest: alias, tag: s.tag });
}

if (failures.length) {
  console.error(`RELEASE ASSET VERIFICATION FAILED (${failures.length} problem(s)):`);
  for (const m of failures) console.error(`  - ${m}`);
  process.exit(1);
}

// ---- assemble the flat upload directory --------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true });
const seen = new Map();
for (const c of picked) {
  const dest = c.dest || c.file;
  if (seen.has(dest)) { fail(`collision: ${dest} from ${seen.get(dest)} and ${c.dir}`); continue; }
  seen.set(dest, c.dir);
  fs.copyFileSync(path.join(c.dir, c.file), path.join(OUT_DIR, dest));
}
if (failures.length) {
  console.error('ABORT before writing SHA256SUMS:');
  for (const m of failures) console.error(`  - ${m}`);
  process.exit(1);
}
const uploaded = fs.readdirSync(OUT_DIR).sort();
const sumLines = uploaded.filter((f) => f !== 'SHA256SUMS').map((f) => `${sha256(path.join(OUT_DIR, f))}  ${f}`);
fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS'), sumLines.join('\n') + '\n');

const manifest = {
  version: VERSION,
  tag_contract: `v${VERSION.replace(/-plotina\./, '-plotina-lite-desktop.')}`,
  assets: uploaded.map((f) => ({
    name: f,
    bytes: fs.statSync(path.join(OUT_DIR, f)).size,
    sha256: f === 'SHA256SUMS' ? null : sha256(path.join(OUT_DIR, f)),
  })),
};
console.log(JSON.stringify(manifest, null, 2));
console.log(`OK: ${uploaded.length} release assets verified against ${VERSION} in ${OUT_DIR}`);
