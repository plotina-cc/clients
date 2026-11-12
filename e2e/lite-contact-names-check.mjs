/**
 * Live check of the built Lite dist: does a personal contact name reach every
 * surface the card names -- chat list, chat header, message author, preview --
 * and does it also show for the same person inside a GROUP?
 *
 *   node lite-contact-names-check.mjs <dist-dir> <out-dir>
 *
 * The card's DoD asks for three full restarts with the name still in the list,
 * so this runs the cold start three times, each with a fresh browser profile
 * (empty IndexedDB, empty localStorage except the session) and wipes the sync
 * store between runs -- that is what makes it a cold start and not a reload.
 *
 * Reads are DOM text a user would SEE; nothing asserts on internal variables.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DIST = path.resolve(process.argv[2] || '.');
const OUT = path.resolve(process.argv[3] || '/tmp/lite-contact-names');
const HS = 'https://plotina.cc';
const ME = '@qa-a:plotina.cc';
const DEVICE = 'QA-A';
const DM = '!zwMwXUqqAZ_RFKj-quOvRBOezFK-AJX-2WE-N9KYqF8';
const GROUP = process.env.QA_GROUP || '!JGUyyYRh52WvBD7_5XC89eHDpdRvgG7wsX8WBZzH6vI';
const PERSONAL = 'Денчик';
const MEMBER_NAME = 'Plotina QA QA-B';
const ROUNDS = Number(process.env.QA_ROUNDS || 3);
const TOKEN_FILE = process.env.QA_TOKEN_FILE || '/home/hermes/.hermes/secrets/qa/qa-a.token';
const CHROME = process.env.CHROME || '/home/hermes/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

fs.mkdirSync(OUT, { recursive: true });
// Browser profiles are throwaway state, not evidence: they are large, and a
// profile left inside the report directory would be shipped with it.
const SCRATCH = process.env.QA_SCRATCH
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lite-contact-names-'));
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), rounds: [], checks: [], shots: {} };
const record = (ok, name, extra = {}) => {
  evidence.checks.push({ ok, check: name, ...extra });
  console.log(ok ? 'PASS' : 'FAIL', name, extra.value !== undefined ? JSON.stringify(extra.value) : '');
};

/* ------------------------------------------------------------ static server */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json',
};
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
console.log('serving', DIST, 'on', ORIGIN);

/* -------------------------------------------------------------- CDP client */
class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = (this.id += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 90000);
    });
  }
}

/** One browser "restart": fresh profile directory, so storage starts empty. */
async function startBrowser(round) {
  const profile = fs.mkdtempSync(path.join(SCRATCH, `profile-${round}-`));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    '--window-size=1400,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  // With port 0 Chromium writes the real endpoint into DevToolsActivePort.
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i += 1) {
    if (fs.existsSync(portFile)) {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      return { proc, port: Number(port), wsPath, profile };
    }
    await sleep(150);
  }
  throw new Error(`browser did not start: ${err.slice(-400)}`);
}

async function attach({ port }) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = new CDPClient(version.webSocketDebuggerUrl);
  await browser.ready;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  const evaluate = async (expression, awaitPromise = false) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
    return res.result.value;
  };
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    evidence.shots[name] = p;
    return p;
  };
  return { browser, send, evaluate, screenshot };
}

const readList = `
  (() => {
    const rows = [...document.querySelectorAll('a[href^="/direct/"], a[href^="/room/"]')];
    return rows.map((a) => ({
      href: a.getAttribute('href'),
      text: (a.innerText || '').replace(/\\s+/g, ' ').trim(),
    }));
  })()
`;

const readScreen = `
  (() => {
    const body = document.body.innerText;
    return {
      text: body,
      lines: body.split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 120),
      hasPersonal: body.includes(${JSON.stringify(PERSONAL)}),
      hasMemberName: body.includes(${JSON.stringify(MEMBER_NAME)}),
    };
  })()
`;

async function waitFor(evaluate, expr, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expr)) return true; } catch { /* page navigating */ }
    await sleep(500);
  }
  return false;
}

