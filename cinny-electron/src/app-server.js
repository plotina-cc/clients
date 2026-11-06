// Minimal static server for the Cinny web dist, on http://localhost:<port>.
//
// Why a localhost HTTP server instead of a custom `plotina-lite://` scheme:
//   1. Cinny registers a service worker (dist/sw.js, push/session bridge).
//      Chromium only allows ServiceWorkerRegistration on http(s) origins;
//      custom schemes fail with "The protocol ... is not supported".
//   2. getUserMedia/WebRTC require a secure context. http://localhost is a
//      potentially-trustworthy origin, so the app origin gets full media APIs.
//   3. Cinny uses path-based routing (hashRouter disabled in config.json).
//      file:// would break deep links (/home/<room>/) and the SW scope.
//      This server falls back to index.html for extension-less paths.
//   4. The Tauri shell we are replacing used the same trick
//      (tauri-plugin-localhost, origin http://localhost:44548), and the
//      patched web app's SSO token handoff is origin-agnostic
//      (window.location.origin), so keeping a fixed port preserves
//      localStorage/IndexedDB continuity where possible.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * @param {string} distRoot absolute path of the Cinny `dist` directory
 * @returns {http.Server} not yet listening
 */
function createAppServer(distRoot) {
  const root = path.resolve(distRoot);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`not a Cinny dist (no index.html): ${root}`);
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'bad url');
    }

    let filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      return send(res, 403, 'forbidden'); // traversal guard
    }

    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch { /* missing */ }

    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try { stat = fs.statSync(filePath); } catch { stat = null; }
    }

    // SPA fallback: path-based routes like /login/plotina.cc/?loginToken=..
    // contain dots that are NOT file extensions, so we cannot key off
    // extname alone. Rule: a 404 falls back to index.html unless the last
    // segment names a known static asset type (those must 404 properly, e.g.
    // a missing hashed chunk must not masquerade as the app shell).
    const lastSegment = pathname.replace(/\/+$/, '').split('/').pop() || '';
    const looksLikeAsset = ['.js', '.css', '.json', '.png', '.ico', '.svg', '.wasm',
      '.woff', '.woff2', '.ttf', '.map', '.mp3', '.ogg', '.txt', '.webmanifest'].includes(
      path.extname(lastSegment).toLowerCase());
    if (!stat && !looksLikeAsset) {
      filePath = path.join(root, 'index.html');
      try { stat = fs.statSync(filePath); } catch { stat = null; }
      if (!stat) return send(res, 404, 'not found');
      const html = fs.readFileSync(filePath);
      return send(res, 200, html, {
        'Content-Type': MIME['.html'],
        'Cache-Control': 'no-cache',
      });
    }
    if (!stat) return send(res, 404, 'not found');

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // index.html / config.json must refresh; hashed assets are immutable
      'Cache-Control': filePath.endsWith('index.html') || ext === '.json'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { createAppServer };
