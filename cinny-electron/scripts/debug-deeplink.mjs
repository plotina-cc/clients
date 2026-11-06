// Diagnostic: does a second `electron APP_DIR cc.plotina.chat://..` forward
// the deep link to the running instance via the single-instance lock?
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-dl-'));
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env1 = { ...process.env, LITE_PORT: '0', LITE_USER_DATA: profileDir, LITE_DIST: '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' };

console.log('launching holder...');
const p1 = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR], { env: env1 });
p1.stdout.on('data', (d) => out.push('[1] ' + d.toString()));
p1.stderr.on('data', (d) => out.push('[1e] ' + d.toString()));
await sleep(6000);

console.log('launching second instance with deep link...');
const p2 = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, 'cc.plotina.chat://login?loginToken=DL_TEST'], { env: env1 });
let p2out = [];
p2.stdout.on('data', (d) => p2out.push(d.toString()));
p2.stderr.on('data', (d) => p2out.push(String(d)));
const code = await Promise.race([
  new Promise((res) => p2.on('exit', (c) => res('exit=' + c))),
  sleep(8000).then(() => 'still-running'),
]);
console.log('second instance:', code);
console.log('second stdout/stderr:', p2out.join('').slice(0, 600));
await sleep(2000);
p1.kill('SIGKILL');
const text = out.join('');
for (const line of text.split('\n')) {
  if (/second-instance|\[sso\]|serving|protocol|hand|inbox|deeplink|deep link|failed/i.test(line)) console.log(line.trim().slice(0, 200));
}
fs.rmSync(profileDir, { recursive: true, force: true });
console.log('DL_DIAG_DONE');
process.exit(0);
