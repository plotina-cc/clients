import { expect, type Page } from "@playwright/test";

import { DEVICE_ID, HOMESERVER, QA_PASSWORD, QA_USER } from "./env";

/** The session object Element Call keeps in localStorage (`ClientContext.tsx`). */
export interface MatrixSession {
  user_id: string;
  device_id: string;
  access_token: string;
  passwordlessUser: boolean;
}

/**
 * Logs the QA account in against the homeserver and installs the session where
 * Element Call expects to find it (`matrix-auth-store`), then loads the app.
 *
 * Why not the /login form: Element Call's login promise only resolves after
 * `initClient` sees the first sync reach PREPARED (`src/utils/matrix.ts`,
 * `waitForSync`). On a cold profile that step intermittently never completes —
 * the client keeps long-polling `/sync` while the form stays on "Logging in…"
 * forever. Reproduced on a workstation twice in four attempts (one run hung
 * for the full 180 s); the same account logs in in 1.5 s through the API. The
 * defect is worth reporting upstream, but it is not what this suite is about,
 * so the helper uses the API and the app's normal session-restore path, which
 * every reload already exercises.
 *
 * The device id is fixed per runner (`E2E_DEVICE_ID`) so repeated runs do not
 * create a new Matrix device each time, while a CI run and a workstation run
 * do not invalidate each other's token (a login with an existing device id
 * revokes that device's previous access token).
 */
export async function login(page: Page): Promise<void> {
  const startedAt = Date.now();

  const response = await page.request.post(
    `${HOMESERVER}/_matrix/client/v3/login`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: QA_USER },
        password: QA_PASSWORD,
        device_id: DEVICE_ID,
        initial_device_display_name: "Element Call E2E (Playwright)",
      },
      failOnStatusCode: false,
    },
  );

  if (!response.ok()) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(
      `Matrix login for ${QA_USER} failed: HTTP ${response.status()} ${body}`,
    );
  }

  const payload = (await response.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  const session: MatrixSession = {
    user_id: payload.user_id,
    device_id: payload.device_id,
    access_token: payload.access_token,
    passwordlessUser: false,
  };

  await page.addInitScript((value: MatrixSession) => {
    try {
      localStorage.setItem("matrix-auth-store", JSON.stringify(value));
    } catch {
      /* a cross-origin frame has no access to this origin's storage */
    }
  }, session);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByTestId("usermenu_open"),
    "the app should restore the session and render the authenticated shell",
  ).toBeVisible({ timeout: 120_000 });

  console.log(
    `[e2e] session for ${session.user_id} restored in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`,
  );
}

/**
 * Makes sure the microphone is publishing. Element Call joins unmuted with the
 * default settings, so this is normally a no-op; it only clicks when the
 * control reports itself as muted (for example if a previous run stored
 * `muteStates.audio = true` in the profile).
 */
export async function ensureMicrophoneOn(page: Page): Promise<string> {
  const mute = page.getByTestId("incall_mute");
  await expect(mute).toBeVisible({ timeout: 60_000 });

  const label =
    (await mute.getAttribute("aria-label")) ??
    (await mute.getAttribute("title")) ??
    "";
  if (/unmute|включить микрофон/i.test(label)) {
    await mute.click();
  }
  return label;
}
