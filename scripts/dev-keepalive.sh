#!/bin/bash
# Dev-server keepalive — the site MUST stay up. Everything on this box gets
# reaped periodically (kernel cgroup shows no OOM kills — it's the sandbox's
# own reaper); the catalog fleet survives via its supervisors, so the dev
# server gets the same treatment. Memory-gated spawn.
#
# LIVE APP = /home/z/my-project/src (the root dir is a stale platform
# scaffold — never serve from there). Bun for speed; absolute log path so
# the cwd never matters.
cd /home/z/my-project/src
LOG=/home/z/my-project/scripts/dev-keepalive.log
while true; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 --max-time 8 2>/dev/null | grep -q "^2\|^3"; then
    sleep 30
    continue
  fi
  avail=$(free -m | awk '/^Mem:/{print $7}')
  echo "[dev-keepalive] $(date -Is) site down (${avail}MB available) — starting" >> "$LOG"
  if [ "$avail" -lt 500 ]; then
    sleep 60
    continue
  fi
  bun run dev >> /dev/null 2>&1
  echo "[dev-keepalive] $(date -Is) dev server exited code=$?" >> "$LOG"
  sleep 10
done
