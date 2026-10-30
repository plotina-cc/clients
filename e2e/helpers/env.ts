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

/**
 * Long-lived access token for the QA account.
 *
 * This is the supported way to authenticate now: plotina.cc delegates login to
 * MAS with `passwords.enabled: false`, so `m.login.password` answers
 * `400 M_UNKNOWN Invalid login type` and only SSO and `m.login.token` are
 * offered. MAS issues legacy (compatibility) tokens for automation with
 * `mas-cli manage issue-compatibility-token`; they have no expiry and are
 * bound to the device id passed on the command line. In CI the token lives in
 * the repository secret `E2E_ACCESS_TOKEN`; it is never committed.
 */
export const QA_ACCESS_TOKEN = value("E2E_ACCESS_TOKEN") ?? "";

/**
 * Password credentials, kept only as an explicit fallback for a deployment
 * that still accepts `m.login.password`. They are used when
 * `E2E_ACCESS_TOKEN` is absent and both variables are set.
 */
export const QA_USER = value("QA_NOISE_USER") ?? "";
export const QA_PASSWORD = value("QA_NOISE_PASSWORD") ?? "";

/**
 * Matrix device id used by the password fallback.
 *
 * Logging in with a device id that already exists invalidates the previous
 * access token for it (verified: the second login makes the first token answer
 * 401), so two runs that share a device id cannot be alive at the same time.
 * CI uses `E2EPW-ci`, a workstation `E2EPW-laptop`; keep one id per runner.
 *
 * A pre-issued access token carries the device id it was created with, so this
 * variable does not affect the token path.
 */
export const DEVICE_ID = value("E2E_DEVICE_ID") ?? "E2EPW";

/**
 * Test room (`Plotina noise E2E`, join rule: invite) created by the QA account
 * on plotina.cc. Only @qa-noise:plotina.cc is joined to it.
 */
export const DEFAULT_ROOM_ID =
  "!Dql1BcBsXZHYbc3rEg3MlJGE3e_be6LQDc6CSuFYvTE";

export const ROOM_ID = value("E2E_ROOM_ID") ?? DEFAULT_ROOM_ID;

export const hasCredentials =
  QA_ACCESS_TOKEN.length > 0 ||
  (QA_USER.length > 0 && QA_PASSWORD.length > 0);
