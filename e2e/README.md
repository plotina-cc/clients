# Element Call noise-suppression E2E

Browser checks for the DeepFilterNet3 integration served at
<https://call.plotina.cc>. Two tests:

| Spec | What it proves |
| :-- | :-- |
| `tests/noise-attach.spec.ts` | Logs in as the QA account, joins the test room, publishes the microphone and waits for `window.__plotinaDfn.status === "attached"` (60 s). This is the real path through Element Call's publisher hook. |
| `tests/noise-effect.spec.ts` | Feeds synthetic white noise through the same processor module in a real browser and asserts that the 300–3400 Hz energy drops. No account needed. |

The suite runs against **production** (`https://call.plotina.cc`), so it is a
smoke test of what is deployed, not of the working tree.

## Run it in GitHub Actions (the default)

`.github/workflows/e2e-element-call.yml` runs on `workflow_dispatch` and on a
push that touches `e2e/**`.

- `E2E_ACCESS_TOKEN` — repository secret: the QA account's long-lived MAS
  compatibility token. This is what CI uses.
- `QA_NOISE_USER`, `QA_NOISE_PASSWORD` — repository secrets, kept only as a
  fallback for a deployment that still accepts `m.login.password`; ignored
  while the token is set.
- `E2E_ROOM_ID` — repository variable; falls back to the value compiled into
  `helpers/env.ts`.

If the token and the password pair are absent the job prints a notice and exits
green without running anything: a fork or a fresh clone must not fail because
it has no credentials. The report and the traces are uploaded with `if: always()`.

## Run it on a workstation, never on a production host

```bash
cd e2e
npm ci
npx playwright install --with-deps chromium

install -m 600 /dev/null .env       # then fill in the values below
npx playwright test
npx playwright show-report
```

`playwright.config.ts` loads `.env` with `process.loadEnvFile`, so the file is
read only by the test runner. `.env` and `node_modules/` are gitignored; the
password must never be committed, pasted into a command line or put in a
`README`.

| Variable | Required | Meaning |
| :-- | :-- | :-- |
| `E2E_ACCESS_TOKEN` | attach test | MAS compatibility token for `@qa-noise:plotina.cc`; the preferred path. |
| `QA_NOISE_USER` | fallback only | Matrix localpart (`qa-noise`) or full MXID of the QA account. |
| `QA_NOISE_PASSWORD` | fallback only | Its password; password login is disabled on plotina.cc. |
| `E2E_ROOM_ID` | no | Room the account is already joined to; defaults to `helpers/env.ts`. |
| `E2E_BASE_URL` | no | Defaults to `https://call.plotina.cc`. |
| `E2E_HOMESERVER` | no | Defaults to `https://plotina.cc`; where the API login goes. |
| `E2E_DEVICE_ID` | no | Matrix device id for the login. One per runner: `E2EPW-ci` here, `E2EPW-laptop` on a workstation. |

**Do not run Playwright on golova or on the edge host.** Chromium plus the
16 MB WASM module and the 8 MB model are the memory-heaviest thing we run, and
a browser run on the call host once took the machine down and rebooted it.
The production hosts serve traffic; they are not test runners. Use a laptop or
the GitHub runner.

## The test room

`Plotina noise E2E` is a private, invite-only room on `plotina.cc`; only
`@qa-noise:plotina.cc` is joined to it. Its ID is the default in
`helpers/env.ts`. To recreate it after a homeserver wipe, issue a token first
(see "Issuing the CI access token") and keep it in a file, never on a command
line:

```bash
jq -n '{name:"Plotina noise E2E",preset:"private_chat",visibility:"private",
        creation_content:{"m.federate":false},
        initial_state:[{type:"m.room.join_rules",state_key:"",content:{join_rule:"invite"}}]}' \
  | curl -sS -X POST https://plotina.cc/_matrix/client/v3/createRoom \
      -H "Authorization: Bearer $(cat ~/.qa-noise-token)" \
      -H 'Content-Type: application/json' --data-binary @- \
  | jq -r .room_id
```

Put the result in `E2E_ROOM_ID` (or replace the default in `helpers/env.ts`).

## How the test logs in

`helpers/login.ts` prefers a pre-issued access token (`E2E_ACCESS_TOKEN`). It
calls `/account/whoami` once to validate the token and learn the user and the
device it is bound to, writes that session to
`localStorage["matrix-auth-store"]` — the entry `ClientContext.tsx` reads on
every reload — and lets Element Call restore it. No `/login` request is made.

