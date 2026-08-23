#!/bin/sh
# Set up one quill phase by hand, for running phi interactively.
#
# The benchmark drives phi through `--print`, and mid-run compaction is disabled
# there because compaction aborts the single turn a print run has and the resume
# cannot be delivered before the process exits. Interactive sessions do not have
# that problem: the resume lands, which is how the feature was built and tested.
#
# So this is the only way to exercise phi's actual design. It is manual on
# purpose: a person types the prompt, watches the compaction happen, and sees
# whether the run carries on afterwards.
#
#   sh bench/manual.sh          phase 1
#   sh bench/manual.sh 2        phase 2, in a tree you have already worked
set -eu
cd "$(dirname "$0")/.."
PHASE="${1:-1}"
TASK=bench/tasks/quill

if [ "$PHASE" = "1" ]; then
  DIR=$(mktemp -d /tmp/quill-manual-XXXXXX)
  cp -R "$TASK/repo/." "$DIR/"
  echo "$DIR" > /tmp/quill-manual-current
else
  DIR=$(cat /tmp/quill-manual-current 2>/dev/null || true)
  [ -n "$DIR" ] && [ -d "$DIR" ] || { echo "No tree from a previous phase. Start with phase 1."; exit 1; }
fi

echo
echo "  tree     $DIR"
echo "  prompt   $TASK/PHASE$PHASE.md"
echo
echo "  1. Open phi there:"
echo "       cd $DIR && phi"
echo
echo "  2. Paste the prompt:"
echo "       pbcopy < $(pwd)/$TASK/PHASE$PHASE.md     # then paste into phi"
echo
# A later phase needs to know what the earlier one had working, or a defect that
# was never fixed reads as a regression this phase caused.
if [ "$PHASE" != "1" ]; then
  PREV=$((PHASE - 1))
  node "$TASK/verify$PREV.mjs" "$DIR" > "$DIR/.bench-baseline-$PREV.json.tmp" 2>/dev/null &&
    node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p.replace(/\.tmp$/,""),JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8")).results));fs.rmSync(p)' "$DIR/.bench-baseline-$PREV.json.tmp" &&
    echo "  baseline  recorded phase $PREV as it stands now"
fi

echo "  3. When it finishes, grade it from here:"
echo "       node $(pwd)/$TASK/verify$PHASE.mjs $DIR"
echo
echo "  Watch for: a compaction firing mid-run, and whether the agent carries on"
echo "  afterwards or stops. That is the behaviour --print cannot show you."
echo
