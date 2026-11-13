/*
Live proof for patches/0005-plotina-stream-video-toggle.patch.

Three browser contexts in one Element Call (Synapse + LiveKit + lk-jwt-service
behind the upstream docker-compose-dev.yml nginx, *.m.localhost):

  sharer  - publishes a synthetic screen share (canvas video + 440 Hz audio)
  viewer  - hides that stream with the new toggle
  control - stays untouched (negative control)

"Hidden" is measured with WebRTC getStats() on every RTCPeerConnection the page
creates, so it means the SFU stopped sending the share, not that a div was
hidden. The script writes evidence.json plus screenshots into EVIDENCE_DIR and
exits non-zero if any check failed.

Usage, from element-call/tests/live:

  BASE_URL=https://localhost:3443/ EVIDENCE_DIR=$PWD/out \
    node stream_video_toggle_proof.mjs

Needs @playwright/test with its chromium; the bundle under BASE_URL must be a
build of the pinned tag with the whole patch series applied
(`build.py --mode source`), served with serve_bundle.mjs or any HTTPS server.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Playwright lives in the Element Call source tree this harness drives, not in
// this repository, so let the caller point at a module that can resolve it:
//   PLAYWRIGHT_FROM=/path/to/ec/src/package.json node stream_video_toggle_proof.mjs
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

const joinCall = async (page, name, url = BASE_URL) => {
  await page.goto(url);
  const landing = await waitForAny(page, [
    "home_displayName",
    "joincall_displayName",
    "lobby_joinCall",
  ]);
  if (landing === "home_displayName") {
    await page.getByTestId("home_callName").click();
    await page.getByTestId("home_callName").fill("StreamToggle");
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
            mid: r.mid,
            bytes: r.bytesReceived ?? 0,
            frames: r.framesDecoded ?? 0,
            fps: r.framesPerSecond ?? 0,
            w: r.frameWidth ?? 0,
            h: r.frameHeight ?? 0,
            packetsLost: r.packetsLost ?? 0,
          });
      });
      result.push({
        transceivers: pc.getTransceivers().map((t) => ({
          mid: t.mid,
          dir: t.direction,
          cur: t.currentDirection,
          trackMuted: t.receiver?.track?.muted ?? null,
          trackState: t.receiver?.track?.readyState ?? null,
        })),
      });
    }
    return result;
  });

/** Two samples `ms` apart; returns per-ssrc deltas and the transceiver snapshot. */
const measure = async (page, label, ms = 2500) => {
  const a = await sample(page);
  await page.waitForTimeout(ms);
  const b = await sample(page);
  const tracks = new Map();
  for (const entry of a)
    if (entry.kind) tracks.set(entry.ssrc, { ...entry, base: true });
  for (const entry of b) {
    if (!entry.kind) continue;
    const before = tracks.get(entry.ssrc);
    tracks.set(entry.ssrc, {
      kind: entry.kind,
      ssrc: entry.ssrc,
      w: entry.w,
      h: entry.h,
      fps: entry.fps,
      bytesDelta: entry.bytes - (before?.bytes ?? entry.bytes),
      framesDelta: entry.frames - (before?.frames ?? entry.frames),
      packetsLost: entry.packetsLost,
    });
  }
  const transceivers = b.find((e) => e.transceivers)?.transceivers ?? [];
  const out = {
    label,
    windowMs: ms,
    tracks: [...tracks.values()].filter((t) => !t.base),
    transceivers,
  };
  say(`measure ${label}`, out);
  return out;
};

const videoTracks = (m) => m.tracks.filter((t) => t.kind === "video");
const audioTracks = (m) => m.tracks.filter((t) => t.kind === "audio");
/**
 * The share is identified by difference, not by pixel size: LiveKit picks the
 * simulcast layer per viewer, so the same share arrives as 640x360 for one
 * viewer and 320x180 for another (and its size can equal the cameras'). What
 * does not vary is that the viewer receives exactly one more video stream
 * before hiding than after, and that stream is the only one that changes.
 */
const videoCount = (m) => videoTracks(m).filter((t) => t.framesDelta > 0).length;
const totalVideoFrames = (m) =>
  videoTracks(m).reduce((sum, t) => sum + t.framesDelta, 0);
