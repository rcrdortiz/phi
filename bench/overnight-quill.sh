#!/bin/sh
# Quill, in priority order. Step 0 gates the rest: if it reports zero
# compactions the later steps measure nothing, and if it runs long the plan
# shrinks. Each step may fail without taking the batch down.
set -u
cd "$(dirname "$0")/.."
LOG=bench/quill.log
say() { printf '\n=== %s  %s ===\n' "$1" "$(date +%H:%M:%S)" | tee -a "$LOG"; }

say "0/3 smoke: does quill compact, and what does a run cost"
node bench/run.mjs --task quill --harness phi --runs 1 --timeout 40 2>&1 | tee -a "$LOG"

say "1/3 phi vs pi, effort held equal at low"
node bench/run.mjs --task quill --harness phi,pi --effort low --runs 4 --timeout 40 2>&1 | tee -a "$LOG"

say "2/3 does a cheap compaction summary cost more than it saves"
node bench/run.mjs --task quill --harness phi --effort low --compact-thinking off,keep --runs 3 --timeout 40 2>&1 | tee -a "$LOG"

say "done"
