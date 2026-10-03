#!/bin/bash
# Timestamp Army keeper — cloud-side edition.
# The fleet resolves + measures + reports against the VERCEL deployment, so a
# local process death loses nothing: the queue rebuilds from the local DB and
# unmeasured eps simply re-queue on the next launch. The keeper relaunches the
# (lightweight, ~150MB) fleet client whenever the sandbox reaps it.
cd /home/z/my-project

# single-keeper guard (never matches self: fleet check is the real guard)

BASE="https://temporary-spry-granite-1f0h7ae.vercel.app"

while true; do
  if ! pgrep -f "timestamp-army-1000.mjs" >/dev/null 2>&1; then
    if [ -f scripts/timestamp-army-report.json ]; then
      sleep 1800  # campaign complete — keeper idles
    else
      echo "[keeper $(date +%H:%M:%S)] fleet not running — launching (base=$BASE)"
      setsid nohup node scripts/timestamp-army-1000.mjs \
        --base "$BASE" --lanes 16 --lanes-min 10 --lanes-max 32 --bots 1000 \
        </dev/null >> scripts/timestamp-army.out 2>&1 &
      disown 2>/dev/null
      sleep 90
    fi
  fi
  sleep 30
done
