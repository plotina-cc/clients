/*
Live proof that the paused stream's own buttons work with a *mouse*.

The stream-visibility patch puts the paused block ("Stream paused" + Watch)
into MediaView's `overlay` slot, which paints under the tile's foreground
chrome (`_fg_`). That chrome covers the whole tile, so a real pointer click
anywhere in the tile — including on the Watch button — is delivered to `_fg_`
and never reaches the button: `setVideoVisible` is never called and nothing
happens on screen. jsdom has no hit testing, and
stream_video_toggle_proof.mjs only reaches Watch from the keyboard
(focus + Enter), so both stayed green.

Two browser contexts in one call on the local stand (Synapse + LiveKit behind
the upstream docker-compose-dev.yml nginx):

  sharer  - publishes a synthetic screen share (canvas + tone)
  viewer  - arrives hidden, then drives the paused tile with the pointer

Checks:

  watchMouseShows   - a mouse click on Watch brings the stream back (video
                      frames arrive again, the paused block is gone)
  watchKeyboardShows- the same button from the keyboard still works, so a
                      failure above is about the pointer path, not the model
  eyeMouseHides     - the corner eye hides the stream with a mouse click
  eyeMouseShows     - ...and shows it again, so the eye's own pointer path is
                      covered too (it sits outside MediaView's chrome)

Usage, from element-call/tests/live:

  BASE_URL=https://localhost:3443/room/#?roomId=<encoded> EVIDENCE_DIR=$PWD/out \
    PLAYWRIGHT_FROM=<ec source tree>/package.json \
    node stream_watch_click_proof.mjs
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const requireFrom = createRequire(
  process.env.PLAYWRIGHT_FROM ?? fileURLToPath(import.meta.url),
);
const { chromium } = requireFrom("@playwright/test");

const BASE_URL = process.env.BASE_URL ?? "https://localhost:3443/";
const OUT =
  process.env.EVIDENCE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });

const evidence = { started: new Date().toISOString(), baseUrl: BASE_URL, steps: [] };
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

const joinCall = async (page, name, url = BASE_URL) => {
  await page.goto(url);
  const landing = await waitForAny(page, [
    "home_displayName",
    "joincall_displayName",
    "lobby_joinCall",
  ]);
  if (landing === "home_displayName") {
    await page.getByTestId("home_callName").click();
    await page.getByTestId("home_callName").fill("WatchClick");
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

/** A screen "share": 640x360 canvas at 10 fps plus a 440 Hz tone. */
const patchDisplayMedia = async (page) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      let frame = 0;
      const paint = () => {
        ctx.fillStyle = frame++ % 2 === 0 ? "#2b2b40" : "#402b40";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fff";
        ctx.font = "32px sans-serif";
        ctx.fillText(`stream frame ${frame}`, 40, 180);
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

/** Records every RTCPeerConnection the app creates, so stats can be read. */
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
  const base = new Map(a.map((e) => [e.ssrc, e]));
  const tracks = b.map((e) => {
    const before = base.get(e.ssrc);
    return {
      kind: e.kind,
      ssrc: e.ssrc,
      w: e.w,
      h: e.h,
      bytesDelta: e.bytes - (before?.bytes ?? e.bytes),
      framesDelta: e.frames - (before?.frames ?? e.frames),
    };
  });
  const out = { label, windowMs: ms, tracks };
  say(`measure ${label}`, out);
  return out;
};

const videoCount = (m) =>
  m.tracks.filter((t) => t.kind === "video" && t.framesDelta > 0).length;

const readPausedTile = async (page) => {
  const paused = page.getByTestId("stream-paused");
  const visible = await paused.isVisible().catch(() => false);
  if (!visible) return { visible: false };
  return {
    visible: true,
    text: (await paused.innerText().catch(() => "")).replace(/\n+/g, " | "),
  };
};

/**
 * Where a pointer click at the middle of `locator` actually lands, and what
 * the element's own box says. This is the ground truth jsdom cannot give:
 * `elementFromPoint` returns the topmost element that would receive the click.
 */
const hitTest = async (locator) =>
  locator
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const stack = document.elementsFromPoint(cx, cy);
      const name = (n) =>
        `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 48)}`;
      return {
        box: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        centre: { x: Math.round(cx), y: Math.round(cy) },
        top: stack.slice(0, 5).map(name),
        topIsButton: stack[0] === el || el.contains(stack[0]),
        receivesClick: stack[0] === el || el.contains(stack[0]),
      };
    })
    .catch((e) => ({ error: String(e) }));

