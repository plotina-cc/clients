#!/usr/bin/env bash
# Local preflight: everything that can be checked without building.
#
#   scripts/preflight.sh
#
# Runs the unit suites, validates the Python and shell entry points and parses
# every workflow. Artifact checks (APK/deb/AppImage internals) need a build and
# live in the per-client scripts; this is the fast gate before pushing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

section() { printf '\n== %s\n' "$1"; }
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

run_py() {
  local dir="$1" pattern="$2" label="$3"
  [ -d "$dir" ] || { ok "$label (нет каталога, пропуск)"; return; }
  if python3 -m unittest discover -s "$dir" -p "$pattern" >/tmp/preflight-$label.log 2>&1; then
    ok "$label"
  else
    bad "$label — см. /tmp/preflight-$label.log"
  fi
}

section "python unit tests"
run_py element-web/tests 'test_*.py' element-web
run_py element-desktop/tests 'test_*.py' element-desktop
run_py noise/tests '*_test.py' noise
run_py cinny/tests 'test_*.py' cinny
run_py fluffychat/tests 'test_*.py' fluffychat

section "python syntax"
while IFS= read -r file; do
  python3 -m py_compile "$file" && ok "$file" || bad "$file"
done < <(find . -path ./.git -prune -o -name '*.py' -print | grep -v node_modules)
find . -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

section "shell syntax"
while IFS= read -r file; do
  bash -n "$file" && ok "$file" || bad "$file"
done < <(find . -path ./.git -prune -o -name '*.sh' -print | grep -v node_modules)

section "workflows parse"
# PyYAML may live in the system interpreter, not in the active venv.
YAML_PY=python3
python3 -c 'import yaml' 2>/dev/null || YAML_PY=/usr/bin/python3
"$YAML_PY" - <<'PY'
import glob, sys
import yaml
bad = []
for path in glob.glob('.github/workflows/*.yml'):
    try:
        list(yaml.safe_load_all(open(path)))
    except Exception as exc:  # noqa: BLE001
        bad.append(f'{path}: {exc}')
for line in bad:
    print('  FAIL', line)
sys.exit(1 if bad else 0)
PY
[ $? -eq 0 ] && ok "workflows" || bad "workflows"

[ "$fail" -eq 0 ] || { echo; echo "preflight: FAILED"; exit 1; }
echo; echo "preflight: ok"
