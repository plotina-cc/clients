# Element Web with the Plotina brand and noise suppression (DeepFilterNet3).
#
# Built on top of the pinned upstream image: the additions are a small wrapper
# script, a vendored DFN module, the model assets and one tested brand pass
# (branding.py). The brand replacements deliberately live in branding.py and
# element-web/tests/branding_test.py, not in a sed chain here, so a future
# upstream change fails against assertions instead of silently serving Element
# branding.
FROM vectorim/element-web:v1.12.32@sha256:f8700633d4336258af7a05b53865a4f479e0d628cf2d9ca83d28b5939314d4ce

USER root

# The upstream image ships no licence or notice file at /app. AGPL-3.0 requires
# the text and a modification notice to travel with the served app, so carry
# both; these copies are byte-identical to ../LICENSE and ../NOTICE.
COPY LICENSE-AGPL-3.0 /app/LICENSE-AGPL-3.0
COPY NOTICE /app/NOTICE

ARG DFN_BASE=https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3
ARG DFN_WASM_SHA256=440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432
ARG DFN_MODEL_SHA256=c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616

# Model assets are fetched at build time and pinned by checksum, so the image is
# reproducible and clients never talk to the upstream CDN at runtime. Build hosts
# that cannot reach the CDN (ISP blocks) can pre-seed the gitignored noise/dfn
# tree; the COPY below carries whatever is there (.keep files keep the
# directories present in the build context), the fetch is skipped only when the
# real file exists, and the checksum check always runs.
# The base image is Alpine: no curl, BusyBox wget handles HTTPS fine.
COPY noise/dfn/ /app/noise/dfn/
RUN set -eux; \
    if [ -s /app/noise/dfn/v3/pkg/df_bg.wasm ]; then \
        echo "using pre-seeded df_bg.wasm"; \
    else \
        wget -q -O /app/noise/dfn/v3/pkg/df_bg.wasm "$DFN_BASE/pkg/df_bg.wasm"; \
    fi; \
    echo "$DFN_WASM_SHA256  /app/noise/dfn/v3/pkg/df_bg.wasm" | sha256sum -c -; \
    gzip -9 -k /app/noise/dfn/v3/pkg/df_bg.wasm; \
    if [ -s /app/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz ]; then \
        echo "using pre-seeded DeepFilterNet3 model"; \
    else \
        wget -q -O /app/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz "$DFN_BASE/models/DeepFilterNet3_onnx.tar.gz"; \
    fi; \
    echo "$DFN_MODEL_SHA256  /app/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz" | sha256sum -c -; \
    rm -f /app/noise/dfn/v3/pkg/.keep /app/noise/dfn/v3/models/.keep

COPY noise/logic.js /app/noise/logic.js
COPY noise/boot.js /app/noise/boot.js
COPY noise/vendor/ /app/noise/vendor/
# DPDFNet experimental backend: the two big binaries (ort wasm + model) are
# gitignored and pinned by SHA-256 in noise/dpdfnet.lock.json — same policy as
# the DFN3 assets above, so fetch them at build time instead of shipping the
# un-fetched context. fetch-dpdfnet.py and the lock ride in /tmp only, like
# branding.py; noise/tests never enters the image (the COPYs above are
# selective). The Alpine base already trusts CAs (the wget step proves it);
# python3 comes in as a virtual package and leaves again.
COPY noise/scripts/fetch-dpdfnet.py /tmp/fetch-dpdfnet.py
COPY noise/dpdfnet.lock.json /tmp/dpdfnet.lock.json
RUN set -eux; \
    apk add --no-cache --virtual .dpdfnet python3; \
    python3 /tmp/fetch-dpdfnet.py --lock /tmp/dpdfnet.lock.json --dest /app/noise; \
    apk del .dpdfnet; \
    rm -f /tmp/fetch-dpdfnet.py /tmp/dpdfnet.lock.json; \
    gzip -9 -k /app/noise/vendor/ort/ort-wasm-simd-threaded.wasm; \
    test -s /app/noise/vendor/dpdfnet.esm.js; \
    test -s /app/noise/vendor/ort/ort.wasm.bundle.min.mjs; \
    test -s /app/noise/vendor/ort/ort-wasm-simd-threaded.mjs; \
    test -f /app/noise/vendor/ort/ort-wasm-simd-threaded.wasm.gz; \
    test -f /app/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/model_stateful.onnx; \
    test -s /app/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/initial_states.bin; \
    test -s /app/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/initial_states.json; \
    test -s /app/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/config.ini; \
    ! test -e /app/noise/tests; ! test -e /app/noise/scripts
COPY plotina-icon.svg /app/plotina-icon.svg
COPY plotina-512.png /app/plotina-512.png
# First-visit theme bootstrap (THEMES.md part 2). branding.py injects the
# <script> tag directly before the bundle loader in index.html; the payload
# itself rides in here, same pattern as the icons.
COPY plotina-theme.js /app/plotina-theme.js
# plotina-icon-192.png is the apple-touch-icon target and plotina-bg.png the
# welcome background config.json points at. Both are byte-copies of
# branding/icons/png/green-192.png / green-256.png: element-web/ is the build
# context, so assets are duplicated here (same pattern as LICENSE-AGPL-3.0) and
# branding_test.py fails the pair apart on any drift.
COPY plotina-icon-192.png /app/plotina-icon-192.png
COPY plotina-bg.png /app/plotina-bg.png
COPY manifest.json /app/manifest.json

