#!/bin/bash
# Dev-server keepalive — the site MUST stay up. Everything on this box gets
# reaped periodically (kernel cgroup shows no OOM kills — it's the sandbox's
# own reaper); the catalog fleet survives via its supervisors, so the dev
# server gets the same treatment. Memory-gated spawn.
cd /home/z/my-project
while true; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 --max-time 8 2>/dev/null | grep -q "^2\|^3"; then
    sleep 30
    continue
  fi
  avail=$(free -m | awk '/^Mem:/{print $7}')
  echo "[dev-keepalive] $(date -Is) site down (${avail}MB available) — starting" >> scripts/dev-keepalive.log
  if [ "$avail" -lt 500 ]; then
    sleep 60
    continue
  fi
  npm run dev >> /dev/null 2>&1
  echo "[dev-keepalive] $(date -Is) dev server exited code=$?" >> scripts/dev-keepalive.log
  sleep 10
done
