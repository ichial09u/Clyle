#!/bin/bash
# Cron is unavailable in this sandbox — this wrapper IS the cron: it runs the
# idempotent fleet watchdog every 5 minutes forever, so the 21-lane intro
# scout + dub probe swarm and the paced Jikan title backfill stay up 24/7.
cd /home/z/my-project
while true; do
  bash scripts/fleet-watchdog.sh >> scripts/watchdog-loop.log 2>&1
  sleep 300
done
