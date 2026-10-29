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

- `QA_NOISE_USER`, `QA_NOISE_PASSWORD` — repository secrets.
- `E2E_ROOM_ID` — repository variable; falls back to the value compiled into
  `helpers/env.ts`.

If the two secrets are absent the job prints a notice and exits green without
running anything: a fork or a fresh clone must not fail because it has no
credentials. The report and the traces are uploaded with `if: always()`.

## Run it on a workstation, never on a production host

```bash
cd e2e
npm ci
npx playwright install --with-deps chromium

install -m 600 /dev/null .env       # then edit in the four values below
npx playwright test
npx playwright show-report
```

`playwright.config.ts` loads `.env` with `process.loadEnvFile`, so the file is
read only by the test runner. `.env` and `node_modules/` are gitignored; the
password must never be committed, pasted into a command line or put in a
`README`.

| Variable | Required | Meaning |
| :-- | :-- | :-- |
| `QA_NOISE_USER` | attach test | Matrix localpart (`qa-noise`) or full MXID of the QA account. |
| `QA_NOISE_PASSWORD` | attach test | Its password. |
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
`helpers/env.ts`. To recreate it after a homeserver wipe (password only through
the environment, never as an argument):

```bash
jq -n --arg u "$QA_NOISE_USER" --arg p "$QA_NOISE_PASSWORD" \
  '{type:"m.login.password",identifier:{type:"m.id.user",user:$u},password:$p}' \
  | curl -sS -X POST https://plotina.cc/_matrix/client/v3/login \
      -H 'Content-Type: application/json' --data-binary @- \
  | jq -r .access_token > /tmp/matrix-token

jq -n '{name:"Plotina noise E2E",preset:"private_chat",visibility:"private",
        creation_content:{"m.federate":false},
        initial_state:[{type:"m.room.join_rules",state_key:"",content:{join_rule:"invite"}}]}' \
  | curl -sS -X POST https://plotina.cc/_matrix/client/v3/createRoom \
      -H "Authorization: Bearer $(cat /tmp/matrix-token)" \
      -H 'Content-Type: application/json' --data-binary @- \
  | jq -r .room_id
```

Put the result in `E2E_ROOM_ID` (or replace the default in `helpers/env.ts`).

## How the test logs in

The helper does a real `m.login.password` against the homeserver with
`QA_NOISE_USER` / `QA_NOISE_PASSWORD`, then writes the resulting session to
`localStorage["matrix-auth-store"]` — the entry `ClientContext.tsx` reads on
every reload — and lets Element Call restore it. It uses the API rather than
the `/login` form on purpose:

- **The form can hang forever.** Element Call's login promise only resolves
  after `initClient` sees the first sync reach `PREPARED`
  (`src/utils/matrix.ts`, `waitForSync`). On a cold profile that step
  intermittently never finishes: the page keeps long-polling `/sync` and stays
  on "Logging in…" with the button disabled. It happened twice in four attempts
  on a workstation (one run hung the whole 180 s we allowed), while the same
  account logs in through the API in 1.5 s and the app restores the session in
  12–16 s. That is an upstream defect worth reporting, not something this suite
  should paper over with a retry.
- **It is the path users hit anyway**: the restore code is what runs on every
  reload, and it still initialises Rust crypto, sync and the call.
- **It keeps the device count stable**: the login passes a fixed
  `device_id` (`E2E_DEVICE_ID`), so repeated runs reuse one Matrix device
  instead of adding one per run (the QA account had six after a few manual
  attempts). The id must differ per runner, because a login with an existing
  device id revokes that device's previous access token — this Synapse answers
  `401` on the old token immediately. Two concurrent runs sharing an id killed
  each other's session during the first CI attempt here; `E2EPW-ci` and
  `E2EPW-laptop` keep CI and a workstation out of each other's way.

If the homeserver is ever rate-limiting logins (`M_LIMIT_EXCEEDED`), the helper
fails immediately with the HTTP body instead of timing out.

`attached` is set by `noise/plotina-dfn.js` only after
`track.setProcessor(filter)` resolves, and the hook runs from the publisher's
`LocalTrackPublished` event. A green attach test therefore means: Element Call
published a microphone track, and the processor was constructed and attached to
that track with the real WASM and model from `/noise/dfn/`.

## The effect test and the production change it does not need

`noise-effect.spec.ts` builds a deterministic white-noise `MediaStreamTrack`
with WebAudio, hands it to `DeepFilterNoiseFilterProcessor` from
`/noise/vendor/dfn.esm.js`, and measures the input and
`processor.processedTrack` with `AnalyserNode`s in 300–3400 Hz. The measured
reduction on the current deployment is ~70 dB (input −61 dB, output −132 dB,
i.e. the model silences pure noise). The assertion is deliberately loose
(≥ 3 dB) so it catches a no-op processor, not model tuning.

The app itself does not expose the processed track: `window.__plotinaDfn`
carries `{status, level, error, track}` and `track` is the string `"audio"`.
Measuring the **published** track from the test would need this minimal change
in `noise/plotina-dfn.js` (not applied — production is not modified for tests):

```js
var filter = new Processor({ /* ... */ });          // already there
return track.setProcessor(filter).then(function () {
  state.processedTrack = filter.processedTrack;     // <- new
});
```

With that one property the test could attach an `AnalyserNode` to the real
published microphone track after `attached`, instead of to a processor built by
the test. The current spec still covers the risky part — the WASM, the model
download and the worklet — because it runs exactly the module and assets the
page loads.

## Known issues found while building this

- `POST /noise/report` answers **405** on `call.plotina.cc`: Caddy's
  `file_server` has no such route, so every diagnostic beacon from
  `plotina-dfn.js` is dropped. The wrapper swallows the failure, so it does not
  affect calls; it only means there is no server-side log to correlate with a
  failed attach.
- One participant is enough to publish and attach, but the suite does not
  verify that the far end receives denoised audio. That needs a second
  participant and a recorded receiver track; neither exists yet.

## Artifacts

`test-results/results.json`, `playwright-report/`, a trace per failure, and
`attach-failure.json` (page state, `__plotinaDfn`, status history, console,
page errors, failed requests and 4xx/5xx responses) next to the trace. The
attach test also attaches `plotina-attached.json` on success, with the elapsed
time and the final state.
