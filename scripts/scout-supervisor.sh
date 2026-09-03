#!/bin/bash
# Supervisor for the Clyle intro-scout fleet — restarts the swarm if the
# process ever dies, so the bots run 24/7.
cd /home/z/my-project
while true; do
  echo "[supervisor] $(date -Is) starting fleet"
  node scripts/intro-scout.mjs --loop --lanes 21 >> scripts/scout-fleet.log 2>&1
  echo "[supervisor] $(date -Is) fleet exited ($?) — restarting in 30s"
  sleep 30
done
