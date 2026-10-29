/**
 * Configuration of the Element Call end-to-end checks.
 *
 * Credentials come from the environment only — never from the repository.
 * `E2E_ROOM_ID` points at the throwaway room the QA account owns on
 * plotina.cc; it is overridable so the same suite can run against another
 * deployment. An empty variable (a workflow that passes `vars.E2E_ROOM_ID`
 * before anyone set it) falls back to the default rather than disabling the
 * test.
 */

function value(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export const BASE_URL = value("E2E_BASE_URL") ?? "https://call.plotina.cc";

/** Homeserver the QA account lives on; the app's config.json points here too. */
export const HOMESERVER = value("E2E_HOMESERVER") ?? "https://plotina.cc";

export const QA_USER = value("QA_NOISE_USER") ?? "";
export const QA_PASSWORD = value("QA_NOISE_PASSWORD") ?? "";

/**
 * Matrix device id used for the login.
 *
 * Logging in with a device id that already exists invalidates the previous
 * access token for it (verified: the second login makes the first token answer
 * 401), so two runs that share a device id cannot be alive at the same time.
 * CI uses `E2EPW-ci`, a workstation `E2EPW-laptop`; keep one id per runner.
 */
export const DEVICE_ID = value("E2E_DEVICE_ID") ?? "E2EPW";

/**
 * Test room (`Plotina noise E2E`, join rule: invite) created by the QA account
 * on plotina.cc. Only @qa-noise:plotina.cc is joined to it.
 */
export const DEFAULT_ROOM_ID =
  "!Dql1BcBsXZHYbc3rEg3MlJGE3e_be6LQDc6CSuFYvTE";

export const ROOM_ID = value("E2E_ROOM_ID") ?? DEFAULT_ROOM_ID;

export const hasCredentials = QA_USER.length > 0 && QA_PASSWORD.length > 0;
