#!/usr/bin/env bash
# End-to-end check: a headless Chromium with a fake microphone records the same
# noisy signal twice, once through the voice-message path (must stay raw) and
# once through the call path (must be attenuated). Needs the built image.
set -euo pipefail

IMAGE="${IMAGE:-plotina/element-web:1.12.32-noise1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${PORT:-8096}"
NAME="element-noise-it"
CHROME="${CHROME:-chromium}"
WAV=/tmp/plotina-noise-it.wav
LOG=/tmp/plotina-noise-it.log

python3 - "$WAV" <<'PY'
import math, random, struct, sys, wave
sr, dur, out = 48000, 20, sys.argv[1]
random.seed(7)
with wave.open(out, "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    frames = bytearray()
    for i in range(sr * dur):
        t = i / sr
        noise = random.uniform(-1, 1) * 0.25
        tone = 0.15 * math.sin(2 * math.pi * 440 * t)
        amp = 0.6 + 0.4 * math.sin(2 * math.pi * 0.5 * t)
        frames += struct.pack("<h", int(max(-1, min(1, (noise + tone) * amp)) * 32767))
    w.writeframes(bytes(frames))
PY

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  kill "${LOGGER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:80" \
  -v "$ROOT/config.json:/app/config.json:ro" "$IMAGE" >/dev/null
sleep 3
docker cp "$HERE/integration.html" "$NAME:/app/integration.html"

rm -f "$LOG"
python3 - "$LOG" <<'PY' &
import http.server, sys, urllib.parse
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/log":
            open(out, "a").write(u.query + "\n")
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8098), H).serve_forever()
PY
LOGGER_PID=$!
sleep 1

rm -rf /tmp/chr-noise-it
timeout 90 "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/chr-noise-it --use-fake-ui-for-media-stream \
  --use-fake-device-for-media-stream --use-file-for-fake-audio-capture="$WAV" \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:${PORT}/integration.html" >/dev/null 2>&1 || true

sleep 1
python3 - "$LOG" <<'PY'
import json, sys, urllib.parse
lines = [l for l in open(sys.argv[1]) if "data=" in l]
if not lines:
    print("integration: no result (page did not report)"); sys.exit(1)
d = json.loads(urllib.parse.unquote(lines[-1].split("data=", 1)[1]))
for k in ("bootLoaded", "support", "defaultLevel", "rms_voicemsg", "rms_call_60", "rms_call_0", "ratio_60", "ratio_0", "error"):
    if k in d: print(f"  {k} = {d[k]}")
ok = (
    d.get("bootLoaded") is True
    and d.get("support") is True
    and d.get("defaultLevel") == 60
    and d.get("ratio_60", 1) < 0.5   # call audio is suppressed
    and d.get("ratio_0", 0) > 0.8    # level 0 is a passthrough
)
print("integration:", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
PY
