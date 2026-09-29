#!/usr/bin/env bash
# One-command sandbox loop for the sticky-rung-per-conversation scenario (epic #17).
# Runs the acceptance scenario through the real worker route (src/index.js `handle()`) with fake
# upstreams and an in-memory store. Deterministic: exit 0 = scenario holds, 1 = scenario breaks.
#
# RED by design until slices S3–S9 land: the scenario currently breaks at turn 1 (`pin=new` missing)
# — that red is the sandbox working, not a test bug.
set -euo pipefail
cd "$(dirname "$0")/../.."

out="$(mktemp)"
if node --test test/sandbox/sticky-rung.sandbox.test.js >"$out" 2>&1; then
  echo "SANDBOX PASS: sticky-rung scenario holds (turn 1..8 green)"
  rm -f "$out"
  exit 0
fi
echo "SANDBOX FAIL: sticky-rung scenario breaks"
grep -E '^not ok|✖|assertion|AssertionError' "$out" | head -12 || true
rm -f "$out"
exit 1