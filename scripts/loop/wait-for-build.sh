#!/bin/bash
# Alarm clock for the agent's QA step. Exits 0 as soon as a loop build is
# awaiting QA (built > qa_done), or the target is reached, or a safety timeout.
# Run as a TRACKED background task so the agent gets a reliable notification the
# moment the next build is ready to QA (the detached worker can't notify).
#   Usage: bash scripts/loop/wait-for-build.sh [maxSeconds]
cd /Users/alfonsogarces/VIDEO_GEN-speed || exit 1
LOOPDIR=.data/loops
MAX=${1:-9000}   # 2.5h safety cap (a build + repair ladder can run long)
jget(){ python3 -c "import json;print(json.load(open('$LOOPDIR/state.json')).get('$1',$2))" 2>/dev/null; }
iters=$(( MAX / 20 ))
for i in $(seq 1 "$iters"); do
  built=$(jget built 0);   built=${built:-0}
  qa=$(jget qa_done 0);    qa=${qa:-0}
  target=$(jget target 100); target=${target:-100}
  if [ "$qa" -ge "$target" ] 2>/dev/null; then echo "TARGET_DONE qa_done=$qa/$target"; exit 0; fi
  if [ "$built" -gt "$qa" ] 2>/dev/null; then echo "BUILD_READY built=$built qa_done=$qa"; exit 0; fi
  sleep 20
done
echo "TIMEOUT after ${MAX}s (no build became ready — check the loop)"; exit 0
