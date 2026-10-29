import { expect, type Page } from "@playwright/test";

import { QA_PASSWORD, QA_USER } from "./env";

/**
 * Logs in through Element Call's own /login page.
 *
 * The session is a Matrix one, kept in the origin's storage; after the form
 * submits Element Call navigates back to the app. We wait for the user menu
 * rather than for a URL: `/login` redirects to `/`, but a slow homeserver can
 * leave the page on the spinner for a while.
 */
export async function login(page: Page): Promise<void> {
  const startedAt = Date.now();
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  const username = page.getByTestId("login_username");
  await expect(username).toBeVisible({ timeout: 30_000 });

  await username.fill(QA_USER);
  await page.getByTestId("login_password").fill(QA_PASSWORD);
  await page.getByTestId("login_login").click();

  // Element Call's login is not just the HTTP request: `initClient` waits for
  // the first network sync to reach PREPARED before it resolves, and on a cold
  // account that can take tens of seconds. So wait for the route to change,
  // not for the button — but surface a real login error instead of hanging
  // until the test timeout.
  await page.waitForFunction(
    () => {
      if (location.pathname !== "/login") return true;
      const button = document.querySelector('[data-testid="login_login"]');
      return !!button && button.getAttribute("aria-disabled") !== "true";
    },
    undefined,
    { timeout: 180_000, polling: 500 },
  );

  if (new URL(page.url()).pathname === "/login") {
    const body = (await page.locator("body").innerText()).slice(0, 500);
    throw new Error(
      `login stayed on /login (${((Date.now() - startedAt) / 1000).toFixed(
        0,
      )}s): ${body.replace(/\n+/g, " | ")}`,
    );
  }

  // The app also has to render the authenticated shell.
  await expect(page.getByTestId("usermenu_open")).toBeVisible({
    timeout: 60_000,
  });
  console.log(
    `[e2e] logged in as ${QA_USER} in ${((Date.now() - startedAt) / 1000).toFixed(
      1,
    )}s`,
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
