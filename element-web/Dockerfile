# Element Web with Plotina noise suppression (DeepFilterNet3).
#
# Built on top of the pinned upstream image: the only additions are a small
# wrapper script, a vendored DFN module and the model assets. Upstream files are
# untouched apart from one <script> tag appended to /app/index.html.
FROM vectorim/element-web:v1.12.32@sha256:f8700633d4336258af7a05b53865a4f479e0d628cf2d9ca83d28b5939314d4ce

USER root

ARG DFN_BASE=https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3
ARG DFN_WASM_SHA256=440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432
ARG DFN_MODEL_SHA256=c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616

# Model assets are fetched at build time and pinned by checksum, so the image is
# reproducible and clients never talk to the upstream CDN at runtime.
# The base image is Alpine: no curl, BusyBox wget handles HTTPS fine.
RUN set -eux; \
    mkdir -p /app/noise/dfn/v3/pkg /app/noise/dfn/v3/models; \
    wget -q -O /app/noise/dfn/v3/pkg/df_bg.wasm "$DFN_BASE/pkg/df_bg.wasm"; \
    echo "$DFN_WASM_SHA256  /app/noise/dfn/v3/pkg/df_bg.wasm" | sha256sum -c -; \
    gzip -9 -k /app/noise/dfn/v3/pkg/df_bg.wasm; \
    wget -q -O /app/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz "$DFN_BASE/models/DeepFilterNet3_onnx.tar.gz"; \
    echo "$DFN_MODEL_SHA256  /app/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz" | sha256sum -c -

COPY noise/logic.js /app/noise/logic.js
COPY noise/boot.js /app/noise/boot.js
COPY noise/vendor/ /app/noise/vendor/

RUN set -eux; \
    grep -q '</head>' /app/index.html; \
    test -f /etc/nginx/templates/default.conf.template; \
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
    location /noise/ {\
        add_header Cache-Control "no-cache";\
    }\
' /etc/nginx/templates/default.conf.template; \
    grep -q "/noise/dfn/" /etc/nginx/templates/default.conf.template

RUN set -eux; \
    sed -i 's#</head>#<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script></head>#' /app/index.html; \
    grep -q 'noise/boot.js' /app/index.html; \
    grep -q 'noise/logic.js' /app/index.html

USER nginx
