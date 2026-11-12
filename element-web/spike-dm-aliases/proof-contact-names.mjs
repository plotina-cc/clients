#!/usr/bin/env node
/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

End-to-end proof of the CONTACT-name model on a real homeserver.

What changed in this task, and what this script therefore has to show:

  * the personal name lives in account data cc.plotina.contact_names, keyed by
    the contact's MXID (not by room id);
  * two different DMs with the same person get the name from ONE entry, and a
    rename in either room is visible in both;
  * a group room that contains that person is NOT renamed, but the person is:
    the name shows on their author line and in the member list, while the
    group's own title and every other member keep theirs (owner decision,
    plan §6 "name in groups");
  * the rename is live: room list, header, author line under the message and
    the message preview in the room list, without a reload;
  * reset removes the key (the event body becomes {}) and the real display
    name comes back everywhere;
  * m.room.name and m.room.member stay absent/untouched, and the only write
    that leaves the client is a PUT of the contact map;
  * the legacy room-keyed event (cc.plotina.room_aliases) is neither read nor
    migrated.

Run against a throwaway Synapse with three accounts and three rooms (two DMs
with the same pair, one group). See provision.py in this directory's report,
or bake your own:

    python3 -m http.server 8071 --bind 127.0.0.1 --directory <webapp> &
    PLAYWRIGHT_MODULE=file:///path/to/e2e/node_modules/playwright/index.mjs \
    NODE_PATH=/path/to/e2e/node_modules node element-web/spike-dm-aliases/proof-contact-names.mjs \
      --base http://127.0.0.1:8071 --homeserver http://127.0.0.1:18019 \
      --stand /path/to/stand.json --out /tmp/contacts-shots
*/
import fs from "node:fs";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

function arg(name, fallback = "") {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = arg("base", "http://127.0.0.1:8071");
const HS = arg("homeserver", "http://127.0.0.1:18019");
const STAND = JSON.parse(fs.readFileSync(arg("stand", ""), "utf8"));
const OUT = arg("out", "/tmp/contacts-shots");
const NAME = arg("name", "Денчик");
const ACCOUNT_DATA = "cc.plotina.contact_names";
const LEGACY = "cc.plotina.room_aliases";

const OWNER = STAND.accounts.alice;
const OTHER = STAND.accounts.bob;
const DM1 = STAND.dm1;
const DM2 = STAND.dm2;
const GROUP = STAND.group;
const BOB = OTHER.user_id;

fs.mkdirSync(OUT, { recursive: true });
const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
}
function info(text) {
  console.log("INFO " + text);
}