Password login no longer works on `plotina.cc`: the homeserver delegates
authentication to MAS with `passwords.enabled: false`, so `/login` answers
`400 M_UNKNOWN Invalid login type` and offers only `m.login.sso` and
`m.login.token`. `QA_NOISE_USER` / `QA_NOISE_PASSWORD` survive only as an
explicit fallback: they are used when `E2E_ACCESS_TOKEN` is empty and both are
set, which is useful only against a deployment that still accepts
`m.login.password`.

The API is used rather than the `/login` form on purpose:

- **The form can hang forever.** Element Call's login promise only resolves
  after `initClient` sees the first sync reach `PREPARED`
  (`src/utils/matrix.ts`, `waitForSync`). On a cold profile that step
  intermittently never finishes: the page keeps long-polling `/sync` and stays
  on "Logging in…" with the button disabled. It happened twice in four attempts
  on a workstation (one run hung the whole 180 s we allowed), while the same
  account restores a session in 1.5 s through the API, and the app restores it
  in 12–16 s. That is an upstream defect worth reporting, not something this
  suite should paper over with a retry.
- **It is the path users hit anyway**: the restore code is what runs on every
  reload, and it still initialises Rust crypto, sync and the call.
- **It keeps the device count stable**: a compatibility token carries the
  device id it was issued with (`E2EPW-ci` for CI), so repeated runs reuse one
  Matrix device instead of adding one per run. The password fallback passes
  `E2E_DEVICE_ID` for the same reason, and its id must differ per runner,
  because a login with an existing device id revokes that device's previous
  access token — this Synapse answers `401` on the old token immediately.

If the homeserver is ever rate-limiting password logins (`M_LIMIT_EXCEEDED`),
the fallback fails immediately with the HTTP body instead of timing out.

`attached` is set by `noise/plotina-dfn.js` only after
`track.setProcessor(filter)` resolves, and the hook runs from the publisher's
`LocalTrackPublished` event. A green attach test therefore means: Element Call
published a microphone track, and the processor was constructed and attached to
that track with the real WASM and model from `/noise/dfn/`.

## Issuing the CI access token

`E2E_ACCESS_TOKEN` is a MAS compatibility token, minted with the service's own
CLI on the host that runs MAS (`golova`). The CLI also creates the token's
Matrix device on Synapse, which Synapse requires on every request.

```bash
docker exec mtx-mas mas-cli -c /config.yaml manage issue-compatibility-token \
  qa-noise E2EPW-ci 2> ~/.mas-issue.log
grep -oE 'mct_[A-Za-z0-9_-]+' ~/.mas-issue.log | head -1 > ~/.qa-noise-token
chmod 600 ~/.qa-noise-token ~/.mas-issue.log

gh secret set E2E_ACCESS_TOKEN -R plotina-cc/clients < ~/.qa-noise-token
rm -f ~/.mas-issue.log
```

- The CLI logs the token itself to stderr. Redirect that to a mode-600 file and
  never paste the whole log into a ticket, a chat or a commit.
- `qa-noise` is the MAS username; `E2EPW-ci` is the device id the token is
  bound to. Synapse checks that this device row still exists: if it was
  deleted, even a token MAS still knows answers
  `401 M_UNKNOWN_TOKEN "Token is not active"`, so re-issue instead of debugging
  the app.
- The token does not expire (`compat_access_tokens.expires_at` is `NULL`), and
  this deployment has no `policy` block and an empty `policy_data`, so MAS'
  `expire-inactive-sessions` job has nothing to expire either. It stays valid
  until the session is revoked or the device is deleted.
- Do not run `mas-cli manage kill-sessions qa-noise` while CI relies on the
  token: it finishes the sessions and its `sync-devices` job deletes the device
  rows, after which every existing token fails with 401. Re-issue afterwards.
- `--yes-i-want-to-grant-synapse-admin-privileges` is not used: the browser
  test only needs the client-server API, not the Synapse admin API.

## Artifacts

`test-results/results.json`, `playwright-report/`, a trace per failure, and
`attach-failure.json` (page state, `__plotinaDfn`, status history, console,
page errors, failed requests and 4xx/5xx responses) next to the trace. The
attach test also attaches `plotina-attached.json` on success, with the elapsed
time and the final state.
