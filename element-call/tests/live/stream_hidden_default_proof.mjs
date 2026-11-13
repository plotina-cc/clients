/*
Live proof for "somebody else's stream is hidden by default" (t_6d5f61b4),
the behaviour `patches/0005-plotina-stream-video-toggle.patch` now implements.

Two browser contexts in one Element Call (Synapse + LiveKit + lk-jwt-service
behind the upstream docker-compose-dev.yml nginx, *.m.localhost):

  sharer - publishes a synthetic screen share (canvas video + 440 Hz audio)
  viewer - joins the same call and never asks for the stream until step 3

What it measures, all from the pages:

  1. the viewer's tile says "Stream hidden" and the share's video never reaches
     its peer connection, with nothing stored for that stream (the default);
  2. "Watch" in the tile's menu brings the stream up — the inbound share track
     appears — and writes nothing to account data or the cache;
  3. after the viewer leaves and the share is restarted, the viewer comes back to
     a hidden stream again (no `true` was stored, so nothing keeps it shown);
  4. the sharer's own tile is never hidden, whatever is stored;
  5. negative control for the "nothing was written" checks: hiding a stream does
     write `visible: false` to account data and to the cache.

"Hidden" is measured with WebRTC getStats() on every RTCPeerConnection the page
creates, so it means the SFU never sent the share, not that a div was hidden.
The script writes evidence.json plus screenshots into EVIDENCE_DIR and exits
non-zero if any check failed.

Usage, from element-call/tests/live:

  BASE_URL=https://localhost:3443/room/#?roomId=<id> EVIDENCE_DIR=$PWD/out \
    PLAYWRIGHT_FROM=/path/to/ec/package.json \
    node stream_hidden_default_proof.mjs

Needs @playwright/test with its chromium; the bundle under BASE_URL must be a
build of the pinned tag with the whole patch series applied, served with
serve_bundle.mjs or any HTTPS server. The room is created out of band (the
stand's Synapse refuses EC's own room creation, see ec-live-room.py).
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Playwright lives in the Element Call source tree this harness drives, not in
// this repository, so let the caller point at a module that can resolve it.
const requireFrom = createRequire(
  process.env.PLAYWRIGHT_FROM ?? fileURLToPath(import.meta.url),
);
const { chromium } = requireFrom("@playwright/test");

const BASE_URL = process.env.BASE_URL ?? "https://localhost:3443/";
const OUT =
  process.env.EVIDENCE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });

const evidence = {
  started: new Date().toISOString(),
  baseUrl: BASE_URL,
  steps: [],
};
const say = (msg, extra) => {
  console.log(msg + (extra ? " " + JSON.stringify(extra) : ""));
  evidence.steps.push({ t: Date.now(), msg, ...(extra ? { extra } : {}) });
};

const waitForAny = async (page, ids, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const id of ids) {
      if (await page.getByTestId(id).isVisible().catch(() => false)) return id;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`none of ${ids.join(", ")} appeared at ${page.url()}`);
};

/** Joins a call, given a room URL: lobby (or name prompt) first, then in-call. */
const joinCall = async (page, name, url = BASE_URL) => {
  await page.goto(url);
  const landing = await waitForAny(page, [
    "home_displayName",
    "joincall_displayName",
    "lobby_joinCall",
  ]);
  if (landing === "home_displayName") {
    await page.getByTestId("home_displayName").click();
    await page.getByTestId("home_displayName").fill(name);
    await page.getByTestId("home_go").click();
  } else if (landing === "joincall_displayName") {
    await page.getByTestId("joincall_displayName").click();
    await page.getByTestId("joincall_displayName").fill(name);
    await page.getByTestId("joincall_joincall").click();
  }
  await page.getByTestId("lobby_joinCall").click({ timeout: 60_000 });
  await page.getByTestId("incall_leave").waitFor({ timeout: 60_000 });
  return page.url();
};

/**
 * Comes back into a call after leaving it. Leaving parks the SPA on the "your
 * call has ended" screen, and a hash-only navigation does not reboot it, so the
 * page is reloaded: that is exactly the fresh load the default has to survive.
 */
const rejoinCall = async (page, url = BASE_URL) => {
  await page.goto(url);
  await page.reload();
  await page.getByTestId("lobby_joinCall").waitFor({ timeout: 90_000 });
  await page.getByTestId("lobby_joinCall").click({ timeout: 60_000 });
  await page.getByTestId("incall_leave").waitFor({ timeout: 60_000 });
  return page.url();
};

