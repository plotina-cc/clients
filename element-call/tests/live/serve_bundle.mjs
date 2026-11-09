/*
Static HTTPS server for a built Element Call bundle, so the live proof runs
against the artefact the patch series produces rather than a dev server.

  node serve_bundle.mjs <dist dir> <port> <cert dir>

<cert dir> holds a key and a certificate (`key.pem`, `cert.pem`); a self-signed
pair for *.m.localhost is what the upstream docker-compose-dev.yml stand uses.
Unknown paths fall back to index.html, because Element Call routes calls under
/room/.
*/
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const [rootArg, portArg, certDir] = process.argv.slice(2);
if (!rootArg || !portArg || !certDir) {
  console.error("usage: node serve_bundle.mjs <dist dir> <port> <cert dir>");
  process.exit(2);
}
const root = normalize(rootArg);
const port = Number(portArg);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const server = createServer(
  {
    key: await readFile(join(certDir, "key.pem")),
    cert: await readFile(join(certDir, "cert.pem")),
  },
  async (req, res) => {
    try {
      const url = new URL(req.url, "https://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/index.html";
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) throw new Error("outside root");
      let body;
      let servedPath = file;
      try {
        body = await readFile(file);
      } catch {
        // Single-page app: unknown paths (e.g. /room/) render index.html.
        servedPath = join(root, "index.html");
        body = await readFile(servedPath);
      }
      res.writeHead(200, {
        "content-type": types[extname(servedPath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  },
);

server.listen(port, "0.0.0.0", () => {
  console.log(`serving ${root} on https://localhost:${port}/`);
});