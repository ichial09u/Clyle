#!/bin/bash
# Idempotent watchdog: ensures the 24/7 fleets (21-lane intro scout + dub
# probe swarm, the paced Jikan episode-title backfill, the dub-audio sweep,
# and the bug-patrol crawler) are running. Called by fleet-watchdog-loop.sh
# every 5 minutes; starts any fleet that is not running.
#
# Single-instance guards: each check is a pgrep on the fleet's distinctive
# argv, so overlapping watchdog ticks are harmless. The reap step below also
# kills DUPLICATE supervisors/lanes that older boots (or the pre-fix
# instrumentation bootstrap) left behind — the OOM-spiral defense.
cd /home/z/my-project
mkdir -p scripts

# ---------- reap duplicates (OOM-spiral defense) ----------
# more than one live instance of any fleet/supervisor -> keep the oldest, kill the rest
reap() {
  local pattern="$1"
  local pids
  pids=$(pgrep -f "$pattern" | sort -n)
  local n
  n=$(echo "$pids" | grep -c . || true)
  if [ "$n" -gt 1 ]; then
    local keep
    keep=$(echo "$pids" | head -1)
    for pid in $pids; do
      if [ "$pid" != "$keep" ]; then
        kill -9 "$pid" 2>/dev/null
        echo "[watchdog] $(date -Is) reaped duplicate $pattern pid $pid (kept $keep)"
      fi
    done
  fi
}
reap "intro-scout.mjs --loop"
reap "scout-supervisor.sh"
reap "backfill-ep-titles.mjs"
reap "title-supervisor.sh"
reap "dub-audio-sweep.mjs"
reap "dub-audio-supervisor.sh"
reap "bug-patrol.mjs --loop"
reap "patrol-supervisor.sh"

# ---------- start anything missing ----------

if ! pgrep -f "intro-scout.mjs --loop" > /dev/null 2>&1; then
  # stale supervisor loop? kill it so we never double-supervise
  pkill -f "scout-supervisor.sh" 2>/dev/null
  setsid nohup bash scripts/scout-supervisor.sh </dev/null >> scripts/scout-fleet.log 2>&1 &
  echo "[watchdog] $(date -Is) started scout supervisor (pid $!)"
fi

if ! pgrep -f "backfill-ep-titles.mjs" > /dev/null 2>&1; then
  pkill -f "title-supervisor.sh" 2>/dev/null
  setsid nohup bash scripts/title-supervisor.sh </dev/null >> scripts/backfill-titles.log 2>&1 &
  echo "[watchdog] $(date -Is) started title backfill (pid $!)"
fi

if ! pgrep -f "dub-audio-sweep.mjs" > /dev/null 2>&1; then
  pkill -f "dub-audio-supervisor.sh" 2>/dev/null
  setsid nohup bash scripts/dub-audio-supervisor.sh </dev/null >> scripts/dub-audio-sweep.log 2>&1 &
  echo "[watchdog] $(date -Is) started dub-audio sweep (pid $!)"
fi

if ! pgrep -f "bug-patrol.mjs --loop" > /dev/null 2>&1; then
  pkill -f "patrol-supervisor.sh" 2>/dev/null
  setsid nohup bash scripts/patrol-supervisor.sh </dev/null >> scripts/bug-patrol.log 2>&1 &
  echo "[watchdog] $(date -Is) started bug patrol (pid $!)"
fi
