# Cinny Web

The same `noise/` bundle that Element Web ships, served next to the static Cinny
build on `cinny.plotina.cc`. Cinny Web is the easiest surface we control: no
packaging, no fork, the files are just copied and two `<script>` tags are added.

## What the deployment does

1. Copy `noise/` to the static root of the Cinny bundle (`/srv/cinny/noise` on
   the edge host), so `/noise/logic.js` resolves at the same origin.
2. Insert the tags into the two documents that need them:
   - `index.html` — the app shell, gets
     `<script src="/noise/logic.js"></script><script src="/noise/cinny-ui.js" defer></script>`
     which renders the level slider in Settings → General;
   - `public/element-call/index.html` — the embedded Element Call page, the only
     document that actually calls `getUserMedia`, gets
     `<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script>`.
3. Cache headers stay as they are on the edge: `/noise/dfn/*` is cached for 30
   days, `/noise/*.js` is `no-cache` so a fix reaches browsers without a hard
   reload.

Keep the edits idempotent — grep for the marker before inserting, and keep a
`.bak-plotina` copy of each patched document so an upstream deploy can be
re-applied and diffed.

## Why two documents

Cinny renders calls in an iframe pointing at `public/element-call/index.html`;
that iframe has its own `window`, so wrapping `getUserMedia` in the parent page
would never see the call. The parent page only needs the settings UI.

## Verifying

- `https://cinny.plotina.cc/noise/logic.js` must return 200.
- Open Settings → General: the «Подавление шума» slider sits at the top of the
  section, level 60 by default (`localStorage` key `plotina.noise.level`).
- Start a call and check `window.__plotinaNoise.isSupported()` inside the
  iframe: `true` means the DeepFilterNet3 module loaded; `window.__plotinaNoiseStats`
  counts `callRequests`, `otherAudioRequests`, `processed` and `failed`, which is
  how a silent upstream change in the constraint shape shows up.