const audioBytesTotal = (m) =>
  audioTracks(m).reduce((sum, t) => sum + t.bytesDelta, 0);

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
let sharerProbe, viewerProbe, controlProbe;
try {
  const sharer = await newParticipant("sharer");
  const viewer = await newParticipant("viewer");
  const control = await newParticipant("control");
  sharerProbe = sharer;
  viewerProbe = viewer;
  controlProbe = control;

  await patchDisplayMedia(sharer.page);

  const roomUrl = await joinCall(sharer.page, "Sharer");
  say("sharer joined", { roomUrl });
  await joinCall(viewer.page, "Viewer", roomUrl);
  await joinCall(control.page, "Control", roomUrl);
  say("viewer and control joined");

  // Publish the synthetic screen share (video + audio). The footer hides itself
  // when the pointer is idle, so wake it and retry.
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

  // EC puts a lone remote share in the spotlight by itself; the toggle lives in
  // that tile's corner, next to upstream's volume button.
  for (const p of [viewer, control]) {
    await p.page
      .getByRole("button", { name: "Screen share visibility" })
      .waitFor({ state: "attached", timeout: 90_000 });
  }
  await viewer.page.waitForTimeout(4000);

  const beforeHideViewer = await measure(viewer.page, "viewer/before-hide");
  const beforeHideControl = await measure(control.page, "control/before-hide");
  const beforeHideSharer = await measure(sharer.page, "sharer/before-hide");

  if (videoCount(beforeHideViewer) < 3)
    throw new Error(
      `viewer does not receive the share plus both cameras before hiding: ${JSON.stringify(beforeHideViewer.tracks)}`,
    );

  await viewer.page.screenshot({ path: join(OUT, "01-viewer-receiving.png") });

  // Hide it: tile corner menu -> "Don't show this stream".
  await viewer.page.mouse.move(640, 360);
  await viewer.page.mouse.move(660, 380);
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .click();
  const hideItem = viewer.page.getByRole("menuitemcheckbox", {
    name: "Don't show this stream",
  });
  await hideItem.waitFor({ state: "visible", timeout: 20_000 });
  say("menu open", { ariaChecked: await hideItem.getAttribute("aria-checked") });
  await viewer.page.screenshot({ path: join(OUT, "02-viewer-menu.png") });
  await hideItem.click();
  await viewer.page.waitForTimeout(3000);
  // The toggle keeps its menu open (the checked state is the feedback). Close it
  // first: an open Radix menu marks the rest of the page aria-hidden, and the
  // point of this state is that it reads without a menu at all.
  await viewer.page.keyboard.press("Escape");
  await viewer.page.waitForTimeout(1000);

  // What the viewer sees: not a participant who happens to be present, but a
  // paused stream that owns the tile.
  const readPausedTile = async (page) => {
    const paused = page.getByTestId("stream-paused");
    const visible = await paused.isVisible().catch(() => false);
    if (!visible) return { visible: false };
    const text = (await paused.innerText().catch(() => "")).replace(/\n+/g, " | ");
    const watch = page.getByRole("button", { name: "Watch" });
    const watchVisible = await watch.isVisible().catch(() => false);
    // Readable without a hover: the tile hides its own buttons until then.
    const watchOpacity = await watch
      .evaluate((el) => getComputedStyle(el).opacity)
      .catch(() => null);
    // The participant's own avatar is still there, under the scrim. Scoped to
    // this tile: a role query would also match the avatars in the grid sidebar.
    const avatar = await paused
      .evaluate((el) => {
        const tile = el.closest('[data-testid="videoTile"]');
        const mark = tile?.querySelector('[role="img"][aria-label^="@"]');
        if (!mark) return false;
        const r = mark.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .catch(() => false);
    // ...and a dark backing stands between the two, in any theme.
    const scrim = await paused
      .evaluate((el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)") return bg;
        }
        return null;
      })
      .catch(() => null);
    // Ground truth about what is actually painted where: the element's own box,
    // what sits at the middle of that box, and the opacity the ancestor chain
    // applies (the tile fades during transitions).
    const geometry = await paused
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const chain = [];
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const s = getComputedStyle(n);
          chain.push({
            tag: n.tagName.toLowerCase(),
            cls: String(n.className).slice(0, 60),
            opacity: s.opacity,
            visibility: s.visibility,
            display: s.display,
            transform: s.transform,
          });
        }
        const mid = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          atCentre: mid
            ? `${mid.tagName.toLowerCase()}.${String(mid.className).slice(0, 40)}`
            : null,
          chain,
        };
      })
      .catch((e) => ({ error: String(e) }));
    await paused
      .screenshot({ path: join(OUT, "paused-element.png") })
      .catch(() => {});
    // Paint order, not just styles: the tile background is a paint container and
    // paints as a positioned layer, so a static overlay would sit under it and be
    // invisible while every assertion about boxes and colours still passed.
    const paint = await paused
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const stack = document.elementsFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        const cls = (n) => String(n.className);
        return {
          pausedAboveBackground:
            stack.indexOf(el) >= 0 &&
            (stack.findIndex((n) => /_bg_/.test(cls(n))) === -1 ||
              stack.indexOf(el) <
                stack.findIndex((n) => /_bg_/.test(cls(n)))),
          top: stack.slice(0, 3).map(cls),
        };
      })
      .catch((e) => ({ error: String(e) }));
    // No dead key left behind: the old corner status line is gone.
    const statusLine = await page
      .getByText("Stream hidden")
      .isVisible()
      .catch(() => false);
    return {
      visible: true,
      text,
      watchVisible,
      watchOpacity,
      avatar,
      scrim,
      geometry,
      paint,
      oldStatusLineGone: !statusLine,
    };
  };

  const pausedAfterHide = await readPausedTile(viewer.page);
  say("viewer tile is a paused stream", pausedAfterHide);
  await viewer.page.screenshot({ path: join(OUT, "03-viewer-paused.png") });

  const afterHideViewer = await measure(viewer.page, "viewer/after-hide");
  const afterHideControl = await measure(control.page, "control/while-viewer-hid");
  const afterHideSharer = await measure(sharer.page, "sharer/while-viewer-hid");

  // Negative control: the other viewer still receives every stream it had,
  // including the share.
  if (
    videoCount(afterHideControl) !== videoCount(beforeHideControl) ||
    totalVideoFrames(afterHideControl) <= 0
  )
    throw new Error(
      `control viewer lost a stream as well: ${JSON.stringify({ before: beforeHideControl.tracks, after: afterHideControl.tracks })}`,
    );
  // The share's audio keeps playing for the viewer who hid the video.
  if (audioBytesTotal(afterHideViewer) <= 0)
    throw new Error("viewer lost audio along with the video");

  // The menu is a checkbox menu: it stays open after a click, so a second toggle
  // is the same item again; when it is closed, the corner button opens it.
  const setVisibility = async (wantHidden, label) => {
    const item = viewer.page.getByRole("menuitemcheckbox", {
      name: "Don't show this stream",
    });
    if (!(await item.isVisible().catch(() => false))) {
      await viewer.page.mouse.move(640, 360);
      await viewer.page.mouse.move(660, 380);
      await viewer.page
        .getByRole("button", { name: "Screen share visibility" })
        .click();
      await item.waitFor({ state: "visible", timeout: 20_000 });
    }
    const checked = (await item.getAttribute("aria-checked")) === "true";
    say(`${label}: menu opened`, { checked });
    if (checked !== wantHidden) await item.click();
    await viewer.page.keyboard.press("Escape");
    await viewer.page.waitForTimeout(1000);
  };

  // Show it again, in the same call: the paused block's own button, reached
  // from the keyboard, is the same action as the corner eye toggle.
  const watch = viewer.page.getByRole("button", { name: "Watch" });
  await watch.focus();
  const watchFocused = await watch.evaluate((el) => el === document.activeElement);
  say("watch button focused from the keyboard", { watchFocused });
  await viewer.page.keyboard.press("Enter");
  await viewer.page.waitForTimeout(3000);
  const afterShowViewer = await measure(viewer.page, "viewer/after-show");
  const pausedAfterWatch = await readPausedTile(viewer.page);
  say("after Watch", { pausedBlockGone: !pausedAfterWatch.visible });
  await viewer.page.screenshot({ path: join(OUT, "04-viewer-shown-again.png") });

  // Restart: hide, reload the page, rejoin, the choice must come back from the
  // store (localStorage + account data), not from component state.
  await setVisibility(true, "hide before reload");
  await viewer.page.waitForTimeout(2500);
  say("hidden again before reload");

  await viewer.page.reload();
  await viewer.page.getByTestId("lobby_joinCall").waitFor({ timeout: 90_000 });
  await viewer.page.getByTestId("lobby_joinCall").click({ timeout: 60_000 });
  await viewer.page
    .getByRole("button", { name: "Screen share visibility" })
    .waitFor({ state: "attached", timeout: 90_000 });
  await viewer.page.waitForTimeout(5000);
  const pausedAfterReload = await readPausedTile(viewer.page);
  const reloadMeasure = await measure(viewer.page, "viewer/after-reload");
  await viewer.page.screenshot({ path: join(OUT, "05-viewer-after-reload.png") });
  say("after reload", { pausedTile: pausedAfterReload.visible });

  // Persisted choice, read back from the page.
  const stored = await viewer.page.evaluate(() => ({
    cache: localStorage.getItem("plotina_voice_volumes_v1"),
  }));
  say("localStorage cache", stored);

  // The SFU-side view, straight from LiveKit's own log lines in this page.
  const livekitLogs = viewer.logs.filter((l) =>
    /Unsubscribed|Subscribed|screen_share|account_data\/cc\.plotina/.test(l),
  );

  evidence.result = {
    viewerBeforeHide: beforeHideViewer,
    viewerAfterHide: afterHideViewer,
    controlBeforeHide: beforeHideControl,
    controlWhileViewerHid: afterHideControl,
    sharerBeforeHide: beforeHideSharer,
    sharerWhileViewerHid: afterHideSharer,
    viewerAfterShow: afterShowViewer,
    viewerAfterReload: reloadMeasure,
    ui: {
      pausedAfterToggle: pausedAfterHide,
      pausedAfterReload,
      watchFocusedFromKeyboard: watchFocused,
    },
    stored,
    livekitLogs,
    checks: {
      viewerReceivedBefore: videoCount(beforeHideViewer) >= 3,
      viewerStoppedAfterHide:
        videoCount(afterHideViewer) === videoCount(beforeHideViewer) - 1,
      viewerShareTrackGone:
        videoTracks(afterHideViewer).length ===
        videoTracks(beforeHideViewer).length - 1,
      viewerAudioKeptAfterHide: audioBytesTotal(afterHideViewer) > 0,
      controlUnaffected:
        videoCount(afterHideControl) === videoCount(beforeHideControl) &&
        totalVideoFrames(afterHideControl) > 0,
      sharerUnaffected: totalVideoFrames(afterHideSharer) > 0,
      viewerResumedAfterShow:
        videoCount(afterShowViewer) === videoCount(beforeHideViewer),
      pausedTileOnHide:
        pausedAfterHide.visible === true &&
        /Stream paused/.test(pausedAfterHide.text ?? "") &&
        pausedAfterHide.watchVisible === true &&
        pausedAfterHide.watchOpacity === "1" &&
        pausedAfterHide.avatar === true &&
        pausedAfterHide.paint?.pausedAboveBackground === true &&
        /^rgba\(0, 0, 0, 0\.5\d\)$/.test(pausedAfterHide.scrim ?? "") &&
        pausedAfterHide.oldStatusLineGone === true,
      watchBroughtItBack: pausedAfterWatch.visible === false,
      watchReachableFromKeyboard: watchFocused === true,
      hiddenAfterReload: pausedAfterReload.visible === true,
      stillHiddenAfterReload:
        videoCount(reloadMeasure) === videoCount(beforeHideViewer) - 1 &&
        totalVideoFrames(reloadMeasure) > 0,
      livekitLoggedUnsubscribe: livekitLogs.some((l) =>
        /Unsubscribed: video screen_share/.test(l),
      ),
      livekitLoggedResubscribe: livekitLogs.some((l) =>
        /Subscribed: video screen_share/.test(l),
      ),
      accountDataWrite: livekitLogs.some((l) =>
        /account_data\/cc\.plotina/.test(l),
      ),
    },
  };
  say("checks", evidence.result.checks);
  if (Object.values(evidence.result.checks).some((ok) => !ok))
    failure = new Error("a live check failed: see evidence.json");
} catch (error) {
  failure = error;
  say("FAILED", { error: String(error?.stack ?? error) });
  for (const p of [sharerProbe, viewerProbe, controlProbe]) {
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