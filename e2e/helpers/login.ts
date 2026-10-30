import { expect, type Page } from "@playwright/test";

import {
  DEVICE_ID,
  HOMESERVER,
  QA_ACCESS_TOKEN,
  QA_PASSWORD,
  QA_USER,
} from "./env";

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
 * Authentication goes through a pre-issued access token (`E2E_ACCESS_TOKEN`)
 * by default. That is the supported path on plotina.cc: the homeserver
 * delegates login to MAS with `passwords.enabled: false`, so
 * `m.login.password` answers `400 M_UNKNOWN Invalid login type` and only
 * `m.login.sso` / `m.login.token` are offered. The token is a MAS
 * compatibility token created with
 * `mas-cli manage issue-compatibility-token qa-noise E2EPW-ci` (see
 * `e2e/README.md`); it does not expire, and it already names its device, so no
 * login request is made at all.
 *
 * `QA_NOISE_USER` / `QA_NOISE_PASSWORD` are kept only as an explicit fallback
 * for a deployment that still accepts password login, and are used only when
 * `E2E_ACCESS_TOKEN` is empty and both are set.
 *
 * Why not the /login form: Element Call's login promise only resolves after
 * `initClient` sees the first sync reach PREPARED (`src/utils/matrix.ts`,
 * `waitForSync`). On a cold profile that step intermittently never completes —
 * the client keeps long-polling `/sync` while the form stays on "Logging in…"
 * forever. Reproduced on a workstation twice in four attempts (one run hung
 * for the full 180 s); the same account restores a session in 1.5 s through
 * the API. The defect is worth reporting upstream, but it is not what this
 * suite is about, so the helper installs the session and the app's normal
 * session-restore path, which every reload already exercises.
 */
export async function login(page: Page): Promise<void> {
  const startedAt = Date.now();

  const session = QA_ACCESS_TOKEN
    ? await sessionFromToken(page)
    : await sessionFromPassword(page);

  if (QA_ACCESS_TOKEN && session.device_id !== DEVICE_ID) {
    console.log(
      `[e2e] E2E_ACCESS_TOKEN is bound to device ${session.device_id}; ` +
        `E2E_DEVICE_ID=${DEVICE_ID} only applies to the password fallback`,
    );
  }

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
    `[e2e] session for ${session.user_id} (${session.device_id}) restored in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`,
  );
}

/**
 * Validates the pre-issued token with `/account/whoami`, which also returns the
 * user and device the token is bound to — so the stored session cannot drift
 * from the token. Fails with the HTTP body instead of a 120 s UI timeout when
 * the token was revoked, its device was deleted, or the account was locked.
 */
async function sessionFromToken(page: Page): Promise<MatrixSession> {
  const response = await page.request.get(
    `${HOMESERVER}/_matrix/client/v3/account/whoami`,
    {
      headers: { Authorization: `Bearer ${QA_ACCESS_TOKEN}` },
      failOnStatusCode: false,
    },
  );

  if (!response.ok()) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(
      `E2E_ACCESS_TOKEN was rejected by ${HOMESERVER}: HTTP ${response.status()} ${body}. ` +
        "Issue a new compatibility token with " +
        "`mas-cli manage issue-compatibility-token qa-noise E2EPW-ci` and update the secret.",
    );
  }

  const payload = (await response.json()) as {
    user_id?: string;
    device_id?: string;
  };
  if (!payload.user_id || !payload.device_id) {
    throw new Error(
      `whoami for E2E_ACCESS_TOKEN returned no user_id/device_id: ${JSON.stringify(payload)}`,
    );
  }

  return {
    user_id: payload.user_id,
    device_id: payload.device_id,
    access_token: QA_ACCESS_TOKEN,
    passwordlessUser: false,
  };
}

/**
 * Legacy password login, kept as a fallback only. On plotina.cc it is dead:
 * MAS has password login disabled, so this branch is not supposed to run.
 */
async function sessionFromPassword(page: Page): Promise<MatrixSession> {
  if (!QA_USER || !QA_PASSWORD) {
    throw new Error(
      "No QA credentials: set E2E_ACCESS_TOKEN, or QA_NOISE_USER and QA_NOISE_PASSWORD",
    );
  }

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
  return {
    user_id: payload.user_id,
    device_id: payload.device_id,
    access_token: payload.access_token,
    passwordlessUser: false,
  };
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
