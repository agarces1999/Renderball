#!/bin/bash
# LOOP 2 — the supervisor / watchdog. Runs in parallel to LOOP 1 (the build
# worker) and keeps it alive. Owns the dev server. Restarts the worker/server on
# death or stall, applies new commits at safe iteration boundaries, and stops
# everything at the target. Launch DETACHED + under caffeinate so neither the
# session nor sleep can take it down:
#   nohup caffeinate -is bash scripts/loop/rb-watchdog.sh >.../watchdog.out 2>&1 </dev/null & disown
set +e
# Operate on the repo this script lives in (script is at <repo>/scripts/loop/),
# so the loop runs against whatever worktree it's launched from — not a hardcoded
# path. (Was pinned to VIDEO_GEN-speed, which silently ran the wrong worktree.)
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1
LOOPDIR=.data/loops
mkdir -p "$LOOPDIR/results"
DEVLOG="$LOOPDIR/dev.log"
WLOG="$LOOPDIR/watchdog.log"
PORT=3007
STALL=2700        # dev.log silent > 45min during a build = wedged (a single high-effort GLM call can be silent ~15min; 45min avoids false-kills)
POLL=60
LAST_HEAD=""
log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$WLOG"; }

jget(){ python3 -c "import json,sys;print(json.load(open('$1')).get('$2',$3))" 2>/dev/null; }

# escalate(): the watchdog can RESTART, but only the agent can FIX a code/flow bug
# that keeps breaking loop 1. When restarts won't help (crash-loop / persistent
# infra), drop a needs_fix signal the agent picks up to fix the REAL product code
# — never a harness shortcut; loop 1 must stay true to the user flow. Latest
# symptom wins.
escalate(){
  python3 -c "import json,os,time,sys; t=open('$DEVLOG').read()[-2000:] if os.path.exists('$DEVLOG') else ''; json.dump({'symptom':sys.argv[1],'ts':int(time.time()),'iso':time.strftime('%Y-%m-%d %H:%M:%S'),'devlog_tail':t}, open('$LOOPDIR/needs_fix.json','w'), indent=2)" "$1" 2>/dev/null
  log "ESCALATED needs_fix: $1"
}
RESTARTS=""
record_restart(){
  local now recent c=0; now=$(date +%s); RESTARTS="$RESTARTS $now"; recent=""
  for t in $RESTARTS; do if [ $(( now - t )) -le 900 ]; then recent="$recent $t"; c=$((c+1)); fi; done
  RESTARTS="$recent"
  log "unplanned restart ($c in last 15min)"
  if [ "$c" -ge 3 ]; then escalate "loop-1 crash-loop: $c server/worker restarts in 15min — restarting is not fixing it; needs a code/flow fix in the real pipeline"; fi
}

server_up(){ curl -sf -o /dev/null "http://localhost:$PORT/" 2>/dev/null; }
loop_up(){ pgrep -f "rb-build-loop.mjs" >/dev/null 2>&1; }

start_server(){
  lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null
  sleep 2
  RB_DEV_HEAP_MB=8192 PORT=$PORT nohup node scripts/dev.mjs -p $PORT > "$DEVLOG" 2>&1 &
  for i in $(seq 1 80); do server_up && { log "dev server up"; return 0; }; sleep 3; done
  log "dev server FAILED to come up"; return 1
}
start_loop(){
  loop_up && return 0
  nohup node scripts/loop/rb-build-loop.mjs >> "$LOOPDIR/build-loop.log" 2>&1 &
  log "build-loop started (pid $!)"
}

# auto_qa(): the QA step, run AUTONOMOUSLY (this is what makes the loop self-driving
# overnight — previously qa_done only advanced when the agent did it by hand in a
# session, so the gate parked and the worker stalled). The build POST already ran
# EVERY gate — render-truth, contrast, structural, and the GLM-5V-Turbo vision gate —
# so the QA verdict already exists. Here we: capture that verdict into qa_log, advance
# qa_done so the loop keeps moving, and — when a build FAILED or any gate flagged
# something — drop needs_review.json so the agent reviews + commits SYSTEMIC fixes
# async (applied at the next safe phase). The agent no longer hand-advances qa_done.
auto_qa(){
  python3 - "$LOOPDIR" >> "$WLOG" 2>/dev/null <<'PY'
import json,sys,os,glob,time
loop=sys.argv[1]; sp=loop+'/state.json'
try: st=json.load(open(sp))
except Exception: sys.exit(0)
built=st.get('built',0) or 0; qa=st.get('qa_done',0) or 0
if built<=qa: sys.exit(0)                      # nothing parked
aq=loop+'/awaiting_qa.json'
if not os.path.exists(aq): sys.exit(0)          # build still in flight, not parked yet
try: info=json.load(open(aq))
except Exception: sys.exit(0)
slug=info.get('slug','?'); ok=info.get('ok'); findings=[]; warns=0
res=sorted(glob.glob(loop+'/results/%03d-*.json'%built))
if res:
  d=json.load(open(res[-1])); b=d.get('build') or {}
  ok=b.get('ok')
  findings=[(f.get('scene'),str(f.get('issue'))[:90]) for f in (d.get('vision') or [])]
  w=(b.get('warnings') or {}); warns=sum(len(v) for v in w.values() if isinstance(v,list))
st['qa_done']=built
st.setdefault('qa_log',[]).append({'iter':built,'slug':slug,'auto':True,
  'verdict':'AUTO-QA (watchdog): ok=%s · %d vision finding(s) · %d gate warning(s)'%(ok,len(findings),warns),
  'findings':findings,'at':time.strftime('%Y-%m-%dT%H:%M:%S')})
tmp=sp+'.tmp'; json.dump(st,open(tmp,'w'),indent=2); os.replace(tmp,sp)   # atomic
try: os.remove(aq)
except OSError: pass
if (ok is False) or findings or warns:
  json.dump({'symptom':'auto-QA parked iter %d %s for agent review: ok=%s findings=%d warns=%d'%(built,slug,ok,len(findings),warns),
             'iter':built,'slug':slug,'ts':int(time.time()),'iso':time.strftime('%Y-%m-%d %H:%M:%S')},
            open(loop+'/needs_review.json','w'),indent=2)
print('[%s] AUTO-QA advanced qa_done -> %d (%s ok=%s findings=%d warns=%d)'%(time.strftime('%Y-%m-%d %H:%M:%S'),built,slug,ok,len(findings),warns))
PY
}

