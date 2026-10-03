#!/bin/bash
# OP-sub campaign supervisor — heartbeat + memory gate + restart loop.
# Launched via fleet-boot.sh (inline setsid launches get reaped ~6-8 min in;
# fleet-boot children demonstrably survive). The campaign resumes from
# scripts/op-sub-fleet-results.jsonl on every restart.
cd /home/z/my-project
while true; do
  avail=$(free -m | awk '/^Mem:/{print $7}')
  if [ "$avail" -lt 550 ]; then
    echo "[op-sub-sup] $(date -Is) low memory (${avail}MB) — waiting" >> scripts/op-sub-supervisor.log
    sleep 90
    continue
  fi
  echo "[op-sub-sup] $(date -Is) starting campaign (${avail}MB available)" >> scripts/op-sub-supervisor.log
  node scripts/op-sub-intro-bots.mjs --lanes 6 --decode-slots 4 --loop >> scripts/op-sub-fleet-boot.log 2>&1 &
  NODEPID=$!
  # heartbeat + liveness: log every 60s, restart the node if it died
  while true; do
    sleep 60
    if ! kill -0 "$NODEPID" 2>/dev/null; then
      wait "$NODEPID"; CODE=$?
      echo "[op-sub-sup] $(date -Is) node exited code=$CODE — respawning in 20s" >> scripts/op-sub-supervisor.log
      sleep 20
      break
    fi
    echo "[op-sub-sup] $(date -Is) node alive pid=$NODEPID" >> scripts/op-sub-supervisor.log
  done
done
