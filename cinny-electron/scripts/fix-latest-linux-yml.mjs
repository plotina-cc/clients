// Normalize dist/latest-linux.yml for the Electron updater.
//
// electron-builder can rewrite latest-linux.yml per target (deb/rpm vs
// AppImage), and a CI run with rpmbuild present produced a feed without the
// AppImage entry — which our updater rejects. Rebuild the feed from the
// artifacts that actually exist, keeping the version and releaseDate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = path.resolve(import.meta.dirname, '..');
const DIST = path.join(HERE, 'dist');
const ymlPath = path.join(DIST, 'latest-linux.yml');
if (!fs.existsSync(ymlPath)) process.exit(0);

const text = fs.readFileSync(ymlPath, 'utf8');
const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
const releaseDate = /^releaseDate:\s*(.+)$/m.exec(text)?.[1]?.trim();
if (!version) {
  console.error('latest-linux.yml: no version');
  process.exit(1);
}

const files = fs.readdirSync(DIST).filter((f) => f.startsWith('Plotina-Lite-Desktop-'));
const appimage = files.find((f) => f.endsWith('.AppImage'));
if (!appimage) {
  console.error('latest-linux.yml: no AppImage in dist — cannot build a valid feed');
  process.exit(1);
}
const entries = [appimage];
const deb = files.find((f) => f.endsWith('.deb'));
if (deb) entries.push(deb);

const sha512 = (f) => crypto.createHash('sha512').update(fs.readFileSync(path.join(DIST, f))).digest('base64');
const lines = [`version: ${version}`, 'files:'];
for (const f of entries) {
  const blockmap = path.join(DIST, `${f}.blockmap`);
  lines.push(`  - url: ${f}`);
  lines.push(`    sha512: ${sha512(f)}`);
  lines.push(`    size: ${fs.statSync(path.join(DIST, f)).size}`);
  if (fs.existsSync(blockmap)) lines.push(`    blockMapSize: ${fs.statSync(blockmap).size}`);
}
lines.push(`path: ${appimage}`);
lines.push(`sha512: ${sha512(appimage)}`);
if (releaseDate) lines.push(`releaseDate: ${releaseDate}`);
fs.writeFileSync(ymlPath, `${lines.join('\n')}\n`);
console.log(`latest-linux.yml: ${entries.length} entries, AppImage ${appimage}`);