/** A screen "share" whose video is a 640x360 canvas at 10 fps and whose audio
 * is a 440 Hz tone: enough for LiveKit to publish real ScreenShare and
 * ScreenShareAudio tracks through the SFU. */
const patchDisplayMedia = async (page) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      let frame = 0;
      const paint = () => {
        ctx.fillStyle = frame++ % 2 === 0 ? "#1f3b2b" : "#2b1f3b";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fff";
        ctx.font = "32px sans-serif";
        ctx.fillText(`hidden-by-default ${frame}`, 40, 180);
        requestAnimationFrame(paint);
      };
      paint();
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      oscillator.frequency.value = 440;
      const destination = audioContext.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return new MediaStream([
        ...canvas.captureStream(10).getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
    };
  });
};

/** Records every RTCPeerConnection the app creates so stats can be read later. */
const instrument = async (page) => {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    const pcs = [];
    window.__pcs = pcs;
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args) {
        const pc = new target(...args);
        pcs.push(pc);
        return pc;
      },
    });
  });
};

const sample = (page) =>
  page.evaluate(async () => {
    const result = [];
    for (const pc of window.__pcs ?? []) {
      let stats;
      try {
        stats = await pc.getStats();
      } catch {
        continue;
      }
      stats.forEach((r) => {
        if (r.type === "inbound-rtp")
          result.push({
            kind: r.kind,
            ssrc: r.ssrc,
            bytes: r.bytesReceived ?? 0,
            frames: r.framesDecoded ?? 0,
            fps: r.framesPerSecond ?? 0,
            w: r.frameWidth ?? 0,
            h: r.frameHeight ?? 0,
          });
      });
    }
    return result;
  });

/** Two samples `ms` apart; returns per-ssrc deltas. */
const measure = async (page, label, ms = 2500) => {
  const a = await sample(page);
  await page.waitForTimeout(ms);
  const b = await sample(page);
  const tracks = new Map();
  for (const entry of a) tracks.set(entry.ssrc, { ...entry, base: true });
  for (const entry of b) {
    const before = tracks.get(entry.ssrc);
    tracks.set(entry.ssrc, {
      kind: entry.kind,
      ssrc: entry.ssrc,
      w: entry.w,
      h: entry.h,
      fps: entry.fps,
      bytesDelta: entry.bytes - (before?.bytes ?? entry.bytes),
      framesDelta: entry.frames - (before?.frames ?? entry.frames),
    });
  }
  const out = {
    label,
    windowMs: ms,
    tracks: [...tracks.values()].filter((t) => !t.base),
  };
  say(`measure ${label}`, out);
  return out;
};

/**
 * Streams actually arriving. The share is identified by difference rather than
 * by pixel size: LiveKit picks the simulcast layer per subscriber, so its size
 * can equal a camera's. With one camera in the room the viewer sees exactly one
 * video stream while the share is hidden and two while it is shown.
 */
const videoCount = (m) =>
  m.tracks.filter((t) => t.kind === "video" && t.framesDelta > 0).length;

const streamHiddenVisible = (page) =>
  page
    .getByText("Stream hidden")
    .isVisible()
    .catch(() => false);

/** The stored visibility map, read out of the page's own cache. */
const storedCache = (page) =>
  page.evaluate(() => localStorage.getItem("plotina_voice_volumes_v1"));

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--mute-audio",
    "--host-resolver-rules=MAP *.m.localhost 127.0.0.1, MAP m.localhost 127.0.0.1",
  ],
});

const newParticipant = async (label) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await instrument(page);
  return { label, context, page, logs };
};

