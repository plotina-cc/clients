/*
Live proof for patches/0007-plotina-noise-settings.patch.

What it drives, in one Element Call (the upstream docker-compose-dev.yml stand:
Synapse + LiveKit + lk-jwt-service behind its nginx, *.m.localhost), against a
bundle that is a plain `vite build` of the pinned tag with the whole patch
series applied:

  1. in a call, the "…" settings button opens the settings modal on its Audio
     tab, and the tab carries one noise suppression row — a compound icon, the
     label, the current value in dB, a 0–100 slider;
  2. moving that slider reaches the running DeepFilterNet3 bridge
     (window.__plotinaDfn.level/applied), is written to
     localStorage["plotina.noise.level"], and the row shows the new value;
  3. the level survives the call: a reload and a second join come back with it;
  4. the old floating panel is nowhere: #plotina-noise-panel is not in the DOM,
     with the room view showing or with the settings modal open, and no element
     carries the old "Noise · <n> dB" pill text;
  5. the embedded shape — the call inside an iframe, which is how Plotina Lite,
     Element Web and Plotina X open it — shows and drives the same row.

The stand's Synapse defaults to room version 12 and refuses the createRoom body
Element Call 0.26.1 sends, so the room is made here through the C-S API with the
power levels Element Call asks for (src/utils/matrix.ts). Every account this
script uses is registered on the stand (registration is open there); nothing
else on the stand is touched.

Evidence (screenshots + evidence.json) goes to EVIDENCE_DIR.

Usage, from element-call/tests/live:

  BASE_URL=https://localhost:3544/ EVIDENCE_DIR=$PWD/out \
    PLAYWRIGHT_FROM=/path/to/ec/src/package.json node noise_settings_proof.mjs

  ROOM_ID=!abc:synapse.m.localhost   reuse an existing call room
  HOMESERVER=https://synapse.m.localhost   the stand's Synapse (default)

The bundle under BASE_URL must be a build of the pinned tag with the patch
series applied (element-call/build.py --mode source, or a `vite build` plus
inject-noise.py) with /noise/ and config.json served next to it, over HTTPS
(serve_bundle.mjs) — plus embed.html, which make-live-dist.py writes.
*/
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { request } from "node:https";

const requireFrom = createRequire(
  process.env.PLAYWRIGHT_FROM ?? fileURLToPath(import.meta.url),
);
const { chromium } = requireFrom("@playwright/test");

const BASE_URL = process.env.BASE_URL ?? "https://localhost:3544/";
const HOMESERVER = process.env.HOMESERVER ?? "https://synapse.m.localhost";
const OUT =
  process.env.EVIDENCE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const MAKER_TOKEN_FILE = join(OUT, "room-maker-token.json");

const LEVEL_KEY = "plotina.noise.level";
const ROW = "plotina-noise-suppression";
const PASSWORD = "noise-settings-probe-1";
const evidence = { started: new Date().toISOString(), baseUrl: BASE_URL, checks: [] };

function check(name, ok, detail) {
  evidence.checks.push({ name, ok: !!ok, detail });
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  return ok;
}

const say = (msg, extra) =>
  console.log(msg, extra === undefined ? "" : JSON.stringify(extra));

/* ------------------------------------------------ the stand's C-S API */