log "===== watchdog starting ====="
start_server
LAST_HEAD=$(git rev-parse --short HEAD 2>/dev/null)
start_loop

while true; do
  auto_qa   # autonomous QA: capture each completed build's gate verdict + advance qa_done so the loop never parks waiting for a human
  qa_done=$(jget "$LOOPDIR/state.json" qa_done 0); qa_done=${qa_done:-0}
  target=$(jget "$LOOPDIR/state.json" target 100); target=${target:-100}
  if [ "$qa_done" -ge "$target" ] 2>/dev/null; then
    log "TARGET reached (qa_done $qa_done/$target) — stopping worker + server."
    pkill -f rb-build-loop.mjs 2>/dev/null
    lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null
    log "===== watchdog done ====="
    exit 0
  fi

  # 1) dev server health
  if ! server_up; then
    log "dev server DOWN -> restart (+ worker)"
    pkill -f rb-build-loop.mjs 2>/dev/null
    start_server
    LAST_HEAD=$(git rev-parse --short HEAD 2>/dev/null)
    start_loop
    record_restart
    sleep "$POLL"; continue
  fi

  # 2) apply new commits at a SAFE boundary (between iterations), so fixes compound
  HEAD=$(git rev-parse --short HEAD 2>/dev/null)
  if [ -n "$HEAD" ] && [ "$HEAD" != "$LAST_HEAD" ]; then
    phase=$(jget "$LOOPDIR/heartbeat.json" phase '""'); phase=$(echo "$phase" | tr -d '"')
    if [ "$phase" = "done" ] || [ "$phase" = "finished" ] || [ "$phase" = "generate" ] || [ "$phase" = "infra-backoff" ] || [ "$phase" = "awaiting-qa" ]; then
      log "git HEAD $LAST_HEAD -> $HEAD at safe phase '$phase' — restarting server to apply fixes"
      pkill -f rb-build-loop.mjs 2>/dev/null
      start_server
      LAST_HEAD=$HEAD
      start_loop
      sleep "$POLL"; continue
    else
      log "git HEAD changed ($LAST_HEAD -> $HEAD) but phase='$phase' (mid-build) — deferring restart"
    fi
  fi

  # 3) worker alive?
  if ! loop_up; then log "worker DOWN -> restart"; start_loop; record_restart; fi

  # 3b) persistent infra: worker stuck unable to reach a build verdict (server not
  # serving builds). A restart loop won't help — escalate for a real fix.
  phase=$(jget "$LOOPDIR/heartbeat.json" phase '""'); phase=$(echo "$phase" | tr -d '"')
  if [ "$phase" = "infra-backoff" ]; then
    INFRA_SINCE=${INFRA_SINCE:-$(date +%s)}
    if [ $(( $(date +%s) - INFRA_SINCE )) -gt 420 ] 2>/dev/null; then
      escalate "loop-1 persistent infra: worker stuck in infra-backoff >7min — builds are not reaching a verdict"
    fi
  else
    INFRA_SINCE=""
  fi

  # 4) wedged build? Track the last REAL build-activity line, FILTERING OUT the
  # health-ping (GET / …) and HMR "Compiled" lines — those keep dev.log mtime
  # perpetually fresh and silently DEFEATED the old mtime check (a wedge never
  # fired). Real activity = [pipeline] lines, POST completions, errors. If the
  # last real line hasn't changed in STALL seconds, the build is wedged. A single
  # silent GLM call is ~10-30min < STALL, so no false positive.
  if [ -f "$DEVLOG" ]; then
    real=$(grep -avE "GET / [0-9]| Compiled |Compiling" "$DEVLOG" 2>/dev/null | tail -1)
    nowts=$(date +%s)
    if [ "$real" != "${LAST_REAL:-}" ]; then LAST_REAL="$real"; LAST_REAL_TS=$nowts; fi
    if [ -n "${LAST_REAL_TS:-}" ] && [ $(( nowts - LAST_REAL_TS )) -gt "$STALL" ] 2>/dev/null; then
      log "WEDGED: no real build activity in $(( nowts - LAST_REAL_TS ))s (> ${STALL}s) -> kill+restart server+worker"
      pkill -f rb-build-loop.mjs 2>/dev/null
      start_server
      LAST_HEAD=$(git rev-parse --short HEAD 2>/dev/null)
      start_loop
      record_restart
      LAST_REAL=""; LAST_REAL_TS=$nowts
    fi
  fi

  sleep "$POLL"
done
