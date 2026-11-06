#!/usr/bin/env node
// refresh-update-yml.mjs — recompute sha512/size in a latest*.yml from the
// actual files next to it. Needed because fix-deb.sh repacks the .deb AFTER
// electron-builder hashed it; stale digests would make the updater refuse a
// perfectly good artifact. Preserves entry order and all other lines.
//
//   node scripts/refresh-update-yml.mjs dist/latest-linux.yml
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ymlPath = path.resolve(process.argv[2]);
const dir = path.dirname(ymlPath);
const lines = fs.readFileSync(ymlPath, 'utf8').split('\n');
const sha512b64 = (p) => crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64');

let updated = [];
// entries: "  - url: NAME" followed by indented sha512/size keys.
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*-\s*url:\s*(\S+)\s*$/.exec(lines[i]);
  if (!m) continue;
  const file = path.join(dir, m[1]);
  if (!fs.existsSync(file)) continue;
  for (let j = i + 1; j < lines.length && /^\s{4,}\w+:/.test(lines[j]); j++) {
    if (/^\s+sha512:/.test(lines[j])) lines[j] = `    sha512: ${sha512b64(file)}`;
    else if (/^\s+size:/.test(lines[j])) lines[j] = `    size: ${fs.statSync(file).size}`;
  }
  updated.push(m[1]);
}
// top-level (column-0) path/sha512 pair.
for (let i = 0; i < lines.length; i++) {
  const m = /^path:\s*(\S+)\s*$/.exec(lines[i]);
  if (m) {
    const file = path.join(dir, m[1]);
    if (fs.existsSync(file) && fs.existsSync(path.join(dir, m[1]))) {
      for (let j = i + 1; j < lines.length && /^\w+:/.test(lines[j]); j++) {
        if (/^sha512:/.test(lines[j])) { lines[j] = `sha512: ${sha512b64(file)}`; updated.push(`top:${m[1]}`); break; }
      }
    }
  }
}
fs.writeFileSync(ymlPath, lines.join('\n'));
console.log(`refreshed ${updated.join(', ') || 'nothing'} in ${path.basename(ymlPath)}`);
