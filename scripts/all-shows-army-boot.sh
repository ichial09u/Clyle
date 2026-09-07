#!/bin/bash
# All-shows skip-intro army + SkipDB backfill loop — double-detach boot
# (setsid + nohup + disown, survives session env restarts)
cd /home/z/my-project

# 1) the verification army (16 verify + 6 repair lanes)
if ! pgrep -f "all-shows-skip-army.mjs" >/dev/null 2>&1; then
  setsid nohup node scripts/all-shows-skip-army.mjs --wave2 --repair-only --lanes 1 --repair-lanes 14 </dev/null >> scripts/all-shows-skip-army.out 2>&1 &
  disown 2>/dev/null
  echo "[boot] all-shows-skip-army launched (pg $!)"
else
  echo "[boot] all-shows-skip-army already running"
fi

# 2) the SkipDB backfill loop — vendors SkipDB fills for the 925 gap shows
if ! pgrep -f "skipdb-backfill.mjs" >/dev/null 2>&1; then
  setsid nohup node scripts/skipdb-backfill.mjs </dev/null >> scripts/skipdb-backfill.log 2>&1 &
  disown 2>/dev/null
  echo "[boot] skipdb-backfill launched (pg $!)"
else
  echo "[boot] skipdb-backfill already running"
fi
