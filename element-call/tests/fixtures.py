"""Unbranded fixtures that mirror the upstream v0.26.1 release bundle.

The JS samples are copied verbatim out of the minified
``assets/index-FUQuguOr.js`` of ``element-call-0.26.1.tar.gz`` (backticks, the
way rolldown emits them), plus a single-quote variant of the same literals,
because a future build could emit either.  ``UNBRANDED_INDEX`` is a trimmed
``index.html`` with the noise tags already injected, so branding is tested in
the order build.sh runs it: inject-noise.py first, branding.py second.
"""

UPSTREAM_SHA256 = "552e16f81d602c5947087d0b1d7d5d0d5546f1bd34e5d5e84c9605d621e8f254"

UNBRANDED_INDEX = """<!doctype html><html lang="en"><head><script>window.__plotinaEc=true;</script><script src="/noise/logic.js"></script><meta charset="UTF-8"><link rel="icon" type="image/svg+xml" href="favicon.png"><link rel="preload" href="/config.json" as="fetch"><title>Element Call</title><script>window.global = window;</script><meta property="og:title" content="Element Call"><meta property="og:description" content="You're invited to join a call on Element Call"><meta property="og:type" content="website"><meta property="og:image" content="favicon.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Element Call"><meta name="twitter:description" content="You're invited to join a call on Element Call"><meta name="twitter:image" content="favicon.png"><script type="module" crossorigin src="/assets/index-FUQuguOr.js"></script><link rel="stylesheet" crossorigin href="/assets/index-ODgY4f6W.css"></head><body class="no-theme"><div id="root"></div></body></html>"""

# Every "Element Call" the branding rules own, in the exact byte context the
# minified bundle uses.
UNBRANDED_BUNDLE = r"""
(0,R.jsx)(`desc`,{children:`Element Call (Beta)`})
function ASe(e){F.error(`Failed to ask the host to close Element Call`,e)}
if(e!=`error`)try{await p.close?.()}catch(e){F.error(`Failed to ask the host to close Element Call`,e)}
r=t(`error.open_elsewhere_description`,{brand:`Element Call`})
i3.t(`error.matrix_rtc_transport_missing`,{domain:e,brand:`Element Call`,errorCode:`MISSING_MATRIX_RTC_TRANSPORT`})
(0,R.jsx)(`p`,{children:a(`version`,{productName:`Element Call`,version:`v0.26.1`})})
function t6(e){let t=(0,z.c)(3);n=()=>{let t=`Element Call`;document.title=e?`${t} | ${e}`:t}
(0,R.jsx)(lFe,{width:80,height:11,`aria-label`:`Element Call`})
F.info(`Element Call v0.26.1`)
t=(0,R.jsx)(QR,{href:`https://element.io/privacy`,children:`Privacy Policy`})
(0,R.jsx)(QR,{href:`https://element.io/cookie-policy`,children:`Cookie Policy`})
this.localisedMessageValues={linkUrl:`https://docs.element.io/latest/element-server-suite-pro/configuring-components/configuring-matrix-rtc/#sfu-connectivity-troubleshooting`}
"""

# The same literals as they appear in the upstream TypeScript sources: single
# quotes instead of backticks. Branding must not care which one the minifier
# chose.
UNBRANDED_BUNDLE_QUOTES = """
document.title=x;let y='Element Call (Beta)'
F.error('Failed to ask the host to close Element Call',e)
i18n.t('error.open_elsewhere_description',{brand:'Element Call'})
el.title = "Element Call"
render('version',{productName:'Element Call',version:'v0.26.1'})
function setTitle(e){let t="Element Call";document.title=e?`${t} | ${e}`:t}
console.info('Element Call 0.26.1')
href="https://element.io/privacy"
href="https://element.io/cookie-policy"
url='https://docs.element.io/latest/element-server-suite-pro/configuring-components/configuring-matrix-rtc/'
"""