function api(path, body, token) {
  const url = new URL(path, HOMESERVER);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: payload === null ? "GET" : "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(data);
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** One maker account, cached: the C-S API is rate limited per IP. */
async function makerToken() {
  try {
    const cached = JSON.parse(readFileSync(MAKER_TOKEN_FILE, "utf8"));
    if (cached.accessToken) return cached;
  } catch {
    /* first run */
  }
  const user = `noisemaker${Math.random().toString(36).slice(2, 8)}`;
  const registered = await api("/_matrix/client/v3/register", {
    username: user,
    password: PASSWORD,
    auth: { type: "m.login.dummy" },
  });
  let session = registered.json;
  if (registered.status !== 200) {
    const login = await api("/_matrix/client/v3/login", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user },
      password: PASSWORD,
    });
    if (login.status !== 200) {
      throw new Error(`cannot get a maker token: ${JSON.stringify([registered, login])}`);
    }
    session = login.json;
  }
  const cache = {
    user,
    userId: session.user_id,
    accessToken: session.access_token,
  };
  writeFileSync(MAKER_TOKEN_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

async function ensureRoom() {
  if (process.env.ROOM_ID) return process.env.ROOM_ID;
  const maker = await makerToken();
  const room = await api(
    "/_matrix/client/v3/createRoom",
    {
      name: `NoiseSettings-${Date.now()}`,
      preset: "public_chat",
      // Room version 12 drops the server name from the room ID and Element Call
      // 0.26.1 rejects an ID without one.
      room_version: "10",
      creation_content: { type: "org.matrix.msc3417.call" },
      // src/utils/matrix.ts: call.member at level 0, or a member cannot post its
      // own membership and the call dies with "user_level (0) < send_level (50)".
      power_level_content_override: {
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
        state_default: 0,
        events_default: 0,
        users_default: 0,
        events: {
          "m.room.power_levels": 100,
          "m.room.history_visibility": 100,
          "m.room.tombstone": 100,
          "m.room.encryption": 100,
          "m.room.name": 50,
          "m.room.message": 0,
          "m.room.encrypted": 50,
          "m.sticker": 50,
          "org.matrix.msc3401.call.member": 0,
        },
        users: { [maker.userId]: 100 },
      },
    },
    maker.accessToken,
  );
  if (room.status !== 200) throw new Error(`cannot create the room: ${JSON.stringify(room)}`);
  return room.json.room_id;
}

/* ------------------------------------------------------------ the app */

/** Where the app is standing: signed out, signed in, a join link or a lobby. */
async function landing(frame, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [where, testid] of [
      ["lobby", "lobby_joinCall"],
      ["join", "joincall_displayName"],
      ["signed-in", "home_callName"],
      ["signed-out", "home_register"],
    ]) {
      if (await frame.getByTestId(testid).count()) return where;
    }
    await frame.page().waitForTimeout(250);
  }
  throw new Error("the call page never offered a way in");
}

/** The stand's Synapse has open registration: make an account and sign in. */
async function signUp(frame) {
  const user = `noise${Math.random().toString(36).slice(2, 8)}`;
  await frame.getByTestId("home_register").click();
  await frame.getByTestId("register_username").fill(user);
  await frame.getByTestId("register_password").fill(PASSWORD);
  await frame.getByTestId("register_confirm_password").fill(PASSWORD);
  await frame.getByTestId("register_register").click();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await frame.getByTestId("home_callName").count()) return user;
    await frame.page().waitForTimeout(250);
  }
  throw new Error(`registration of ${user} did not reach the home screen`);
}

async function signIn(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const where = await landing(page.mainFrame());
  if (where === "signed-out") {
    const user = await signUp(page.mainFrame());
    say("registered", { user });
  }
}

async function joinHere(frame) {
  let where = await landing(frame);
  if (where === "join") {
    await frame.getByTestId("joincall_displayName").fill("NoiseSettings");
    await frame.getByTestId("joincall_joincall").click();
    where = await landing(frame);
  }
  if (where === "lobby") await frame.getByTestId("lobby_joinCall").click({ timeout: 60_000 });
  await frame.getByTestId("incall_leave").waitFor({ timeout: 90_000 });
  return frame.url();
}

async function enterRoom(page, roomUrl, frame = page.mainFrame()) {
  await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
  return joinHere(frame);
}

/** The bridge's own view of the level, plus whatever the old panel would have left. */
async function readState(frame) {
  return frame.evaluate((key) => {
    const bridge = window.__plotinaDfn ?? {};
    const pillText = /^(Noise|Шумодав) · /;
    const pills = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && pillText.test(el.textContent ?? ""),
    ).length;
    return {
      status: bridge.status,
      level: bridge.level,
      applied: bridge.applied,
      bypass: bridge.bypass,
      storage: localStorage.getItem(key),
      panel: !!document.querySelector("#plotina-noise-panel"),
      pills,
      url: location.href,
    };
  }, LEVEL_KEY);
}

/** The "…" settings button: app bar when there is one, the footer otherwise. */
async function openSettings(frame) {
  await frame.page().mouse.move(640, 400);
  await frame.page().mouse.move(660, 420);
  let clicked = false;
  for (const id of ["settings-app-bar", "settings-bottom-left", "settings-bottom-center"]) {
    const button = frame.getByTestId(id).first();
    if ((await button.count()) && (await button.isVisible())) {
      await button.click({ timeout: 30_000 });
      clicked = true;
      say("opened settings with", id);
      break;
    }
  }
  if (!clicked) throw new Error("no settings button is visible in the call view");
  const row = frame.getByTestId(ROW);
  await row.waitFor({ timeout: 30_000 });
  return row;
}

