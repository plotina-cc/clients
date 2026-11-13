# Screen-share QA harness (display capture)

Harnesses for the shell's display-capture path (`src/main.js`
`setDisplayMediaRequestHandler` + `desktopCapturer`). They exist because the
"share screen stops working" defect is timing/state dependent and can only be
reasoned about from logs of both edges: the page's `getDisplayMedia` promise
and the main-process handler/`getSources`/callback.

All paths are overridable by flag or env; nothing here is imported by the app.

| file | what it does |
| --- | --- |
| `run-share-probe.mjs` | launches the shell on a synthetic page (`probe-dist/`), runs N `getDisplayMedia` → stop cycles in one app run |
| `delta-probe.mjs` | measures how long the renderer stays wedged after a failed display request (Δ recovery, seconds) |
| `matrix-real.mjs` | trigger matrix in a real Element Call frame inside a real call (cycles, immediate restart, room switch, minimise/restore, idle, new call) |
| `cancel-sim/` | wrapper Electron app: runs the real `src/main.js` with `desktopCapturer` instrumented, and can make `getSources` fail like a cancelled xdg-desktop-portal ScreenCast picker (`SIM_CANCEL_AT=N`) |
| `probe-dist/index.html` | the synthetic page: `window.__probe({mode:'video'\|'ec'})` |

## Examples

```sh
# three share cycles in one run, EC's exact constraints
xvfb-run -a -s "-screen 0 1400x900x24" node qa/run-share-probe.mjs --mode ec --cycles 3

# cancelled-picker simulation: the 2nd getSources throws, then measure recovery
SIM_CANCEL_AT=2 xvfb-run -a -s "-screen 0 1400x900x24" \
  node qa/delta-probe.mjs --app-dir $PWD/qa/cancel-sim --retry-max 20

# full trigger matrix against a real call (needs a QA Matrix token + room)
QA_ROOM='!room:plotina.cc' xvfb-run -a -s "-screen 0 1440x900x24" node qa/matrix-real.mjs
```

The main-process side of `cancel-sim` logs with timestamps:

```
[dm] getSources #1 enter types=["screen"] fail=0
[dm] getSources #1 -> 1 source(s): Entire screen(screen:404:0)
[dm] handler ENTER origin=http://127.0.0.1:PORT mediaTypes=[...]
[dm] callback after 620ms -> {"keys":["video"],"video":true,"audio":false}
[dm] handler RETURNED WITHOUT CALLING callback (Nms) — request left pending
```
