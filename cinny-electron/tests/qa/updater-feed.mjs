#!/usr/bin/env node
// Local updater-feed fixture generator + static feed server for the Plotina
// Lite QA harness. Lets U-02 (no update), U-03 (valid update available) and
// U-05 (tampered sha512 / bad metadata) run against a 127.0.0.1 feed with no
// publishing involved.
//
//   node updater-feed.mjs gen --out DIR [--version 999.0.0] [--downgrade-version 0.0.1]
//                             [--artifact PATH]           # real AppImage to reuse as the "new" build
//   node updater-feed.mjs verify --dir DIR               # self-check fixture integrity
//   node updater-feed.mjs serve --dir DIR --port PORT    # foreground HTTP server (feed root)
//
// Feed layout served (electron-updater "generic" provider style):
//   DIR/available/latest-linux.yml  + Plotina-Lite-Desktop-<ver>.AppImage  (correct sha512+size)
//   DIR/error/latest-linux.yml      + same artifact, sha512 TAMPERED       (must be refused)
//   DIR/no-update/latest-linux.yml  version BELOW any real build (must not be offered)
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const sha512Base64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

function fakeArtifactBytes(version) {
  // ~2 MB deterministic pseudo-artifact so sha/size are realistic without a
  // real build; stands in for the "new" AppImage the feed advertises.
  const size = 2 * 1024 * 1024;
  const buf = Buffer.alloc(size);
  buf.write('FAKE-APPIMAGE-FIXTURE ' + version + ' ');
  let seed = crypto.createHash('sha512').update(version).digest().readUInt32BE(0);
  for (let i = 48; i < size; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0; // LCG; entropy is irrelevant, size is not
    buf[i] = (seed >>> 16) & 0xff;
  }
  return buf;
}

/**
 * Build one feed case directory. Returns the written paths.
 * @param {object} o {dir, version, artifactPath?, tamper?:boolean}
 */
export function buildFeedCase(o) {
  const dir = o.dir;
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `Plotina-Lite-Desktop-${o.version}.AppImage`;
  const artifactPath = path.join(dir, fileName);
  const bytes = o.artifactPath ? fs.readFileSync(o.artifactPath) : fakeArtifactBytes(o.version);
  fs.writeFileSync(artifactPath, bytes);
  const sha512 = sha512Base64(bytes);
  const declaredSha = o.tamper ? tamper(sha512) : sha512;
  const yml = [
    `version: ${o.version}`,
    `files:`,
    `  - url: ${fileName}`,
    `    sha512: ${declaredSha}`,
    `    size: ${bytes.length}`,
    `path: ${fileName}`,
    `sha512: ${declaredSha}`,
    `releaseDate: '${new Date().toISOString()}'`,
    `releaseNotes: 'QA local feed fixture (${o.tamper ? 'TAMPERED sha512' : 'valid'})'`,
    '',
  ].join('\n');
  const ymlPath = path.join(dir, 'latest-linux.yml');
  fs.writeFileSync(ymlPath, yml);
  return { dir, ymlPath, artifactPath, expectedSha512: sha512, declaredSha512: declaredSha, size: bytes.length, version: o.version };
}

// Flip one base64 char, keeping the string a plausible 88-char digest.
function tamper(b64) {
  const arr = b64.split('');
  const i = 20;
  const c = arr[i];
  arr[i] = c === 'A' ? 'B' : 'A';
  return arr.join('');
}

export function buildFeed({ outDir, newVersion = '999.0.0', downgradeVersion = '0.0.1', artifactPath = null }) {
  const cases = {
    available: buildFeedCase({ dir: path.join(outDir, 'available'), version: newVersion, artifactPath }),
    error: buildFeedCase({ dir: path.join(outDir, 'error'), version: newVersion, artifactPath, tamper: true }),
    // no-update case: version strictly below anything real, so a correct
    // updater must NOT offer it (also exercises the U-08 downgrade refusal).
    'no-update': buildFeedCase({ dir: path.join(outDir, 'no-update'), version: downgradeVersion, artifactPath }),
  };
  return cases;
}

export function serveFeed(dir, port) {
  const accessLog = []; // {ts, case, file, ip} — evidence of whether the app consulted the feed
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    accessLog.push({ ts: new Date().toISOString(), url: '/' + rel });
    const full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir) + path.sep) && full !== path.resolve(dir)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let st;
    try { st = fs.statSync(full); } catch { res.writeHead(404); res.end('not found'); return; }
    if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    // Range support: electron-updater downloads can be ranged.
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': full.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, accessLog })));
}

// ----------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

if (argv[0] === 'gen') {
  const cases = buildFeed({
    outDir: flag('out', './qa-feed'),
    newVersion: flag('version', '999.0.0'),
    downgradeVersion: flag('downgrade-version', '0.0.1'),
    artifactPath: flag('artifact', null),
  });
  console.log(JSON.stringify(cases, null, 2));
} else if (argv[0] === 'verify') {
  const dir = flag('dir', './qa-feed');
  let ok = true;
  for (const c of ['available', 'error', 'no-update']) {
    const ymlPath = path.join(dir, c, 'latest-linux.yml');
    if (!fs.existsSync(ymlPath)) { console.error(`missing ${ymlPath}`); ok = false; continue; }
    const yml = fs.readFileSync(ymlPath, 'utf8');
    const sha = /sha512: (\S+)/.exec(yml)[1];
    const size = Number(/size: (\d+)/.exec(yml)[1]);
    const fileName = /^path: (\S+)$/m.exec(yml)[1];
    const bytes = fs.readFileSync(path.join(dir, c, fileName));
    const real = sha512Base64(bytes);
    const match = real === sha;
    const sizeOk = bytes.length === size;
    console.log(`${c}: declared=${sha.slice(0, 12)}… real=${real.slice(0, 12)}… sha-match=${match} size-match=${sizeOk}`);
    if (c === 'error' && match) { console.error('  error case must NOT match!'); ok = false; }
    if (c !== 'error' && (!match || !sizeOk)) ok = false;
  }
  process.exit(ok ? 0 : 1);
} else if (argv[0] === 'serve') {
  const { server } = await serveFeed(flag('dir', './qa-feed'), Number(flag('port', 9440)));
  console.log(`serving ${flag('dir', './qa-feed')} on http://127.0.0.1:${server.address().port}`);
} else {
  console.log('usage: updater-feed.mjs gen|verify|serve [--out DIR] [--dir DIR] [--port N] [--version V] [--artifact PATH]');
}
