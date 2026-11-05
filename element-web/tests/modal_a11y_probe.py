#!/usr/bin/env python3
"""Probe the Plotina Element device-verification modal without logging in.

Injects the CompleteSecurity "Intro" DOM (the markup produced by
mx_AuthPage > Glass.mx_Dialog_border > mx_CompleteSecurityBody >
mx_EncryptionCard.mx_SetupEncryptionBody, copied from the pinned
v1.12.32 bundle) into the live chat.plotina.cc login page, measures it at
laptop viewport heights, then applies the branding CSS fix and re-measures.

Read-only: never types credentials; the probe node is removed at the end.

Run (headless browser harness required):
    python3 modal_a11y_probe.py [--url URL] [--heights 768,620,560,500]
"""
from __future__ import annotations
import argparse, importlib.util, json, time

from browser_harness.helpers import (  # same helpers browser_exec pre-imports
    new_tab, wait_for_load, goto_url, js, cdp,
)

# Reuse the exact CSS that branding.py injects, so the probe always tests the
# shipped block rather than a drifting copy.
_spec = importlib.util.spec_from_file_location(
    "branding", __file__.rsplit("/", 1)[0] + "/../branding.py")
assert _spec is not None and _spec.loader is not None
_branding = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_branding)
FIX_CSS = _branding.MODAL_CSS

BTN = "_button_1nw83_8"  # compound-web Button CSS-module hash in bundle.css

MARKUP = """
(function(){
 document.getElementById('probe-authpage')?.remove();
 // Attach to <body>, NOT #matrixchat: that subtree belongs to React and to
 // the noise overlay, both of which replace/clean unknown children and made
 // a probe node vanish mid-measurement. The wrapper is position:fixed inset
 // 0, so the CSS chain (html/body height:100%) is identical to the real one.
 const host=document.body;
 const d=document.createElement('div');
 d.innerHTML = `
 <div id="probe-authpage" class="mx_AuthPage" style="position:fixed;inset:0;z-index:6000;background:center/cover fixed url(/plotina-bg.png)">
   <div class="mx_AuthPage_modal" style="position:relative;background:initial">
     <main class="mx_AuthPage_modalContent" style="display:flex;z-index:1;border-radius:inherit">
       <div class="mx_Dialog_border">
         <div class="mx_CompleteSecurityBody">
           <h1 class="mx_CompleteSecurity_header">
             <div class="mx_AccessibleButton mx_CompleteSecurity_skip" role="button" aria-label="skip"><svg width="20" height="20"></svg></div>
           </h1>
           <div class="mx_CompleteSecurity_body">
             <div class="mx_EncryptionCard mx_EncryptionCard_noBorder mx_SetupEncryptionBody">
               <div class="mx_EncryptionCard_header">
                 <h2>Подтвердите свою цифровую личность</h2>
                 <div class="mx_EncryptionCard_emphasisedContent">
                   <span>Подтвердите это устройство, чтобы настроить безопасный обмен сообщениями.</span>
                   <span><a href="#">Узнать больше</a></span>
                 </div>
               </div>
               <div class="mx_EncryptionCard_buttons">
                 <button class="__BTN__" data-size="md" data-kind="primary"><svg width="20" height="20"></svg> Используйте другое устройство</button>
                 <button class="__BTN__" data-size="md" data-kind="primary">Используйте recovery key</button>
                 <button class="__BTN__" data-size="md" data-kind="secondary">Не можете подтвердить?</button>
                 <button class="__BTN__" data-size="md" data-kind="tertiary">Sign out</button>
               </div>
             </div>
           </div>
         </div>
       </div>
     </main>
   </div>
   <footer class="mx_AuthFooter" role="contentinfo"><a href="#">Blog</a><a href="#">Mastodon</a><a href="#">GitHub</a></footer>
 </div>`;
 host.appendChild(d.firstElementChild);
 return document.getElementById('probe-authpage') ? 'injected' : 'failed';
})()
""".replace("__BTN__", BTN)

# ---- the fix; keep byte-identical with the block branding.py injects -------
FIX_CSS = """\
.mx_AuthPage_modal{margin-bottom:50px}\
.mx_AuthPage_modalContent .mx_Dialog_border{max-height:calc(100vh - 150px);overflow-y:auto}\
"""

APPLY_FIX = """(function(){
 document.getElementById('probe-fix')?.remove();
 const s=document.createElement('style');
 s.id='probe-fix';
 s.textContent=%s;
 document.head.appendChild(s);
 return 'fix applied';
})()""" % json.dumps(FIX_CSS)

MEASURE = """(()=>{const g=document.querySelector('.mx_Dialog_border');
const bs=document.querySelectorAll('.mx_EncryptionCard_buttons button');
if(!g||!bs.length) return {error:'probe node missing'};
const so=bs[bs.length-1].getBoundingClientRect();
const ap=document.getElementById('probe-authpage');
const b=document.body;
return {vh:innerHeight,
 glass:{h:Math.round(g.getBoundingClientRect().height), scrollH:g.scrollHeight,
        clientH:g.clientHeight, overflowY:getComputedStyle(g).overflowY,
        scrolls:g.scrollHeight>g.clientHeight},
 signout:{top:Math.round(so.top), bottom:Math.round(so.bottom),
          fullyVisible:so.bottom<=innerHeight&&so.top>=0},
 authPage:{scrolls:ap.scrollHeight>ap.clientHeight, sh:ap.scrollHeight, ch:ap.clientHeight},
 bodyScrolls:b.scrollHeight>innerHeight};})()"""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="https://chat.plotina.cc/")
    p.add_argument("--heights", default="768,620,560,500")
    a = p.parse_args()
    heights = [int(x) for x in a.heights.split(",")]

    new_tab(a.url)
    wait_for_load()
    time.sleep(2.0)
    print("page:", a.url)
    print(js(MARKUP))
    # Fonts and the runtime-injected custom-theme variables land late; if we
    # measure before they apply, the card renders at its unstyled height and
    # BASE looks fine. Poll until the Glass box stops changing.
    settle = """(()=>{const g=document.querySelector('.mx_Dialog_border');
        return g?Math.round(g.getBoundingClientRect().height):-1;})()"""
    last, stable = None, 0
    for _ in range(30):
        cur = js(settle)
        if cur is not None and cur == last and cur > 0:
            stable += 1
            if stable >= 3:
                break
        else:
            stable = 0
        last = cur
        time.sleep(0.5)
    else:
        print("warning: layout never stabilized, measurements may be stale")
    for label, apply in (("BASE", False), ("FIX", True)):
        if apply:
            print(js(APPLY_FIX))
        for h in heights:
            cdp("Emulation.setDeviceMetricsOverride",
                width=1366, height=h, deviceScaleFactor=1, mobile=False)
            time.sleep(0.4)
            print(f"{label:4s} h={h}: {json.dumps(js(MEASURE), ensure_ascii=False)}")
    # clean up so nothing is left on the loaded page
    js("(document.getElementById('probe-authpage')?.remove(),"
       "document.getElementById('probe-fix')?.remove(),'cleaned')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