async function rowFacts(row) {
  const text = (await row.innerText()).replace(/\s+/g, " ").trim();
  const thumb = row.getByRole("slider");
  return {
    text,
    valuenow: await thumb.getAttribute("aria-valuenow"),
    disabled: (await thumb.getAttribute("data-disabled")) !== null,
    // The icon must be the compound AudioIcon (an inline SVG), not a glyph.
    iconPath: await row.locator("svg path").first().getAttribute("d"),
    svgCount: await row.locator("svg").count(),
  };
}

/** One arrow-key step on a 0–100 slider with step 1. */
async function nudge(frame, row, steps) {
  const thumb = row.getByRole("slider");
  await thumb.focus();
  for (let i = 0; i < steps; i++) await frame.page().keyboard.press("ArrowRight");
  await frame.page().waitForTimeout(500);
}

const waitAttached = async (frame, timeoutMs = 120_000) => {
  try {
    await frame.waitForFunction(
      () => {
        const b = window.__plotinaDfn;
        return b && (b.status === "attached" || b.status === "error");
      },
      null,
      { timeout: timeoutMs },
    );
  } catch {
    say("attach timeout — bridge state", await readState(frame));
  }
  return readState(frame);
};

/**
 * A headless call sometimes joins without publishing a microphone track, and
 * the bridge only attaches where the microphone is published. Toggling the mic
 * is both the cure and a check: the attach has to survive a republish.
 */
const ensureBridge = async (frame) => {
  let state = await waitAttached(frame, 45_000);
  for (let attempt = 0; attempt < 2 && state.status !== "attached" && state.status !== "error"; attempt++) {
    const mute = frame.getByTestId("incall_mute").first();
    say("microphone toggle", { attempt: attempt + 1, before: state.status });
    if (await mute.count()) {
      await mute.click();
      await frame.page().waitForTimeout(1_200);
      await mute.click();
      await frame.page().waitForTimeout(1_200);
    }
    state = await waitAttached(frame, 45_000);
  }
  return state;
};

/* ------------------------------------------------------------- the run */

const roomId = await ensureRoom();
const roomUrl = `${BASE_URL.replace(/\/$/, "")}/room?roomId=${encodeURIComponent(roomId)}`;
say("room", { roomId, roomUrl });

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  permissions: ["camera", "microphone"],
  viewport: { width: 1280, height: 800 },
});

