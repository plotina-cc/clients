#!/usr/bin/env bash
# Thin wrapper: the build lives in build.py (tests in tests/build_py_test.py).
# Kept so CI and muscle memory keep calling element-call/build.sh.
exec python3 "$(dirname "$0")/build.py" "$@"
