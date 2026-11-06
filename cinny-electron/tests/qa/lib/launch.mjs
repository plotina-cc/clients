// Resolve a QA target (AppImage / deb / unpacked dir / prototype repo dir /
// bare binary) into a concrete launch command, and manage the app process.
// No product code here — everything runs the app exactly as a user would.
'use strict';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const isExec = (p) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

// Look for an ELF-ish binary header (cheap check, avoids `file` dependency)
const looksBinary = (p) => {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x7f && buf[1] === 0x45; // \x7fELF
  } catch {
    return false;
  }
};

/**
 * @returns {{kind:string, cmd:string, prefixArgs:string[], note?:string}}
 *   kind: 'appimage' | 'deb' | 'electron-builder-unpacked' | 'prototype' | 'binary'
 */
export function resolveTarget(targetPath) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) throw new Error(`target does not exist: ${abs}`);
  const st = fs.statSync(abs);

  if (st.isFile() && abs.endsWith('.AppImage')) {
    if (!isExec(abs)) fs.chmodSync(abs, 0o755);
    // --appimage-extract-and-run avoids FUSE (absent in containers/CI).
    return { kind: 'appimage', cmd: abs, prefixArgs: ['--appimage-extract-and-run'] };
  }

  if (st.isFile() && abs.endsWith('.deb')) {
    if (!spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8' }).stdout) {
      throw new Error('target is a .deb but dpkg-deb is not installed on this host');
    }
    const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-qa-deb-'));
    const r = spawnSync('dpkg-deb', ['-x', abs, rootfs], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('dpkg-deb -x failed: ' + r.stderr);
    return { kind: 'deb', cmd: findDebLauncher(rootfs), prefixArgs: [], note: `extracted to ${rootfs}` };
  }

  if (st.isDirectory()) {
    // 1. prototype repo dir: package.json main -> src/main.js + electron in node_modules
    const pkgJson = path.join(abs, 'package.json');
    if (fs.existsSync(pkgJson)) {
      let pkg = null;
      try { pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')); } catch { /* not the app */ }
      if (pkg?.main && fs.existsSync(path.join(abs, pkg.main))) {
        const eb = [
          process.env.QA_ELECTRON_BIN,
          path.join(abs, 'node_modules/electron/dist/electron'),
        ].find((p) => p && fs.existsSync(p));
        if (!eb) throw new Error(`prototype target ${abs} needs an electron binary (node_modules not installed; set QA_ELECTRON_BIN)`);
        return { kind: 'prototype', cmd: eb, prefixArgs: [abs] };
      }
    }
    // 2. AppImage already extracted
    if (isExec(path.join(abs, 'AppRun'))) {
      return { kind: 'appimage', cmd: path.join(abs, 'AppRun'), prefixArgs: [] };
    }
    // 3. electron-builder linux-unpacked
    const unpacked = path.join(abs, 'linux-unpacked');
    const base = fs.existsSync(unpacked) ? unpacked : abs;
    const exe = findUnpackedBinary(base);
    if (exe) return { kind: 'electron-builder-unpacked', cmd: exe, prefixArgs: [] };
    throw new Error(`cannot find a launcher in directory ${abs} (expected AppRun, an executable, or resources/app)`);
  }

  if (st.isFile() && looksBinary(abs)) {
    return { kind: 'binary', cmd: abs, prefixArgs: [] };
  }
  throw new Error(`unsupported target type: ${abs}`);
}

function findDebLauncher(rootfs) {
  const candidates = [];
  for (const dir of ['usr/bin', 'usr/lib', 'opt']) {
    const d = path.join(rootfs, dir);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (/plotina/i.test(name) && isExec(p)) candidates.push(p);
      const inner = path.join(p, 'plotina-lite'); // opt/<pkg>/plotina-lite
      if (isExec(inner)) candidates.push(inner);
    }
  }
  const hit = candidates.find((p) => isExec(p));
  if (!hit) throw new Error(`deb extracted but no plotina launcher found under ${rootfs}`);
  return hit;
}

function findUnpackedBinary(base) {
  let out = null;
  const walk = (dir, depth) => {
    if (out || depth > 2) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory() && name !== 'locales') { walk(p, depth + 1); continue; }
      if (st.isFile() && isExec(p) && looksBinary(p) && /plotina/i.test(name)) { out = p; return; }
    }
  };
  walk(base, 0);
  return out;
}

// ---------------------------------------------------------------- fingerprint
/**
 * A stable "the install was not replaced" fingerprint. Files: hash the file
 * itself. Dirs: hash the launcher binary + package metadata (cheap, and enough
 * to prove updater scenarios never mutate the install under test).
 */
export function installFingerprint(targetPath) {
  const abs = path.resolve(targetPath);
  const st = fs.statSync(abs);
  const h = crypto.createHash('sha256');
  if (st.isFile()) {
    h.update(fs.readFileSync(abs));
  } else {
    let exe = null;
    try { exe = resolveTarget(abs).cmd; } catch { /* dir without binary */ }
    if (exe && looksBinary(exe)) h.update(fs.readFileSync(exe));
    const pkg = path.join(abs, 'package.json');
    if (fs.existsSync(pkg)) h.update(fs.readFileSync(pkg));
  }
  return h.digest('hex');
}

// -------------------------------------------------------------------- launch
/**
 * Spawn the app. Returns a handle with a growing `log` array (redacted by the
 * caller), the process, and helpers. Chromium/Electron flags go after the app
 * dir arg so main.js-style prototypes still see them (verified pattern from
 * scripts/qa.mjs).
 */
export function launchApp(resolved, { args = [], env = {}, logFile = null, label = 'app' }) {
  const fullArgs = [...resolved.prefixArgs, ...args];
  const proc = spawn(resolved.cmd, fullArgs, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group; kill(-pid) reaps zygote/GPU children
  });
  const log = [];
  const stream = (s, sink) => {
    s.on('data', (d) => {
      const str = d.toString();
      log.push(str);
      if (logFile) fs.appendFileSync(logFile, str);
      if (sink) process.stdout.write(`[${label}] ${str}`);
    });
    s.resume();
  };
  stream(proc.stdout, process.env.QA_VERBOSE === '1');
  stream(proc.stderr, false);
  let exitInfo = null;
  proc.on('exit', (code, sig) => {
    exitInfo = { code, sig };
    console.log(`[${label}] exited code=${code} sig=${sig}`);
  });
  return {
    proc,
    log,
    label,
    get exited() { return exitInfo !== null; },
    get exitInfo() { return exitInfo; },
    logText: () => log.join(''),
    async waitForExit(timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (exitInfo !== null) return exitInfo;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`${label} did not exit within ${timeout}ms`);
    },
  };
}

export function killApp(handle, { forceAfter = 8000 } = {}) {
  if (!handle || handle.exited) return;
  try {
    process.kill(-handle.proc.pid, 'SIGTERM');
  } catch {
    try { handle.proc.kill('SIGTERM'); } catch { /* gone */ }
  }
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (handle.exited || Date.now() - t0 > forceAfter) {
      clearInterval(timer);
      if (!handle.exited) {
        try { process.kill(-handle.proc.pid, 'SIGKILL'); } catch {
          try { handle.proc.kill('SIGKILL'); } catch { /* gone */ }
        }
      }
    }
  }, 250);
  setTimeout(() => clearInterval(timer), forceAfter + 1000).unref?.();
}

export function makeTempProfile(outDir, name) {
  const dir = fs.mkdtempSync(path.join(outDir, `profile-${name}-`));
  return dir;
}
