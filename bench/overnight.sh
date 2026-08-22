#!/bin/sh
# The full batch, in priority order.
#
# Ordered so that stopping early still leaves the valuable half done: the
# phi-versus-pi comparison first, then the two sweeps, then the cheaper tasks.
# Every run appends to bench/results.jsonl as it finishes, so nothing is lost if
# this is interrupted.
#
# Each step is allowed to fail without taking the batch down with it. A step
# that dies is one arm missing, not a lost night.
set -u
cd "$(dirname "$0")/.."
LOG=bench/overnight.log
say() { printf '\n=== %s  %s ===\n' "$1" "$(date +%H:%M:%S)" | tee -a "$LOG"; }

say "1/5 phi vs pi on ledger, effort held equal"
node bench/run.mjs --task ledger --harness phi,pi --effort high --runs 3 --timeout 30 2>&1 | tee -a "$LOG"

say "2/5 does thinking earn its cost"
node bench/run.mjs --task ledger --harness phi --effort off,low,medium,high --runs 2 --timeout 30 2>&1 | tee -a "$LOG"

say "3/5 does a cheap compaction summary hurt"
node bench/run.mjs --task ledger --harness phi --compact-thinking off,low,medium --runs 2 --timeout 30 2>&1 | tee -a "$LOG"

say "4/5 architecture: change cost and regressions"
node bench/run.mjs --task exporter --harness phi,pi --runs 3 --timeout 20 2>&1 | tee -a "$LOG"

say "5/5 greenfield fluency"
node bench/run.mjs --task tetris --harness phi,pi --runs 2 --timeout 30 2>&1 | tee -a "$LOG"

say "done"