async function api(pathname, token, method = "GET", body) {
  const res = await fetch(HS + pathname, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

async function dismissNotices(page) {
  for (const label of ["Позже", "Закрыть", "Продолжить", "Не сейчас", "Continue", "Not now"]) {
    for (let i = 0; i < 3; i++) {
      const el = await page.$(`button:has-text("${label}"), span:has-text("${label}")`);
      if (!el) break;
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

async function login(page, account) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mx_LoginForm_username, a:has-text('Войти'), button:has-text('Войти')", { timeout: 60000 });
  if (!(await page.$("#mx_LoginForm_username"))) {
    await page.click("a:has-text('Войти'), button:has-text('Войти')");
    await page.waitForSelector("#mx_LoginForm_username", { timeout: 30000 });
  }
  await page.fill("#mx_LoginForm_username", account.user_id);
  await page.fill("#mx_LoginForm_password", account.password);
  await page.press("#mx_LoginForm_password", "Enter");
  const deadline = Date.now() + 120000;
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
    throw new Error("login stuck");
  }
  await dismissNotices(page);
  // Wait until the overlay has attached AND read the account data, so its map
  // is the truth on screen rather than an empty startup value.
  await page.waitForFunction(
    () => window.plotinaDmAliases && window.plotinaDmAliases.ready(),
    null, { timeout: 90000 }).catch(() => {});
}

async function openRoom(page, roomId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await dismissNotices(page);
    await page.evaluate(() => { location.hash = "#/home"; });
    await page.waitForTimeout(900);
    await page.evaluate((id) => { location.hash = "#/room/" + id; }, roomId);
    try {
      await page.waitForSelector(".mx_RoomHeader_heading", { timeout: 30000 });
      await dismissNotices(page);
      await page.waitForTimeout(1500);
      return (await page.textContent(".mx_RoomHeader_heading")).trim();
    } catch (err) {
      if (attempt === 5) throw err;
      await page.waitForTimeout(4000);
    }
  }
  return null;
}

const clientName = (page, roomId) => page.evaluate((id) => {
  const c = window.mxMatrixClientPeg && window.mxMatrixClientPeg.get();
  const room = c && c.getRoom(id);
  return room ? room.name : null;
}, roomId);

const partnerOf = (page, roomId) => page.evaluate((id) =>
  window.plotinaDmAliases.partnerOf(id), roomId);

const names = (page) => page.evaluate(() => window.plotinaDmAliases.names());

async function roomListNames(page) {
  return page.$$eval("[class*='_roomName_']", (els) => els.map((e) => e.textContent.trim()));
}

/**
 * The author names under the messages in the open room.
 *
 * A 1:1 chat in the bubble layout hides the sender of its own messages, so
 * only the other person's tiles carry a profile. The profile is rendered by
 * mx_DisambiguatedProfile; older layouts used mx_SenderProfile.
 */
async function authorLines(page) {
  return page.$$eval(
    ".mx_EventTile .mx_DisambiguatedProfile, .mx_EventTile .mx_SenderProfile",
    (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
}

/**
 * The message-preview line of every room-list tile, paired with the tile's
 * room name. Tiles carry no room id in the DOM, but the pair is enough: the
 * assertion is "the DM's preview shows the personal name", and the name
 * distinguishes the rows.
 */
async function roomListRows(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll(".mx_RoomListItemView")).map((tile) => {
    const leaves = Array.from(tile.querySelectorAll("*"))
      .filter((e) => e.children.length === 0 && e.textContent.trim())
      .map((e) => e.textContent.trim());
    const nameNode = tile.querySelector("[data-testid='room-name']");
    return {
      name: nameNode ? nameNode.textContent.trim() : (leaves[1] || ""),
      // The avatar initial comes first, then the room name, then the preview.
      preview: leaves.length > 2 ? leaves.slice(2).join(" ") : null,
    };
  }));
}

/** Turn the room-list message preview on, so its text can be asserted. */
async function enableMessagePreviews(context) {
  await context.addInitScript(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("mx_local_settings") || "{}");
      raw["RoomList.showMessagePreview"] = true;
      localStorage.setItem("mx_local_settings", JSON.stringify(raw));
    } catch (e) {
      /* first run: no settings yet */
    }
  });
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

async function userAccountData(userId) {
  return api(`/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA}`, OWNER.token);
}

async function roomState(roomId) {
  const name = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, OWNER.token);
  const all = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`, OWNER.token);
  const create = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create`, OWNER.token);
  return {
    nameStatus: name.status,
    count: (all.json || []).length,
    types: ((all.json || []).map((e) => e.type)).sort(),
    version: (create.json || {}).room_version,
  };
}

/** Network trace: every request the page makes during one rename. */
function watchNetwork(page, sink) {
  const handler = (req) => {
    if (!req.url().startsWith(HS)) return;
    const method = req.method();
    if (method === "GET" || method === "OPTIONS") return;
    sink.push({ method, url: req.url().replace(HS, "") });
  };
  page.on("request", handler);
  return () => page.off("request", handler);
}

