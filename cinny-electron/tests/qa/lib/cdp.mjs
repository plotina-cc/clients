// Minimal Chrome DevTools Protocol client over the WebSocket global (Node >=21).
// Extracted from scripts/qa.mjs (the Phase-1 acceptance harness) so the
// regression runner can reuse it for every app launch.
'use strict';

import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollFor(fn, timeout, interval = 500, why = '') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for: ${why}${last !== undefined ? ` (last=${last})` : ''}`);
}

export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((cb) => cb(msg.params));
      }
    };
    this.closed = new Promise((resolve) => {
      this.ws.onclose = () => {
        for (const [, p] of this.pending) p.reject(new Error('cdp closed'));
        this.pending.clear();
        resolve();
      };
    });
    this.ready = new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) resolve();
      else {
        this.ws.onopen = () => resolve();
        this.ws.addEventListener('error', () => reject(new Error('cdp ws error')));
        this.ws.addEventListener('close', () => reject(new Error('cdp ws closed before open')));
      }
    });
  }

  static async create(wsUrl) {
    const c = new CDP(wsUrl);
    await c.ready;
    return c;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      const settle = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ targets
export async function listTargets(cdpPort) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}

export async function cdpUp(cdpPort, timeout = 30000) {
  return pollFor(
    async () => {
      try {
        const l = await listTargets(cdpPort);
        return Array.isArray(l);
      } catch {
        return false;
      }
    },
    timeout, 400, 'CDP endpoint');
}

export async function pageTargets(cdpPort, urlPrefix = null) {
  const list = await listTargets(cdpPort);
  return list.filter((t) => t.type === 'page' && (!urlPrefix || (t.url || '').startsWith(urlPrefix)));
}

export async function waitForPageTarget(cdpPort, urlPrefix, timeout = 30000) {
  return pollFor(
    async () => (await pageTargets(cdpPort, urlPrefix))[0] || false,
    timeout, 400, `page target${urlPrefix ? ' for ' + urlPrefix : ''}`);
}
