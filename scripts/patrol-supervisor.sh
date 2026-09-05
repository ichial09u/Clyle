#!/bin/bash
# Supervisor for the bug-patrol crawler — restarts it if it ever dies.
# The patrol is a 24/7 site crawler: every API route (status/shape/latency),
# stream resolution for sampled animes (sub + dub), DB consistency rules,
# poster art reachability, and prod latency probes. Findings land in the
# BugReport table (dedup + reopen-on-regression).
cd /home/z/my-project
while true; do
  echo "[patrol-supervisor] $(date -Is) starting bug patrol"
  stdbuf -oL -eL node scripts/bug-patrol.mjs --loop >> scripts/bug-patrol.log 2>&1
  code=$?
  echo "[patrol-supervisor] $(date -Is) patrol exited ($code) — restarting in 15s"
  sleep 15
done
