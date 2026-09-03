#!/bin/bash
# Supervisor for the episode-title backfill — restarts the script if it ever
# dies, until the catalog is fully titled (the script is a no-op then, so
# stop it manually once the DONE line shows 0 remaining).
cd /home/z/my-project
while true; do
  echo "[supervisor] $(date -Is) starting title backfill"
  stdbuf -oL -eL node scripts/backfill-ep-titles.mjs >> scripts/backfill-titles.log 2>&1
  code=$?
  echo "[supervisor] $(date -Is) backfill exited ($code) — restarting in 10s"
  # if the script finished cleanly it printed the DONE summary; keep looping
  # anyway — a finished run costs one query per minute and harms nothing,
  # and a fresh run immediately picks up anything still missing.
  sleep 10
done
