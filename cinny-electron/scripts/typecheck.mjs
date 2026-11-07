// Syntax/type check for the Electron shell: parses every JS file we ship or
// test with node's own parser (`node --check`), so a broken src/ or tests/
// file fails fast without a build. There is no TypeScript in this package —
// the shell is plain CommonJS — so this is the cheapest real gate we have.
//
//   node scripts/typecheck.mjs
'use strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const DIRS = ['src', 'tests', 'tests/helpers', 'scripts'];
const files = [];
for (const dir of DIRS) {
  const abs = path.join(HERE, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (/\.(js|mjs|cjs)$/.test(f)) files.push(path.join(dir, f));
  }
}
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(HERE, f)], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${e.stderr?.toString() || e.message}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parse cleanly`);
if (failed) process.exit(1);
