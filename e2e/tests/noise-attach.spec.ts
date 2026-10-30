/**
 * The real path: log in, join the test room, publish the microphone, and wait
 * until `/noise/plotina-dfn.js` reports that DeepFilterNet3 has been attached
 * to the published track.
 *
 * This is the check that fails when the static module, the Element Call patch
 * or the WASM/model assets break — the app itself would still connect a call,
 * just without the denoiser.
 */
import { expect, test } from "@playwright/test";

import {
  attachDiagnostics,
  collectDiagnostics,
  readPlotinaState,
} from "../helpers/diagnostics";
import { hasCredentials, ROOM_ID } from "../helpers/env";
import { ensureMicrophoneOn, login } from "../helpers/login";

test.describe("Element Call + DeepFilterNet3", () => {
  test.skip(
    !hasCredentials,
    "E2E_ACCESS_TOKEN (or QA_NOISE_USER / QA_NOISE_PASSWORD) is not set — skipping the authenticated Element Call check",
  );
  test.skip(!ROOM_ID, "E2E_ROOM_ID is not set — no room to join");

  test("the published microphone track reaches status=attached", async ({
    page,
  }, testInfo) => {
    // Session restore (up to 120 s including the first sync) + lobby + 60 s
    // for the processor.
    test.setTimeout(300_000);

    const diag = collectDiagnostics(page);
    const startedAt = Date.now();

    try {
      await login(page);

      await page.goto(
        `/room?roomId=${encodeURIComponent(ROOM_ID)}&plotina-debug=1`,
        { waitUntil: "domcontentloaded" },
      );

      // Record every status change, so a failure shows whether the hook fired
      // at all (idle → attaching → error) or never ran (stuck at idle).
      await page.evaluate(() => {
        const w = window as unknown as {
          __plotinaDfn?: { status?: string; error?: string };
          __e2eDfnHistory?: unknown[];
        };
        w.__e2eDfnHistory = [];
        const tick = (): void => {
          const status = w.__plotinaDfn?.status;
          if (!status) return;
          const history = w.__e2eDfnHistory as Array<{
            status: string;
            error?: string;
            at: number;
          }>;
          if (history.length && history[history.length - 1].status === status) {
            return;
          }
          history.push({ status, error: w.__plotinaDfn?.error, at: Date.now() });
        };
        tick();
        setInterval(tick, 200);
      });

      const join = page.getByTestId("lobby_joinCall");
      await expect(
        join,
        "the room should render Element Call's pre-join lobby",
      ).toBeVisible({ timeout: 60_000 });

      await join.click();
      const micLabel = await ensureMicrophoneOn(page);
      console.log(`[e2e] microphone control after join: ${micLabel || "(no label)"}`);

      await page.waitForFunction(
        () =>
          (window as unknown as { __plotinaDfn?: { status?: string } })
            .__plotinaDfn?.status === "attached",
        undefined,
        { timeout: 60_000, polling: 250 },
      );

      const elapsedMs = Date.now() - startedAt;
      const state = await readPlotinaState(page);
      console.log(
        `[e2e] attached in ${(elapsedMs / 1000).toFixed(1)}s:`,
        JSON.stringify(state.dfn),
      );

      expect(
        (state.dfn as { status?: string } | null)?.status,
        "the wrapper's own state after waitForFunction",
      ).toBe("attached");

      await testInfo.attach("plotina-attached.json", {
        body: JSON.stringify(
          { elapsedMs, ...state, console: diag.console },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } catch (error) {
      const report = await attachDiagnostics(
        page,
        diag,
        testInfo,
        "attach-failure",
      );
      console.error(
        "[e2e] attach failed; state:",
        JSON.stringify({
          url: report.url,
          dfn: report.dfn,
          history: report.history,
          badResponses: (report.badResponses as string[])?.slice(-10),
          pageErrors: (report.pageErrors as string[])?.slice(-5),
        }),
      );
      throw error;
    }
  });
});