async function main() {
  // PLAYWRIGHT_CHROMIUM lets a machine without Playwright's downloaded bundle
  // use the system Chromium; CI keeps the default.
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });

  // ---------------------------------------------------------------- owner
  const ownerCtx = await browser.newContext();
  await enableMessagePreviews(ownerCtx);
  const owner = await ownerCtx.newPage();
  const consoleIssues = [];
  owner.on("console", (msg) => { if (msg.type() === "error") consoleIssues.push(msg.text()); });
  owner.on("pageerror", (err) => consoleIssues.push("pageerror: " + err.message));

  // Start from a clean slate for this account: an earlier run may have left a
  // name, the legacy map or a status behind.
  await api(`/_matrix/client/v3/user/${encodeURIComponent(OWNER.user_id)}/account_data/${ACCOUNT_DATA}`,
    OWNER.token, "PUT", {});
  await api(`/_matrix/client/v3/user/${encodeURIComponent(OWNER.user_id)}/account_data/${LEGACY}`,
    OWNER.token, "PUT", { [DM1]: "Старое-комнатное-имя" });

  await login(owner, OWNER);
  await api(`/_matrix/client/v3/user/${encodeURIComponent(OWNER.user_id)}/account_data/${ACCOUNT_DATA}`,
    OWNER.token, "PUT", {});
  await owner.reload({ waitUntil: "domcontentloaded" });
  await dismissNotices(owner);
  await owner.waitForFunction(() => window.plotinaDmAliases && window.plotinaDmAliases.ready(),
    null, { timeout: 90000 }).catch(() => {});
  await owner.waitForTimeout(2500);

  // The three rooms exist and are opaque v12 ids.
  for (const [label, roomId] of [["dm1", DM1], ["dm2", DM2], ["group", GROUP]]) {
    const state = await roomState(roomId);
    info(`${label}: ${roomId} v${state.version} opaque=${!roomId.includes(":")} state=${state.count} m.room.name=${state.nameStatus}`);
    if (label !== "group") {
      record(`${label} is an opaque v12 id`, !roomId.includes(":") && state.version === "12", roomId);
    }
  }
  const state1Before = await roomState(DM1);
  record("the DM carries no m.room.name before the rename (its title is the person)",
    state1Before.nameStatus === 404,
    `HTTP ${state1Before.nameStatus} types=${JSON.stringify(state1Before.types)}`);

  // Both DMs resolve to the SAME contact.
  const p1 = await partnerOf(owner, DM1);
  const p2 = await partnerOf(owner, DM2);
  record("both DMs resolve to the same contact (mxid, not room)",
    p1 === BOB && p2 === BOB, `partnerOf(dm1)=${p1} partnerOf(dm2)=${p2} expected=${BOB}`);

  // The legacy room-keyed event must not be applied.
  const legacyHeader = await openRoom(owner, DM1);
  record("the legacy room-keyed map is not read",
    (await names(owner)) !== null && !("Старое-комнатное-имя" in Object.values(await names(owner))),
    `header=${JSON.stringify(legacyHeader)} names=${JSON.stringify(await names(owner))}`);

  await openRoom(owner, DM1);
  const beforeHeader = (await owner.textContent(".mx_RoomHeader_heading")).trim();
  const beforeAuthor = await authorLines(owner);
  await shot(owner, "01-before.png");
  record("stock name before the rename",
    beforeHeader === "Даниил" && beforeAuthor.some((t) => t.includes("Даниил")),
    `header=${JSON.stringify(beforeHeader)} authors=${JSON.stringify(beforeAuthor.slice(0, 3))}`);

  // ------------------------------------------------- rename through the UI
  const writes = [];
  const stopWatching = watchNetwork(owner, writes);
  await owner.keyboard.press("Escape");
  await owner.$eval(".plotina-alias-btn", (el) => el.click());
  await owner.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await shot(owner, "02-dialog.png");
  await owner.fill("#plotina-dm-alias-dialog input", NAME);
  await owner.$eval('#plotina-dm-alias-dialog [data-role=save]', (el) => el.click());
  await owner.waitForTimeout(3000);
  stopWatching();

  const afterHeader = (await owner.textContent(".mx_RoomHeader_heading")).trim();
  const afterName = await clientName(owner, DM1);
  const listAfter = await roomListNames(owner);
  const authorsAfter = await authorLines(owner);
  const map = await userAccountData(OWNER.user_id);
  await shot(owner, "03-renamed-dm1.png");

  record("header takes the contact name live", afterHeader === NAME, `header=${JSON.stringify(afterHeader)}`);
  record("Room.name takes the contact name live", afterName === NAME, `room.name=${JSON.stringify(afterName)}`);
  record("room list takes the contact name live", listAfter.includes(NAME), `list=${JSON.stringify(listAfter)}`);
  record("author line takes the contact name live",
    authorsAfter.some((t) => t.includes(NAME)),
    `authors=${JSON.stringify(authorsAfter.slice(0, 4))}`);

  // The preview: in a 1:1 chat Element prefixes the preview with the sender's
  // name, so the room-list line has to follow the rename too. Post a fresh
  // message from the contact through the API (the last local message is
  // alice's own, and Element prefixes only the OTHER person's) and assert the
  // preview carries the personal name — no hardcoded stand text.
  const previewText = "проверка превью";
  for (const rid of [DM1, DM2]) {
    await api(`/_matrix/client/v3/rooms/${encodeURIComponent(rid)}/send/m.room.message/${Date.now()}`,
      OTHER.token, "PUT", { msgtype: "m.text", body: previewText });
  }
  await owner.waitForTimeout(4000);
  const rows = await roomListRows(owner);
  const dmRows = rows.filter((r) => r.name === NAME);
  info(`room-list rows: ${JSON.stringify(rows)}`);
  record("the room-list preview follows the rename",
    dmRows.length >= 1 && dmRows.every((r) => r.preview && r.preview.startsWith(NAME + ":")),
    JSON.stringify(dmRows));

  record("the name is stored under the contact's mxid",
    map.status === 200 && map.json[BOB] === NAME,
    `HTTP ${map.status} ${JSON.stringify(map.json)}`);

  record("only a PUT of the contact map left the client",
    writes.length === 1 && writes[0].method === "PUT" &&
      writes[0].url.includes(`/account_data/${ACCOUNT_DATA}`),
    JSON.stringify(writes));

  // The room state must be untouched: no m.room.name event at all, and the
  // state event count is the same as it was before the rename.
  const stateBefore = state1Before;
  const state1 = await roomState(DM1);
  record("m.room.name was not written and the room state did not grow",
    state1.nameStatus === 404 && state1.count === stateBefore.count &&
      JSON.stringify(state1.types) === JSON.stringify(stateBefore.types),
    `m.room.name=${state1.nameStatus} state ${stateBefore.count}->${state1.count} ` +
    `types=${JSON.stringify(state1.types)}`);

  // ------------------------------------------- the same person, the other DM
  const dm2Header = await openRoom(owner, DM2);
  const dm2Name = await clientName(owner, DM2);
  const dm2Authors = await authorLines(owner);
  await shot(owner, "04-second-dm.png");
  record("the second DM with the same person shows the same name",
    dm2Header === NAME && dm2Name === NAME && dm2Authors.some((t) => t.includes(NAME)),
    `header=${JSON.stringify(dm2Header)} room.name=${JSON.stringify(dm2Name)} ` +
    `authors=${JSON.stringify(dm2Authors.slice(0, 3))}`);

  // A rename in the SECOND DM must move the first one too, live.
  const rewrites = [];
  const stopSecond = watchNetwork(owner, rewrites);
  await owner.keyboard.press("Escape");
  await owner.$eval(".plotina-alias-btn", (el) => el.click());
  await owner.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await owner.fill("#plotina-dm-alias-dialog input", NAME + "-2");
  await owner.$eval('#plotina-dm-alias-dialog [data-role=save]', (el) => el.click());
  await owner.waitForTimeout(2500);
  stopSecond();
  const mapAfterSecond = await userAccountData(OWNER.user_id);
  record("a rename in the second DM keeps ONE entry per person",
    mapAfterSecond.json[BOB] === NAME + "-2" && Object.keys(mapAfterSecond.json).length === 1,
    JSON.stringify(mapAfterSecond.json));
  const dm2After = (await owner.textContent(".mx_RoomHeader_heading")).trim();
  record("the second DM shows its own new name", dm2After === NAME + "-2", `header=${JSON.stringify(dm2After)}`);
  const dm1After = await openRoom(owner, DM1);
  record("the first DM follows the rename made in the second",
    dm1After === NAME + "-2", `dm1 header=${JSON.stringify(dm1After)}`);
  await shot(owner, "05-both-dms.png");

  // ------------------------------------------------- name in a group room
  // The room is not renamed, but the person is. The group's own title stays
  // "QA Группа" (no m.room.name write, no local override), the pencil is absent
  // (a group cannot be named), and yet the contact's author line carries the
  // personal name — the same name as in the DM.
  const groupHeader = await openRoom(owner, GROUP);
  const pencil = await owner.$(".plotina-alias-btn");
  const groupAuthors = await authorLines(owner);
  await shot(owner, "06-group-name-of-person.png");
  record("no pencil on a group room (a group is not renamed)",
    !pencil && groupHeader === "QA Группа", `header=${JSON.stringify(groupHeader)} pencil=${!!pencil}`);
  record("the group's own title is not masked by the contact name",
    !groupHeader.includes(NAME), `header=${JSON.stringify(groupHeader)}`);
  record("the contact's author line in the group carries the personal name",
    groupAuthors.some((t) => t.includes(NAME)),
    `authors=${JSON.stringify(groupAuthors.slice(0, 6))} expected to contain ${JSON.stringify(NAME)}`);
  record("the group room's nameForRoom is still null (room not renamed)",
    (await owner.evaluate((id) => window.plotinaDmAliases.nameForRoom(id), GROUP)) === null,
    `nameForRoom(group)=${JSON.stringify(await owner.evaluate((id) => window.plotinaDmAliases.nameForRoom(id), GROUP))}`);
  // The member list is the surface the owner named explicitly ("в списке
  // участников"). Open the roster and read what it renders, not just the model.
  const roster = await owner.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button,[role='button']"));
    for (const b of btns) {
      const label = (b.getAttribute("aria-label") || "") + " " + (b.className || "");
      if (/member|people|частник/i.test(label)) { b.click(); return label; }
    }
    return null;
  });
  await owner.waitForTimeout(3500);
  const rosterNames = await owner.evaluate(() => {
    const panel = document.querySelector(".mx_RightPanel, .mx_MemberList, [class*='MemberList']");
    if (!panel) return null;
    return Array.from(panel.querySelectorAll("*"))
      .filter((e) => e.children.length === 0 && e.textContent.trim())
      .map((e) => e.textContent.trim());
  });
  await shot(owner, "06b-member-list-group.png");
  record("the group's member list shows the personal name for that person",
    Array.isArray(rosterNames) && rosterNames.includes(NAME + "-2"),
    `roster=${JSON.stringify(rosterNames && rosterNames.slice(0, 12))} clicked=${JSON.stringify(roster)}`);
  record("...and keeps every other member's own name",
    Array.isArray(rosterNames) && rosterNames.includes("QA") && rosterNames.includes("Алиса"),
    `roster=${JSON.stringify(rosterNames && rosterNames.slice(0, 12))}`);
  await owner.keyboard.press("Escape");
  await owner.waitForTimeout(500);
  const groupRefused = await owner.evaluate(async (id) => {
    try {
      await window.plotinaDmAliases.setName(id, "Группа-для-меня");
      return null;
    } catch (err) {
      return err.code || err.message;
    }
  }, GROUP);
  record("a group room cannot be given a contact name", groupRefused === "not_direct",
    `error=${JSON.stringify(groupRefused)}`);
  const mapGroup = await userAccountData(OWNER.user_id);
  record("the refused group write changed no account data",
    mapGroup.json[BOB] === NAME + "-2" && !("Группа-для-меня" in Object.values(mapGroup.json)),
    JSON.stringify(mapGroup.json));

  // ------------------------------------------------------------- reset
  await openRoom(owner, DM1);
  const resets = [];
  const stopReset = watchNetwork(owner, resets);
  await owner.keyboard.press("Escape");
  await owner.$eval(".plotina-alias-btn", (el) => el.click());
  await owner.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await owner.$eval('#plotina-dm-alias-dialog [data-role=reset]', (el) => el.click());
  await owner.waitForTimeout(3000);
  stopReset();
  const resetHeader = (await owner.textContent(".mx_RoomHeader_heading")).trim();
  const resetAuthors = await authorLines(owner);
  const mapReset = await userAccountData(OWNER.user_id);
  await shot(owner, "07-after-reset.png");
  record("reset restores the real display name everywhere",
    resetHeader === "Даниил" && resetAuthors.some((t) => t.includes("Даниил")),
    `header=${JSON.stringify(resetHeader)} authors=${JSON.stringify(resetAuthors.slice(0, 3))}`);
  record("reset removes the key instead of writing an empty value",
    mapReset.status === 200 && JSON.stringify(mapReset.json) === "{}",
    `HTTP ${mapReset.status} ${JSON.stringify(mapReset.json)}`);
  record("the reset was one PUT of the contact map",
    resets.length === 1 && resets[0].url.includes(`/account_data/${ACCOUNT_DATA}`),
    JSON.stringify(resets));
  const dm2Reset = await openRoom(owner, DM2);
  record("the reset also clears the other DM with that person",
    dm2Reset === "Даниил", `dm2 header=${JSON.stringify(dm2Reset)}`);

  // ------------------------------------------------- the other account
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await login(other, OTHER);
  await openRoom(other, DM1);
  await other.keyboard.press("Escape");
  await other.$eval(".plotina-alias-btn", (el) => el.click());
  await other.waitForSelector("#plotina-dm-alias-dialog input", { timeout: 10000 });
  await other.fill("#plotina-dm-alias-dialog input", "Алиса-для-Боба");
  await other.$eval('#plotina-dm-alias-dialog [data-role=save]', (el) => el.click());
  await other.waitForTimeout(2500);
  const otherHeader = (await other.textContent(".mx_RoomHeader_heading")).trim();
  const otherMap = await api(
    `/_matrix/client/v3/user/${encodeURIComponent(OTHER.user_id)}/account_data/${ACCOUNT_DATA}`, OTHER.token);
  await shot(other, "08-other-account.png");
  record("the other account's name is its own entry, in its own account data",
    otherHeader === "Алиса-для-Боба" && otherMap.json[OWNER.user_id] === "Алиса-для-Боба",
    `header=${JSON.stringify(otherHeader)} map=${JSON.stringify(otherMap.json)}`);
  const ownerStillStock = await openRoom(owner, DM1);
  record("one account's name never shows up for the other",
    ownerStillStock === "Даниил", `alice header=${JSON.stringify(ownerStillStock)}`);

  // -------------------------------------------------- startup on a new device
  const restartCtx = await browser.newContext();
  const restart = await restartCtx.newPage();
  await api(`/_matrix/client/v3/user/${encodeURIComponent(OWNER.user_id)}/account_data/${ACCOUNT_DATA}`,
    OWNER.token, "PUT", { [BOB]: "Денчик-старт" });
  await login(restart, OWNER);
  const startHeader = await openRoom(restart, DM1);
  const startHeader2 = await openRoom(restart, DM2);
  await shot(restart, "09-startup.png");
  record("a name set earlier applies at startup, in both DMs",
    startHeader === "Денчик-старт" && startHeader2 === "Денчик-старт",
    `dm1=${JSON.stringify(startHeader)} dm2=${JSON.stringify(startHeader2)}`);

  // ------------------------------------------------------------- console
  const overlayIssues = consoleIssues.filter((t) => /plotina-dm-aliases/.test(t) || /pageerror/.test(t));
  record("no overlay error and no page error in the client log",
    overlayIssues.length === 0,
    `${overlayIssues.length} of ${consoleIssues.length} console errors mention the overlay`);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "proof.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in ${OUT}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("proof failed:", err);
  process.exit(2);
});
