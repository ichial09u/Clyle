#!/bin/bash
# Supervisor for the dub-audio sweep — keeps hunting fake dubs (Japanese audio
# under a DUB label, the DAN DA DAN bug) across the whole dub-claiming catalog,
# one paced sweep at a time. Restarts the sweep whenever it exits until every
# dub anime carries an audio verdict.
cd /home/z/my-project
while true; do
  echo "[supervisor] $(date -Is) starting dub-audio sweep"
  node scripts/dub-audio-sweep.mjs 40 >> scripts/dub-audio-sweep.log 2>&1
  echo "[supervisor] $(date -Is) sweep exited ($?) — next sweep in 10 min"
  sleep 600
done
