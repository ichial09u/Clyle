#!/bin/bash
# Backup-network dub-audio fleet boot — double-detach (setsid + nohup +
# disown). Idempotent (pgrep-guarded); re-run any time (cron/watchdog/hand)
# to resurrect the fleet after an environment restart. The sweep exits after
# each pass; the supervisor keeps taking passes. If the sandbox kills the
# bash supervisor, booting the node sweep directly also works — every pass
# is DB-driven and resumable, so no state is ever lost either way.
cd /home/z/my-project

if ! pgrep -f "dub-audio-supervisor-backup.sh" >/dev/null 2>&1; then
  setsid nohup bash scripts/dub-audio-supervisor-backup.sh </dev/null > scripts/dub-audio-supervisor-backup.out 2>&1 &
  disown 2>/dev/null
  echo "[boot] backup dub-audio supervisor launched (pg $!)"
else
  echo "[boot] backup dub-audio supervisor already running"
fi

if ! pgrep -f "dub-audio-sweep-backup.mjs" >/dev/null 2>&1; then
  # give the supervisor a beat to start its own first pass; if it did not
  # survive, boot one pass directly so verdicts still flow
  sleep 2
  if ! pgrep -f "dub-audio-sweep-backup.mjs" >/dev/null 2>&1; then
    setsid nohup node scripts/dub-audio-sweep-backup.mjs 40 </dev/null >> scripts/dub-audio-sweep-backup.log 2>&1 &
    disown 2>/dev/null
    echo "[boot] direct sweep pass launched (pg $!)"
  fi
else
  echo "[boot] sweep already running"
fi