# The stock error dialog and theme assets load their mark from
# themes/element/img/logos/element-app-logo.png; overwrite the file itself with
# the Plotina mark (plotina-512.png is branding/icons/png/green-512.png) so
# every consumer of that path is branded. branding.py also rewrites the
# error-view chunk to load /plotina-512.png directly.
COPY plotina-512.png /app/themes/element/img/logos/element-app-logo.png

# Assumptions about the stock layout, checked before the brand pass: a new
# upstream release that moves any of these fails here with a readable message,
# which is exactly what the "Bumping upstream" section of README.md wants.
RUN set -eux; \
    chmod 0644 /app/LICENSE-AGPL-3.0 /app/NOTICE /app/plotina-icon.svg /app/plotina-512.png \
      /app/plotina-icon-192.png /app/plotina-bg.png /app/manifest.json \
      /app/plotina-theme.js \
      /app/themes/element/img/logos/element-app-logo.png; \
    grep -q '</head>' /app/index.html; \
    test -s /app/LICENSE-AGPL-3.0; \
    test -s /app/NOTICE; \
    test -f /etc/nginx/templates/default.conf.template; \
    test -s /app/manifest.json; \
    test -f /app/config.json; \
    ls /app/bundles/*/error-view.js >/dev/null; \
    ls /app/bundles/*/theme-*-custom.css >/dev/null; \
    test -e /app/themes/element/img/logos/element-logo.svg; \
    test -e /app/themes/element/img/logos/opengraph.png; \
    test -d /app/mobile_guide; \
    echo "upstream layout ok"

# The entrypoint regenerates conf.d/default.conf from templates/default.conf.template
# via envsubst on every start, so the template is what has to change here.
# Long cache for model assets, no cache for the wrapper itself: a fix must reach
# browsers without a hard reload.
RUN set -eux; \
    sed -i '/location = \/index.html/i\
    location /noise/dfn/ {\
        gzip_static on;\
        add_header Cache-Control "public, max-age=2592000";\
    }\
    location /noise/vendor/ort/ {\
        gzip_static on;\
        add_header Cache-Control "public, max-age=2592000";\
    }\
    location /noise/vendor/dpdfnet/ {\
        gzip_static on;\
        add_header Cache-Control "public, max-age=2592000";\
    }\
    location /noise/ {\
        add_header Cache-Control "no-cache";\
    }\
' /etc/nginx/templates/default.conf.template; \
    grep -q "/noise/dfn/" /etc/nginx/templates/default.conf.template; \
    grep -q "/noise/vendor/ort/" /etc/nginx/templates/default.conf.template; \
    grep -q "/noise/vendor/dpdfnet/" /etc/nginx/templates/default.conf.template

# The two noise <script> tags belong to the noise overlay, not to the brand:
# they are inserted here, before branding.py runs, and the brand pass leaves
# them byte-identical (tests/branding_test.py guards that contract).
RUN set -eux; \
    sed -i 's#</head>#<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script></head>#' /app/index.html; \
    grep -q 'noise/logic.js' /app/index.html; \
    grep -q 'noise/boot.js' /app/index.html

# Every brand replacement — index.html head and noscript, the error-view
# chunk, the config.json branding block, the element-logo.svg overwrite and
# the opengraph.png removal — runs through the tested branding.py instead of
# scattered seds. The base image is Alpine without python3, so the interpreter
# comes in as a virtual package and leaves again: the final image ships none.
# branding.py itself goes to /tmp, never into the served /app.
COPY branding.py /tmp/branding.py
RUN set -eux; \
    apk add --no-cache --virtual .branding python3; \
    python3 /tmp/branding.py --app /app; \
    rm -f /tmp/branding.py; \
    apk del .branding; \
    rm -rf /app/mobile_guide; \
    chmod 0644 /app/themes/element/img/logos/element-logo.svg; \
    grep -q '<title>Plotina Web</title>' /app/index.html; \
    grep -q 'name="apple-mobile-web-app-title" content="Plotina Web"' /app/index.html; \
    grep -q 'name="application-name" content="Plotina Web"' /app/index.html; \
    grep -q 'name="theme-color" content="#17795A"' /app/index.html; \
    grep -q 'content="https://chat.plotina.cc/plotina-512.png"' /app/index.html; \
    grep -q 'href="/plotina-icon.svg"' /app/index.html; \
    grep -q 'href="/plotina-icon-192.png"' /app/index.html; \
    grep -q 'plotina-modal-a11y' /app/index.html; \
    test -s /app/plotina-theme.js; \
    grep -q 'plotina-theme.js"></script><script src="bundles/' /app/index.html; \
    ! grep -q 'var(--timeline-text-color)' /app/bundles/*/theme-*-custom.css; \
    test "$(grep -oh 'var(--timeline-text-color,var(--cpd-color-text-primary))' \
      /app/bundles/*/theme-*-custom.css | wc -l)" -ge 266; \
    grep -q 'sign_out_before_verify' /app/i18n/ru.*.json; \
    ! grep -q 'Element requires JavaScript' /app/index.html; \
    ! grep -q 'vector-icons/' /app/index.html; \
    ! grep -q 'element-app-logo' /app/bundles/*/error-view.js; \
    grep -q '/plotina-bg.png' /app/config.json; \
    cmp /app/plotina-icon.svg /app/themes/element/img/logos/element-logo.svg; \
    ! test -e /app/themes/element/img/logos/opengraph.png; \
    ! test -e /app/mobile_guide; \
    grep -q '"name": "Plotina Web"' /app/manifest.json; \
    grep -q 'noise/boot.js' /app/index.html; \
    grep -q 'noise/logic.js' /app/index.html
USER nginx