let failure;
let sharerProbe, viewerProbe;
try {
  const sharer = await newParticipant("sharer");
  const viewer = await newParticipant("viewer");
  sharerProbe = sharer;
  viewerProbe = viewer;

  await patchDisplayMedia(sharer.page);

  const roomUrl = BASE_URL;
  await joinCall(sharer.page, "Sharer", roomUrl);
  say("sharer joined", { roomUrl });
  await joinCall(viewer.page, "Viewer", roomUrl);
  say("viewer joined");
  await viewer.page.waitForTimeout(5000);

  // Baseline: one other participant, one camera, nothing shared yet.
  const beforeShare = await measure(viewer.page, "viewer/before-share");

  const screenShareButton = sharer.page.getByTestId("incall_screenshare");
  /** Starts or stops the share and waits for the button to agree. */
  const setSharing = async (on) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sharer.page.mouse.move(640, 360);
      await sharer.page.mouse.move(660, 380);
      await sharer.page.waitForTimeout(300);
      await screenShareButton.click();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const checked = await screenShareButton.getAttribute("aria-checked");
        if ((checked === "true") === on) return;
        await sharer.page.waitForTimeout(250);
      }
      say("screenshare click did not take", { attempt, wanted: on });
    }
    throw new Error(`could not ${on ? "start" : "stop"} the screen share`);
  };

  // 1. The default: B shares, A sees it hidden and receives no share track.
  await setSharing(true);
  say("sharer started a screen share");
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .waitFor({ state: "attached", timeout: 90_000 });
  await viewer.page.waitForTimeout(4000);

  const hiddenByDefault = await measure(viewer.page, "viewer/share-hidden-by-default");
  const hiddenTextOnJoin = await streamHiddenVisible(viewer.page);
  const cacheOnJoin = await storedCache(viewer.page);
  const logsOnJoin = viewer.logs.filter((l) =>
    /account_data\/cc\.plotina/.test(l),
  );
  await viewer.page.screenshot({ path: join(OUT, "01-viewer-hidden-by-default.png") });
  say("viewer tile at join", {
    hiddenText: hiddenTextOnJoin,
    cache: cacheOnJoin,
    accountDataWrites: logsOnJoin.length,
  });

  // The sharer's own tile is not affected by the default.
  const sharerHiddenText = await streamHiddenVisible(sharer.page);
  await sharer.page.screenshot({ path: join(OUT, "02-sharer-own-tile.png") });
  say("sharer own tile", { hiddenText: sharerHiddenText });

  // 2. "Watch" brings it up, from the same corner menu the toggle lives in.
  const logsBeforeShow = viewer.logs.length;
  await viewer.page.mouse.move(640, 360);
  await viewer.page.mouse.move(660, 380);
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .click();
  const hideItem = viewer.page.getByRole("menuitemcheckbox", {
    name: "Don't show this stream",
  });
  await hideItem.waitFor({ state: "visible", timeout: 20_000 });
  const checkedBeforeWatch = await hideItem.getAttribute("aria-checked");
  await hideItem.click();
  await viewer.page.keyboard.press("Escape");
  say("watch clicked", { checkedBeforeWatch });
  await viewer.page.waitForTimeout(4000);

  const afterWatch = await measure(viewer.page, "viewer/after-watch");
  const hiddenTextAfterWatch = await streamHiddenVisible(viewer.page);
  const cacheAfterWatch = await storedCache(viewer.page);
  const writesAfterWatch = viewer.logs
    .slice(logsBeforeShow)
    .filter((l) => /account_data\/cc\.plotina/.test(l)).length;
  await viewer.page.screenshot({ path: join(OUT, "03-viewer-watching.png") });
  say("viewer after watch", {
    hiddenText: hiddenTextAfterWatch,
    cache: cacheAfterWatch,
    accountDataWritesDuringWatch: writesAfterWatch,
  });

  // 3. Leaving and turning the stream on again: hidden once more, because
  //    nothing was stored to say this viewer wants it.
  await viewer.page.getByTestId("incall_leave").click({ timeout: 30_000 });
  say("viewer left the call");
  await viewer.page.waitForTimeout(2000);
  await setSharing(false);
  say("sharer stopped sharing");
  await sharer.page.waitForTimeout(1500);
  await setSharing(true);
  say("sharer started sharing again");

  const logsBeforeRejoin = viewer.logs.length;
  await rejoinCall(viewer.page, roomUrl);
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .waitFor({ state: "attached", timeout: 90_000 });
  await viewer.page.waitForTimeout(5000);
  const afterRejoin = await measure(viewer.page, "viewer/rejoined");
  const hiddenTextAfterRejoin = await streamHiddenVisible(viewer.page);
  const cacheAfterRejoin = await storedCache(viewer.page);
  const writesAfterRejoin = viewer.logs
    .slice(logsBeforeRejoin)
    .filter((l) => /account_data\/cc\.plotina/.test(l)).length;
  await viewer.page.screenshot({ path: join(OUT, "04-viewer-rejoined-hidden.png") });
  say("viewer after rejoin", {
    hiddenText: hiddenTextAfterRejoin,
    cache: cacheAfterRejoin,
    accountDataWritesSinceRejoin: writesAfterRejoin,
  });

  // 4. Negative control for the two "nothing was written" checks: hiding does
  //    write `visible: false`, so those checks are not vacuous.
  const logsBeforeHide = viewer.logs.length;
  await viewer.page.mouse.move(640, 360);
  await viewer.page.mouse.move(660, 380);
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .click();
  const hideAgain = viewer.page.getByRole("menuitemcheckbox", {
    name: "Don't show this stream",
  });
  await hideAgain.waitFor({ state: "visible", timeout: 20_000 });
  // Hidden already: the item reports checked. Show it, then hide it, so the
  // write path runs for real.
  await hideAgain.click();
  await viewer.page.keyboard.press("Escape");
  await viewer.page.waitForTimeout(3000);
  await viewer.page.mouse.move(640, 360);
  await viewer.page.mouse.move(660, 380);
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .click();
  await hideAgain.waitFor({ state: "visible", timeout: 20_000 });
  await hideAgain.click();
  await viewer.page.keyboard.press("Escape");
  await viewer.page.waitForTimeout(3000);
  const cacheAfterHide = await storedCache(viewer.page);
  const writesAfterHide = viewer.logs
    .slice(logsBeforeHide)
    .filter((l) => /account_data\/cc\.plotina/.test(l)).length;
  await viewer.page.screenshot({ path: join(OUT, "05-viewer-hidden-by-choice.png") });
  say("viewer after hiding by choice", {
    cache: cacheAfterHide,
    accountDataWritesSinceHideStep: writesAfterHide,
  });

  const livekitLogs = viewer.logs.filter((l) =>
    /Unsubscribed|Subscribed|screen_share/.test(l),
  );

  evidence.result = {
    viewerBeforeShare: beforeShare,
    viewerShareHiddenByDefault: hiddenByDefault,
    viewerAfterWatch: afterWatch,
    viewerRejoined: afterRejoin,
    ui: {
      hiddenTextOnJoin,
      hiddenTextAfterWatch,
      hiddenTextAfterRejoin,
      sharerOwnTileHiddenText: sharerHiddenText,
      checkedBeforeWatch,
    },
    stored: {
      onJoin: cacheOnJoin,
      afterWatch: cacheAfterWatch,
      afterRejoin: cacheAfterRejoin,
      afterHidingByChoice: cacheAfterHide,
    },
    accountDataWrites: {
      duringWatch: writesAfterWatch,
      sinceRejoin: writesAfterRejoin,
      sinceHideStep: writesAfterHide,
    },
    livekitLogs,
    checks: {
      // 1. hidden by default, and really not received
      viewerHiddenOnJoin: hiddenTextOnJoin === true,
      shareNotReceivedByDefault:
        videoCount(hiddenByDefault) === videoCount(beforeShare),
      nothingStoredOnJoin:
        !(cacheOnJoin ?? "").includes("#screenshare-video") &&
        logsOnJoin.length === 0,
      // 2. watch shows it
      watchBroughtItUp:
        videoCount(afterWatch) === videoCount(beforeShare) + 1 &&
        hiddenTextAfterWatch === false,
      watchWroteNothing:
        writesAfterWatch === 0 &&
        !(cacheAfterWatch ?? "").includes("#screenshare-video"),
      // 3. leaving and re-enabling the share: hidden again
      hiddenAgainAfterRejoin:
        hiddenTextAfterRejoin === true &&
        videoCount(afterRejoin) === videoCount(beforeShare) &&
        !(cacheAfterRejoin ?? "").includes("#screenshare-video"),
      // 4. the person sharing always sees their own stream
      sharerOwnStreamVisible: sharerHiddenText === false,
      // 5. negative control: hiding does write
      hidingWritesAccountData:
        writesAfterHide > 0 &&
        (cacheAfterHide ?? "").includes('"visible":false'),
    },
  };
  say("checks", evidence.result.checks);
  if (Object.values(evidence.result.checks).some((ok) => !ok))
    failure = new Error("a live check failed: see evidence.json");
} catch (error) {
  failure = error;
  say("FAILED", { error: String(error?.stack ?? error) });
  for (const p of [sharerProbe, viewerProbe]) {
    if (!p) continue;
    try {
      await p.page.screenshot({ path: join(OUT, `fail-${p.label}.png`) });
      const text = await p.page.evaluate(() =>
        (document.body.innerText ?? "").replace(/\n+/g, " | ").slice(0, 800),
      );
      say(`state of ${p.label}`, {
        url: p.page.url(),
        text,
        logs: p.logs.slice(-25),
      });
    } catch (e) {
      say(`could not inspect ${p.label}`, { error: String(e) });
    }
  }
} finally {
  evidence.finished = new Date().toISOString();
  evidence.failure = failure ? String(failure?.stack ?? failure) : null;
  writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
}

if (failure) process.exitCode = 1;
