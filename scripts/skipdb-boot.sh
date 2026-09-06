#!/bin/bash
# SkipDB backfill bot — double-detach boot (survives session boundaries):
# setsid + nohup + disown. Single instance enforced via pidfile.
cd /home/z/my-project
PIDFILE=/tmp/skipdb-backfill.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  echo "[skipdb-boot] already running (pid $(cat $PIDFILE))"
  exit 0
fi
setsid nohup node scripts/skipdb-backfill.mjs </dev/null >> scripts/skipdb-backfill.log 2>&1 &
disown 2>/dev/null
echo $! > "$PIDFILE"
echo "[skipdb-boot] $(date -Is) launched (pid $!)"