/** Clicks the middle of `locator` with the real mouse, not by DOM dispatch. */
const mouseClick = async (page, locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box to click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

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
const checks = {};
try {
  const sharer = await newParticipant("sharer");
  const viewer = await newParticipant("viewer");
  await patchDisplayMedia(sharer.page);

  const roomUrl = await joinCall(sharer.page, "Sharer");
  say("sharer joined", { roomUrl });
  await joinCall(viewer.page, "Viewer", roomUrl);
  say("viewer joined");

  const startShare = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sharer.page.mouse.move(640, 360);
      await sharer.page.mouse.move(660, 380);
      await sharer.page.waitForTimeout(300);
      await sharer.page.getByTestId("incall_screenshare").click();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const checked = await sharer.page
          .getByTestId("incall_screenshare")
          .getAttribute("aria-checked");
        if (checked === "true") return;
        await sharer.page.waitForTimeout(250);
      }
      say("screenshare click did not take", { attempt });
    }
    throw new Error("could not start a screen share");
  };
  await startShare();
  say("sharer is publishing a screen share");

  const eyeButton = (page) =>
    page.getByRole("button", {
      name: /^(Screen share visibility|Show screen share)$/,
    });
  await eyeButton(viewer.page).waitFor({ state: "attached", timeout: 90_000 });
  await viewer.page.waitForTimeout(3000);

  const pausedOnJoin = await readPausedTile(viewer.page);
  await viewer.page.screenshot({ path: join(OUT, "01-viewer-paused.png") });
  say("viewer tile on join", pausedOnJoin);

  const watch = viewer.page.getByRole("button", { name: "Watch" });
  const watchHit = await hitTest(watch);
  say("hit test at the Watch button", watchHit);
  await watch
    .evaluate((el) => {
      const tile = el.closest('[data-testid="videoTile"]');
      return tile ? String(tile.className) : null;
    })
    .then((cls) => say("tile classes", { cls }));

  // (1) The pointer path: a real click on Watch.
  await mouseClick(viewer.page, watch);
  await viewer.page.waitForTimeout(1500);
  const afterWatchClick = await readPausedTile(viewer.page);
  const statsAfterWatchClick = await measure(viewer.page, "viewer/after-watch-click");
  await viewer.page.screenshot({ path: join(OUT, "02-after-watch-mouse-click.png") });
  say("after a mouse click on Watch", {
    paused: afterWatchClick,
    videoStreams: videoCount(statsAfterWatchClick),
  });

  // (2) The keyboard path, which the earlier proof used: same button, same
  // model, different way in. If this works while (1) does not, the defect is
  // in hit testing, not in the visibility model.
  let keyboardBroughtItBack = false;
  if (afterWatchClick.visible) {
    await watch.focus();
    const focused = await watch.evaluate((el) => el === document.activeElement);
    say("watch focused from the keyboard", { focused });
    await viewer.page.keyboard.press("Enter");
    await viewer.page.waitForTimeout(1500);
    keyboardBroughtItBack = !(await readPausedTile(viewer.page)).visible;
  } else {
    keyboardBroughtItBack = true; // not needed: the mouse already worked
  }
  const statsAfterKeyboard = await measure(viewer.page, "viewer/after-keyboard");
  await viewer.page.screenshot({ path: join(OUT, "03-after-watch-keyboard.png") });
  say("after the keyboard fallback", {
    keyboardBroughtItBack,
    videoStreams: videoCount(statsAfterKeyboard),
  });

  // (3) The corner eye, by mouse: hide, then show. It sits outside MediaView's
  // chrome, so both clicks must work even while the paused block cannot be
  // clicked.
  let eyeHid = false;
  let eyeShowed = false;
  const eyeBefore = await hitTest(eyeButton(viewer.page));
  say("hit test at the eye button", eyeBefore);
  await mouseClick(viewer.page, eyeButton(viewer.page));
  await viewer.page.waitForTimeout(2000);
  eyeHid = (await readPausedTile(viewer.page)).visible;
  const statsAfterEyeHide = await measure(viewer.page, "viewer/after-eye-hide");
  await viewer.page.screenshot({ path: join(OUT, "04-after-eye-hide.png") });
  say("after a mouse click on the eye", {
    paused: eyeHid,
    videoStreams: videoCount(statsAfterEyeHide),
  });

  if (eyeHid) {
    await mouseClick(viewer.page, eyeButton(viewer.page));
    await viewer.page.waitForTimeout(2500);
    eyeShowed = !(await readPausedTile(viewer.page)).visible;
    const statsAfterEyeShow = await measure(viewer.page, "viewer/after-eye-show");
    await viewer.page.screenshot({ path: join(OUT, "05-after-eye-show.png") });
    say("after a second mouse click on the eye", {
      showing: eyeShowed,
      videoStreams: videoCount(statsAfterEyeShow),
    });
  }

  checks.pausedOnJoin = pausedOnJoin.visible === true;
  checks.watchMouseShows = afterWatchClick.visible === false;
  checks.watchKeyboardShows = keyboardBroughtItBack === true;
  checks.eyeMouseHides = eyeHid === true;
  checks.eyeMouseShows = eyeShowed === true;

  evidence.checks = checks;
  evidence.result = {
    hitTestWatch: watchHit,
    hitTestEye: eyeBefore,
    pausedOnJoin,
    afterWatchClick,
    statsAfterWatchClick,
    statsAfterKeyboard,
  };
} catch (error) {
  failure = String(error);
  evidence.failure = failure;
} finally {
  try {
    await browser.close();
  } catch {
    // A browser that will not close must not hide the result.
  }
}

const allPassed = Object.values(checks).every((c) => c === true);
evidence.finished = new Date().toISOString();
evidence.passed = allPassed && failure === undefined;
writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ checks, failure, passed: evidence.passed }));
if (!evidence.passed) process.exit(1);