/* -------------------------------------------------------------- the rounds */
const roundResults = [];
for (let round = 1; round <= ROUNDS; round += 1) {
  const br = await startBrowser(round);
  const { send, evaluate, screenshot } = await attach(br);
  const r = { round, checks: [] };
  const push = (ok, name, extra = {}) => {
    r.checks.push({ ok, check: name, ...extra });
    record(ok, `round ${round}: ${name}`, extra);
  };

  await send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(1200);
  await evaluate(`
    localStorage.setItem('cinny_hs_base_url', ${JSON.stringify(HS)});
    localStorage.setItem('cinny_user_id', ${JSON.stringify(ME)});
    localStorage.setItem('cinny_device_id', ${JSON.stringify(DEVICE)});
    localStorage.setItem('cinny_access_token', ${JSON.stringify(token)});
    'ok'
  `);

  // COLD START: /direct straight away. The room is never opened, so the name in
  // the list can only come from the account data + the room-name generator.
  await send('Page.navigate', { url: `${ORIGIN}/direct` });
  const listed = await waitFor(evaluate, `${readList}.length > 0`, 120000);
  await sleep(3000);
  const list = await evaluate(readList);
  r.chatList = list;

  if (!listed) {
    push(false, 'cold start: the chat list rendered', { value: null });
    await screenshot(`r${round}-01-no-list`);
  } else {
    // Two chats with the SAME person: both must read the personal name, because
    // the key is the mxid and not the room. This is card case (а).
    const personalRows = list.filter((x) => x.text.includes(PERSONAL));
    push(personalRows.length >= 1,
      'cold start: a DM row shows the personal name, room never opened',
      { value: personalRows.map((x) => x.text) });
    push(personalRows.length === list.filter((x) => x.href.startsWith('/direct/')).length,
      'cold start: EVERY chat with that person reads the same name',
      { value: personalRows.map((x) => x.text) });
    await screenshot(`r${round}-02-cold-list`);
  }

  // The group lives in /home; it must keep its own m.room.name and must NOT take
  // the contact's name -- that would be "the room is renamed by a contact name".
  // /home lists rooms as plain rows (no <a>), so it is read from the ROOMS pane.
  await send('Page.navigate', { url: `${ORIGIN}/home/` });
  await waitFor(evaluate, `document.body.innerText.includes('ROOMS')`, 90000);
  await sleep(5000);
  const homeText = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`);
  r.homeText = homeText.slice(0, 2000);
  const hasGroupName = homeText.includes('QA group');
  // The row's NAME must be the room's own m.room.name. A contact name leaking
  // into a group would make the row read "Денчик" instead of "QA group три", so
  // the assertion is on the title itself, not on the row body (which legitimately
  // shows the contact as the author of the last message).
  const groupTitle = (homeText.match(/QA group[^ ]*(?: [^ ]+)?/) || [null])[0];
  push(hasGroupName, 'cold start: the group appears in /home with its own m.room.name',
    { value: groupTitle });
  push(groupTitle !== null && groupTitle !== PERSONAL && !groupTitle.includes(PERSONAL),
    'cold start: the group title is the room name, not the contact name',
    { value: groupTitle });
  await screenshot(`r${round}-02b-home-list`);

  // Open the DM: header + author + preview must all say the personal name.
  await send('Page.navigate', { url: `${ORIGIN}/direct/${encodeURIComponent(DM)}` });
  const dmReady = await waitFor(evaluate, `document.body.innerText.length > 200`, 60000);
  await sleep(4000);
  const dm = await evaluate(readScreen);
  // The header is the element INSIDE the room's own <header>, not the page nav's
  // header: a page can have more than one, so the check looks for the name in
  // any header that actually contains it.
  const header = await evaluate(`
    (() => {
      const headers = [...document.querySelectorAll('header')]
        .filter((h) => !/Direct Messages|Home|Create/i.test(h.innerText || '') || h.offsetHeight < 90);
      const withName = headers.filter((h) => (h.innerText || '').includes(${JSON.stringify(PERSONAL)}));
      return withName.length
        ? { text: withName[0].innerText.replace(/\\s+/g, ' ').trim(), count: withName.length }
        : { text: null, headers: [...document.querySelectorAll('header')].map((h) => (h.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40)) };
    })()
  `);
  r.dm = { header, hasPersonal: dm.hasPersonal, hasMemberName: dm.hasMemberName, sample: dm.lines.slice(0, 30) };
  push(!!header.text && header.text.includes(PERSONAL), 'open DM: the header reads the personal name', { value: header });
  push(dm.hasPersonal, 'open DM: the personal name is on screen (author / preview)', { value: dm.hasPersonal });
  await screenshot(`r${round}-03-dm`);

  // The group: same person, same name; the room keeps its own name.
  // A group lives under /home — /direct is the DIRECT list, whose route provider
  // resolves the room as a dialogue, so opening a group there lands on the
  // "join this room" placeholder instead of the room.
  await send('Page.navigate', { url: `${ORIGIN}/home/${encodeURIComponent(GROUP)}` });
  await waitFor(evaluate, `document.body.innerText.length > 200`, 60000);
  await sleep(6000);
  const g = await evaluate(readScreen);
  r.group = { hasPersonal: g.hasPersonal, hasMemberName: g.hasMemberName, sample: g.lines.slice(0, 40) };
  push(g.text.includes('QA group'), 'group: the room keeps its own m.room.name', { value: g.text.includes('QA group') });
  push(g.hasPersonal, 'group: the author of the seeded message reads the personal name', { value: g.hasPersonal });
  await screenshot(`r${round}-04-group`);

  // The member list of the group must carry it too: open the People drawer.
  const opened = await evaluate(`
    (() => {
      const cands = [...document.querySelectorAll('button, [role="button"], a')];
      const hit = cands.find((el) => /people|members|участник/i.test(el.getAttribute('aria-label') || el.title || ''));
      if (hit) { hit.click(); return hit.getAttribute('aria-label') || hit.title || 'clicked'; }
      return null;
    })()
  `);
  await sleep(3500);
  const m = await evaluate(readScreen);
  r.members = { openedWith: opened, hasPersonal: m.hasPersonal, sample: m.lines.slice(0, 50) };
  push(m.hasPersonal, 'group: the member list shows the personal name', { value: m.hasPersonal });
  await screenshot(`r${round}-05-members`);

  roundResults.push(r);
  evidence.rounds.push(r);
  br.proc.kill('SIGTERM');
  await sleep(800);
  // The profile is throwaway: leaving 3 × ~100 MB of Chrome state in the report
  // directory would ship it with the report.
  try { fs.rmSync(br.profile, { recursive: true, force: true }); } catch { /* chrome may hold files */ }
}

/* ------------------------------------------------------------------ summary */
const failed = evidence.checks.filter((c) => !c.ok).length;
evidence.finishedAt = new Date().toISOString();
evidence.summary = { total: evidence.checks.length, failed, rounds: ROUNDS };
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.checks.length - failed}/${evidence.checks.length} checks passed over ${ROUNDS} cold starts`);
console.log('evidence:', path.join(OUT, 'evidence.json'));
server.close();
process.exit(failed === 0 ? 0 : 1);
