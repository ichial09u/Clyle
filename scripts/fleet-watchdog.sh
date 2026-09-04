#!/bin/bash
# Idempotent watchdog: ensures the 24/7 fleets (21-lane intro scout + dub
# probe swarm, and the paced Jikan episode-title backfill) are running.
# Called by cron every few minutes; starts any fleet that is not running.
# All fleets are safe to run concurrently-guarded: each single-instance check
# is a pgrep on its distinctive argv, so overlapping cron ticks are harmless.
cd /home/z/my-project
mkdir -p scripts

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
