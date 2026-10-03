#!/bin/bash
# Timestamp Scout Army (1,000-bot roster) + SkipDB backfill — double-detach boot
# (setsid + nohup + disown, survives session env restarts; pgrep guard = idempotent)
cd /home/z/my-project

# 1) the timestamp army — 48 starting lanes, governor 24..96
if ! pgrep -f "timestamp-army-1000.mjs" >/dev/null 2>&1; then
  setsid nohup node scripts/timestamp-army-1000.mjs --lanes 32 --lanes-min 16 --lanes-max 64 --bots 1000 </dev/null >> scripts/timestamp-army.out 2>&1 &
  disown 2>/dev/null
  echo "[boot] timestamp-army launched (pg $!)"
else
  echo "[boot] timestamp-army already running"
fi

# 2) the SkipDB backfill loop — complementary vendor fills for gap shows
if ! pgrep -f "skipdb-backfill.mjs" >/dev/null 2>&1; then
  setsid nohup node scripts/skipdb-backfill.mjs </dev/null >> scripts/skipdb-backfill.log 2>&1 &
  disown 2>/dev/null
  echo "[boot] skipdb-backfill launched (pg $!)"
else
  echo "[boot] skipdb-backfill already running"
fi
