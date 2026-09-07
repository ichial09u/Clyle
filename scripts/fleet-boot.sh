#!/bin/bash
# Fleet boot — double-detach so the 24/7 fleet survives session boundaries
# (setsid + nohup + disown; tool-call background jobs get reaped otherwise)
cd /home/z/my-project
setsid nohup bash scripts/fleet-watchdog-loop.sh </dev/null >> scripts/watchdog-loop.log 2>&1 &
disown 2>/dev/null
echo "[fleet-boot] $(date -Is) watchdog loop launched (pid $!)"
