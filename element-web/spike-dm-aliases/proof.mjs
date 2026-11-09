#!/usr/bin/env node
/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Reproduce the SPIKE-dm-aliases.md proof on a locally served webapp.

What it does, in one run, against a throwaway homeserver:

  1. clears the alias account data (cc.plotina.room_aliases = {}) so the run
     starts at the stock room name;
  2. logs in as the "owner" account, opens the DM, screenshots the stock
     name, renames it through the overlay's own pencil button + dialog, and
     screenshots the result (room list, header, tab title);
  3. asserts the room's m.room.name state event is still absent over the
     client API — the whole point of the feature;
  4. logs in as a SECOND account in a fresh browser context and asserts it
     still sees the other participant's display name (negative control);
  5. logs in as the owner again in a fresh context and asserts the alias is
     applied from account data with no user action (startup path).

Run (the repo's e2e/ directory already carries Playwright):

    cd element-desktop/.build && python3 -m http.server 8092 --bind 127.0.0.1 &
    NODE_PATH=~/clients/e2e/node_modules node element-web/spike-dm-aliases/proof.mjs \
        --base http://127.0.0.1:8092 \
        --homeserver http://127.0.0.1:8008 \
        --owner alice:alice-spike-pass --other bob:bob-spike-pass \
        --room '!i2kHEuNKioA9a0Xrkn:spike.local' \
        --out /tmp/spike-shots

The homeserver side (two accounts, the DM, its state) is provisioned by the
throwaway continuwuity server described in the notes; this script only drives
the UI and reads the API back.
*/
import fs from "node:fs";
import path from "node:path";

// Playwright is not a dependency of this repository (element-web ships no
// node_modules); point PLAYWRIGHT_MODULE at an installed copy when the default
// resolution fails, e.g.
//   PLAYWRIGHT_MODULE=file:///path/to/e2e/node_modules/playwright/index.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

function arg(name, fallback = "") {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = arg("base", "http://127.0.0.1:8092");
const HS = arg("homeserver", "http://127.0.0.1:8008");
const [OWNER_USER, OWNER_PASS] = arg("owner", "alice:alice-spike-pass").split(":");
const [OTHER_USER, OTHER_PASS] = arg("other", "bob:bob-spike-pass").split(":");
const ROOM = arg("room", "");
const GROUP = arg("group", "");
const EXPECT_OPAQUE = arg("expect-opaque", "") !== "";
const OUT = arg("out", "/tmp/spike-shots");
const ALIAS = arg("alias", "Денчик");
const ACCOUNT_DATA = "cc.plotina.room_aliases";

fs.mkdirSync(OUT, { recursive: true });
const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
}

async function api(pathname, token, method = "GET", body) {
  const res = await fetch(HS + pathname, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function login(page, user, pass) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mx_LoginForm_username, a:has-text('Войти'), button:has-text('Войти')", { timeout: 60000 });
  if (!(await page.$("#mx_LoginForm_username"))) {
    await page.click("a:has-text('Войти'), button:has-text('Войти')");
    await page.waitForSelector("#mx_LoginForm_username", { timeout: 30000 });
  }
  await page.fill("#mx_LoginForm_username", user);
  await page.fill("#mx_LoginForm_password", pass);
  await page.press("#mx_LoginForm_password", "Enter");
  // Login lands behind device-verification / backup prompts; drain them while
  // waiting for the app shell, instead of waiting on a selector the dialog
  // hides.
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate(() =>
      !!(document.querySelector(".mx_RoomListPanel, .mx_LeftPanel, .mx_RoomHeader") ||
         (window.mxMatrixClientPeg && window.mxMatrixClientPeg.get())));
    if (ready) break;
    await dismissNotices(page);
    await page.waitForTimeout(1000);
  }
  if (!ready) {
    await page.screenshot({ path: path.join(OUT, "login-failed.png") }).catch(() => {});
    console.error("login did not reach the app; body:", (await page.textContent("body").catch(() => "")).slice(0, 400));
    throw new Error("login stuck");
  }
  await dismissNotices(page);
}

async function dismissNotices(page) {
  // Device-verification / backup prompts; harmless to dismiss for the probe.
  for (const label of ["Позже", "Закрыть", "Продолжить", "Не сейчас"]) {
    for (let i = 0; i < 3; i++) {
      const el = await page.$(`button:has-text("${label}"), span:has-text("${label}")`);
      if (!el) break;
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function openRoom(page, roomId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // The device-verification prompt can land after the first sync, i.e.
    // after login() already drained the earlier ones; keep draining.
    await dismissNotices(page);
    await page.evaluate((id) => { location.hash = "#/home"; }, roomId);
    await page.waitForTimeout(1000);
    await page.evaluate((id) => { location.hash = "#/room/" + id; }, roomId);
    try {
      await page.waitForSelector(".mx_RoomHeader_heading", { timeout: 25000 });
      await dismissNotices(page);
      await page.waitForTimeout(1500);
      return page.textContent(".mx_RoomHeader_heading");
    } catch (err) {
      if (attempt === 5) {
        await page.screenshot({ path: path.join(OUT, "room-open-failed.png") }).catch(() => {});
        throw err;
      }
      await page.waitForTimeout(4000);
    }
  }
  return null;
}

async function roomListNames(page) {
  return page.$$eval("[class*='_roomName_']", (els) => els.map((e) => e.textContent.trim()));
}

async function clientName(page, roomId) {
  return page.evaluate((id) => {
    const c = window.mxMatrixClientPeg && window.mxMatrixClientPeg.get();
    const r = c && c.getRoom(id);
    return r ? r.name : null;
  }, roomId);
}

async function aliases(page) {
  return page.evaluate(() => (window.plotinaDmAliases ? window.plotinaDmAliases.aliases() : null));
}

async function shot(page, name) {
  return page.screenshot({ path: path.join(OUT, name) });
}

/** API evidence for the report: room state before/after + account data. */
async function apiDump(base, name) {
  const room = encodeURIComponent(base.roomId);
  const user = encodeURIComponent(base.userId);
  const stateName = await api(`/_matrix/client/v3/rooms/${room}/state/m.room.name`, base.token);
  const stateAll = await api(`/_matrix/client/v3/rooms/${room}/state`, base.token);
  const create = await api(`/_matrix/client/v3/rooms/${room}/state/m.room.create`, base.token);
  const accountData = await api(`/_matrix/client/v3/user/${user}/account_data/${ACCOUNT_DATA}`, base.token);
  const dump = {
    at: new Date().toISOString(),
    room_id: base.roomId,
    room_version: (create.json || {}).room_version,
    id_has_server_part: base.roomId.includes(":"),
    state_m_room_name: { status: stateName.status, body: stateName.json },
    state_event_types: ((stateAll.json || []).map((e) => e.type)).sort(),
    state_event_count: (stateAll.json || []).length,
    account_data_cc_plotina_room_aliases: { status: accountData.status, body: accountData.json },
  };
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(dump, null, 2) + "\n");
  return dump;
}

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  // Owner session: obtain a token for the API reads, then reset the alias.
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  // Console noise from the overlay itself must be empty on a working room;
  // Element logs unrelated errors, so only overlay/page errors are asserted.
  const consoleIssues = [];
  owner.on("console", (msg) => {
    if (msg.type() === "error") consoleIssues.push(msg.text());
  });
  owner.on("pageerror", (err) => consoleIssues.push("pageerror: " + err.message));
  await login(owner, OWNER_USER, OWNER_PASS);
  const token = await owner.evaluate(() => window.mxMatrixClientPeg.get().getAccessToken());
  const userId = await owner.evaluate(() => window.mxMatrixClientPeg.get().getUserId());
  await api(`/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA}`,
    token, "PUT", {});
  await owner.reload({ waitUntil: "domcontentloaded" });
  await dismissNotices(owner);
  await owner.waitForTimeout(2000);

  const roomId = ROOM || (await owner.evaluate(() => {
    const c = window.mxMatrixClientPeg.get();
    const rooms = c.getRooms();
    return rooms.length ? rooms[0].roomId : null;
  }));
  if (!roomId) throw new Error("no room to work with");

  // The QA defect was room-version specific: v12 ids carry no server part.
  const idShape = roomId.includes(":") ? "v<=11 !localpart:server" : "v12 opaque";
  console.log(`INFO room id: ${roomId} (${idShape})`);
  if (EXPECT_OPAQUE) {
    record("room id is an opaque v12 id (no server part)", !roomId.includes(":"), roomId);
  }
  await openRoom(owner, roomId);
  const direct = await owner.evaluate(([id]) => window.plotinaDmAliases.isDirect(id), [roomId]);
  record("room is recognised as a DM from room data, not from the id shape",
    direct === true, `isDirect(${roomId})=${direct}`);

  const beforeHeader = await openRoom(owner, roomId);
  const apiBase = { roomId, userId, token };
  const apiBefore = await apiDump(apiBase, "api-before.json");
  console.log(`INFO before: room v${apiBefore.room_version} state events=${apiBefore.state_event_count} ` +
    `m.room.name=${apiBefore.state_m_room_name.status} account_data=` +
    `${JSON.stringify(apiBefore.account_data_cc_plotina_room_aliases.body)}`);
  const beforeName = await clientName(owner, roomId);
  const beforeAliases = await aliases(owner);
  await shot(owner, "01-before-alias.png");
  record("stock name before rename", beforeHeader !== null && !Object.keys(beforeAliases || {}).includes(roomId),
    `header=${JSON.stringify(beforeHeader)} room.name=${JSON.stringify(beforeName)} aliases=${JSON.stringify(beforeAliases)}`);

  // Rename through the overlay's own UI: pencil in the header -> dialog.
  // Clicked through the DOM: Element sometimes leaves a floating-ui popover
  // over the header, which would swallow a synthetic mouse click.
  await owner.keyboard.press("Escape");
  await owner.$eval(".plotina-alias-btn", (el) => el.click());
  await owner.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await shot(owner, "02-dialog.png");
  await owner.fill("#plotina-dm-alias-dialog input", ALIAS);
  await owner.$eval('#plotina-dm-alias-dialog [data-role=save]', (el) => el.click());
  await owner.waitForTimeout(2500);

  const afterHeader = await owner.textContent(".mx_RoomHeader_heading");
  const afterName = await clientName(owner, roomId);
  const listNames = await roomListNames(owner);
  const afterAliases = await aliases(owner);
  await shot(owner, "03-after-alias.png");
  record("header takes the alias", afterHeader.trim() === ALIAS, `header=${JSON.stringify(afterHeader.trim())}`);
  record("room list takes the alias", listNames.includes(ALIAS), `list=${JSON.stringify(listNames)}`);
  record("Room.name takes the alias", afterName === ALIAS, `room.name=${JSON.stringify(afterName)}`);
  record("advertised alias map", afterAliases && afterAliases[roomId] === ALIAS, JSON.stringify(afterAliases));

  // Informational: the tab title is updated by matrix-react-sdk's page-title
  // updater on room switches, not on Room.name, so it lags behind the header.
  // Recorded rather than asserted: the required surfaces are list + header.
  const titleNow = await owner.title();
  await owner.waitForTimeout(8000);
  const titleLater = await owner.title();
  await owner.evaluate(() => { location.hash = "#/home"; });
  await owner.waitForTimeout(1500);
  await owner.evaluate((id) => { location.hash = "#/room/" + id; }, roomId);
  await owner.waitForTimeout(1500);
  const titleAfterSwitch = await owner.title();
  console.log(`INFO tab title: after rename=${JSON.stringify(titleNow)} ` +
    `after 8s=${JSON.stringify(titleLater)} after a room switch=${JSON.stringify(titleAfterSwitch)}`);

  // The room settings form is state-driven (RoomProfileSettings reads the
  // m.room.name event, not Room.name), so the alias can never be written back
  // into the room by a "Save" there. Source-verified, recorded here for readers.
  console.log("INFO room settings name field reads m.room.name state: unaffected by the alias");

  // The room state must be untouched: no m.room.name event at all.
  const stateName = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, token);
  const accountData = await api(`/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA}`, token);
  record("m.room.name still absent", stateName.status === 404,
    `HTTP ${stateName.status} ${JSON.stringify(stateName.json).slice(0, 160)}`);
  record("alias lives in account data", accountData.status === 200 && accountData.json[roomId] === ALIAS,
    JSON.stringify(accountData.json));
  const apiAfter = await apiDump(apiBase, "api-after-rename.json");
  console.log(`INFO after rename: m.room.name=${apiAfter.state_m_room_name.status} ` +
    `state events=${apiAfter.state_event_count} account_data=` +
    `${JSON.stringify(apiAfter.account_data_cc_plotina_room_aliases.body)}`);

  // Negative control: the other account, fresh context and fresh device.
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await login(other, OTHER_USER, OTHER_PASS);
  // Start from a clean slate for the other account too: a previous run may
  // have left its own alias behind, and the control is "sees the stock name".
  const otherToken0 = await other.evaluate(() => window.mxMatrixClientPeg.get().getAccessToken());
  const otherUserId0 = await other.evaluate(() => window.mxMatrixClientPeg.get().getUserId());
  await api(`/_matrix/client/v3/user/${encodeURIComponent(otherUserId0)}/account_data/${ACCOUNT_DATA}`,
    otherToken0, "PUT", {});
  await other.reload({ waitUntil: "domcontentloaded" });
  await dismissNotices(other);
  await other.waitForTimeout(3000);
  const otherHeader = await openRoom(other, roomId);
  const otherAliases = await aliases(other);
  const otherName = await clientName(other, roomId);
  await shot(other, "04-second-account.png");
  record("second account does not see the alias",
    otherHeader.trim() !== ALIAS && (otherAliases === null || !(roomId in otherAliases)),
    `header=${JSON.stringify(otherHeader.trim())} room.name=${JSON.stringify(otherName)} aliases=${JSON.stringify(otherAliases)}`);

  // Isolation both ways: the other account renames the same room for itself
  // and the owner's view must not move.
  const otherToken = await other.evaluate(() => window.mxMatrixClientPeg.get().getAccessToken());
  const otherUserId = await other.evaluate(() => window.mxMatrixClientPeg.get().getUserId());
  const otherLabel = "Алиса-для-Боба";
  await other.evaluate(([id, label]) => window.plotinaDmAliases.setAlias(id, label), [roomId, otherLabel]);
  await other.waitForTimeout(2500);
  const otherHeader2 = (await other.textContent(".mx_RoomHeader_heading")).trim();
  const otherData = await api(
    `/_matrix/client/v3/user/${encodeURIComponent(otherUserId)}/account_data/${ACCOUNT_DATA}`, otherToken);
  const ownerNameAfterOther = await clientName(owner, roomId);
  await shot(other, "06-second-account-own-alias.png");
  record("alias is per account, both directions",
    otherHeader2 === otherLabel && otherData.json[roomId] === otherLabel && ownerNameAfterOther === ALIAS,
    `other header=${JSON.stringify(otherHeader2)} other account_data=${JSON.stringify(otherData.json)} ` +
    `owner room.name=${JSON.stringify(ownerNameAfterOther)}`);

  // Startup path: a new owner device reads the alias from account data.
  const restartCtx = await browser.newContext();
  const restart = await restartCtx.newPage();
  await login(restart, OWNER_USER, OWNER_PASS);
  // Wait for the overlay to attach before reading its map: on a slow first
  // sync `plotinaDmAliases` exists but has not read account data yet.
  await restart.waitForFunction(
    () => window.plotinaDmAliases && window.plotinaDmAliases.ready(),
    null, { timeout: 90000 }).catch(() => {});
  const startAliases = await aliases(restart);
  const startHeader = await openRoom(restart, roomId);
  await shot(restart, "05-restart-fresh-device.png");
  record("alias applied at startup without action",
    startAliases && startAliases[roomId] === ALIAS && startHeader.trim() === ALIAS,
    `aliases=${JSON.stringify(startAliases)} header=${JSON.stringify(startHeader.trim())}`);

  // FINDING-2: a group room must not be renamable for one account, and must
  // not carry the pencil at all.
  if (GROUP) {
    const groupHeader = await openRoom(owner, GROUP);
    const pencil = await owner.$(".plotina-alias-btn");
    record("no alias UI on a group room", !pencil, `header=${JSON.stringify(groupHeader)}`);
    const refused = await owner.evaluate(async ([id]) => {
      try {
        await window.plotinaDmAliases.setAlias(id, "Группа-для-меня");
        return null;
      } catch (err) {
        return err.code || err.message;
      }
    }, [GROUP]);
    const banner = await owner.$eval("#plotina-dm-alias-error", (el) => el.textContent)
      .catch(() => "");
    const groupData = await api(
      `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA}`, token);
    await shot(owner, "07-group-room-refused.png");
    record("group alias is refused with a coded error and a visible message",
      refused === "not_direct" && banner.length > 0 && !(GROUP in groupData.json),
      `error=${JSON.stringify(refused)} banner=${JSON.stringify(banner.slice(0, 120))} ` +
      `account_data=${JSON.stringify(groupData.json)}`);
  }

  // A malformed id must never be a silent no-op (the other half of DEFECT-1).
  const invalid = await owner.evaluate(async () => {
    if (!window.plotinaDmAliases) return "no-overlay";
    try {
      await window.plotinaDmAliases.setAlias("not a room id", "x");
      return null;
    } catch (err) {
      return err.code || err.message;
    }
  });
  const invalidBanner = await owner.$eval("#plotina-dm-alias-error", (el) => el.textContent)
    .catch(() => "");
  await shot(owner, "08-invalid-id-refused.png");
  record("invalid room id is refused visibly",
    invalid === "invalid_room_id" && invalidBanner.length > 0,
    `error=${JSON.stringify(invalid)} banner=${JSON.stringify(invalidBanner.slice(0, 120))}`);

  // Reset through the overlay's own button: back to the stock name, and the
  // stored map is {} with no empty values (FINDING-3).
  await openRoom(owner, roomId);
  await owner.keyboard.press("Escape");
  await owner.$eval(".plotina-alias-btn", (el) => el.click());
  await owner.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await owner.$eval('#plotina-dm-alias-dialog [data-role=reset]', (el) => el.click());
  await owner.waitForTimeout(2500);
  const resetHeader = (await owner.textContent(".mx_RoomHeader_heading") || "").trim();
  const resetName = await clientName(owner, roomId);
  const resetData = await api(
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA}`, token);
  await shot(owner, "09-after-reset.png");
  const resetValues = Object.values(resetData.json || {}).map((v) => String(v));
  record("reset restores the stock name", resetHeader !== ALIAS && resetName !== ALIAS,
    `header=${JSON.stringify(resetHeader)} room.name=${JSON.stringify(resetName)}`);
  record("reset leaves an empty map with no empty values",
    resetData.status === 200 && Object.keys(resetData.json || {}).length === 0 &&
    resetValues.every((v) => v.trim() !== ""),
    `HTTP ${resetData.status} ${JSON.stringify(resetData.json)}`);
  const apiReset = await apiDump(apiBase, "api-after-reset.json");
  console.log(`INFO after reset: m.room.name=${apiReset.state_m_room_name.status} ` +
    `state events=${apiReset.state_event_count} account_data=` +
    `${JSON.stringify(apiReset.account_data_cc_plotina_room_aliases.body)}`);

  const overlayErrors = consoleIssues.filter((line) =>
    line.includes("plotina-dm-aliases") || line.startsWith("pageerror:"));
  // The raw client log for the report: every console error the page produced.
  fs.writeFileSync(path.join(OUT, "client-log.txt"),
    (consoleIssues.length ? consoleIssues.join("\n") : "(no console errors)") + "\n");
  record("no page errors and no overlay errors in the client log", overlayErrors.length === 0,
    overlayErrors.length ? JSON.stringify(overlayErrors) : `0 of ${consoleIssues.length} console errors mention the overlay`);

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("proof failed:", err);
  process.exit(2);
});