try {
  const page = await context.newPage();
  await signIn(page);
  const frame = page.mainFrame();
  say("joined", { url: await enterRoom(page, roomUrl) });

  let attached = await ensureBridge(frame);
  if (attached.status !== "attached" && attached.status !== "error") {
    // A headless join that never publishes the microphone: go again once, from
    // a clean navigation, before saying the bridge is unavailable.
    say("rejoining to get a microphone track");
    await enterRoom(page, roomUrl);
    attached = await ensureBridge(frame);
  }
  say("bridge", attached);
  check(
    "the DeepFilterNet3 bridge attached to the microphone",
    attached.status === "attached",
    attached.status,
  );
  check("no floating panel in the call view", !attached.panel && attached.pills === 0, {
    panel: attached.panel,
    pills: attached.pills,
  });
  // The fake camera is a green canvas; stop sending video so the settings
  // modal in the screenshots reads like the real thing.
  const stopVideo = frame.getByTestId("incall_videomute").first();
  if ((await stopVideo.count()) && (await stopVideo.isVisible())) {
    await stopVideo.click();
    await page.waitForTimeout(1_500);
  }
  await page.screenshot({ path: join(OUT, "01-call-view.png") });

  const row = await openSettings(frame);
  const facts = await rowFacts(row);
  say("row", facts);
  check("the Audio tab carries the noise suppression row", /Noise suppression/i.test(facts.text), facts.text);
  check("the row shows the current level in dB", /\b40 dB\b/.test(facts.text), facts.text);
  check(
    "the icon is a compound icon (inline SVG from the EC set)",
    facts.svgCount === 1 && /^M12 3a1 1 0 0 1 1 1v16/.test(facts.iconPath ?? ""),
    { svgCount: facts.svgCount, iconPath: facts.iconPath?.slice(0, 30) },
  );
  check("a slider is offered and it is enabled", facts.valuenow === "40" && !facts.disabled, {
    valuenow: facts.valuenow,
    disabled: facts.disabled,
  });
  await page.screenshot({ path: join(OUT, "02-settings-audio.png") });
  await row.screenshot({ path: join(OUT, "02b-row.png") });

  // The row pushed the speaker and volume sections down; the tab scrolls, and
  // the proof has to show they are still there (not clipped away).
  const speaker = frame.getByText("Speaker", { exact: true }).first();
  await speaker.scrollIntoViewIfNeeded();
  const volume = frame.getByText(/sound effect volume/i).first();
  await volume.scrollIntoViewIfNeeded();
  check(
    "the rest of the Audio tab is still reachable below the row",
    await speaker.isVisible(),
    { speakerVisible: await speaker.isVisible(), volumeVisible: await volume.isVisible() },
  );
  await page.screenshot({ path: join(OUT, "02c-audio-below.png") });
  await row.scrollIntoViewIfNeeded();

  await nudge(frame, row, 5);
  const moved = await rowFacts(row);
  const afterMove = await readState(frame);
  say("after five steps", { moved, afterMove });
  check("the slider moved", moved.valuenow === "45", moved.valuenow);
  check("the row shows the new value", /\b45 dB\b/.test(moved.text), moved.text);
  check(
    "the bridge is running with the new level",
    afterMove.level === 45 && afterMove.applied === 45,
    { level: afterMove.level, applied: afterMove.applied },
  );
  check(`localStorage["${LEVEL_KEY}"] holds the new level`, afterMove.storage === "45", afterMove.storage);
  await page.screenshot({ path: join(OUT, "03-settings-after-move.png") });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const closed = await readState(frame);
  check("the panel is still nowhere with the modal closed", !closed.panel && closed.pills === 0, {
    panel: closed.panel,
    pills: closed.pills,
  });
  await page.screenshot({ path: join(OUT, "04-call-view-after.png") });

  /* -------------------------------------------- the level outlives the call */
  await enterRoom(page, roomUrl);
  const second = await ensureBridge(frame);
  const rowAgain = await openSettings(frame);
  const factsAgain = await rowFacts(rowAgain);
  say("after reload", { second, factsAgain });
  check("the stored level is applied to the next call", second.level === 45, second.level);
  check("the row comes back with the stored level", factsAgain.valuenow === "45", factsAgain.valuenow);
  await page.keyboard.press("Escape");

  /* ------------------------------------------- the embedded (Lite) shape:
     an iframe inside the page, the shape Plotina Lite, Element Web and
     Plotina X give the call. Same browser context, so same session. */
  const embedded = await context.newPage();
  await embedded.goto(`${BASE_URL.replace(/\/$/, "")}/embed.html?room=${encodeURIComponent(roomId)}`, {
    waitUntil: "domcontentloaded",
  });
  const child = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const found = embedded
        .frames()
        .find((f) => f !== embedded.mainFrame() && f.url().startsWith(BASE_URL.replace(/\/$/, "")));
      if (found) return found;
      await embedded.waitForTimeout(250);
    }
    throw new Error("the call iframe never appeared");
  })();
  await joinHere(child);
  const embeddedState = await ensureBridge(child);
  const embeddedRow = await openSettings(child);
  const embeddedFacts = await rowFacts(embeddedRow);
  say("embedded", { embeddedState, embeddedFacts });
  check("the embedded call carries the same row", /Noise suppression/i.test(embeddedFacts.text), embeddedFacts.text);
  check("the embedded call has no floating panel either", !embeddedState.panel && embeddedState.pills === 0, {
    panel: embeddedState.panel,
    pills: embeddedState.pills,
  });

  await nudge(child, embeddedRow, 5);
  const embeddedAfter = await readState(child);
  check(
    "the embedded row reaches the bridge and storage",
    embeddedAfter.level === 50 && embeddedAfter.applied === 50 && embeddedAfter.storage === "50",
    { level: embeddedAfter.level, applied: embeddedAfter.applied, storage: embeddedAfter.storage },
  );
  await embedded.screenshot({ path: join(OUT, "05-embedded-settings.png") });
} catch (e) {
  check("the run finished without an exception", false, String(e));
  process.exitCode = 1;
} finally {
  await browser.close();
}

const failed = evidence.checks.filter((c) => !c.ok);
evidence.finished = new Date().toISOString();
evidence.roomId = roomId;
evidence.passed = evidence.checks.length - failed.length;
evidence.failed = failed.length;
writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(`\n${evidence.passed}/${evidence.checks.length} checks passed`);
if (failed.length) {
  console.log("failed:", failed.map((c) => c.name).join("; "));
  process.exitCode = 1;
}
