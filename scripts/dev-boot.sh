#!/bin/bash
# dev-boot.sh — double-detached dev server boot (the fleet-boot.sh pattern)
cd /home/z/my-project
setsid nohup env NODE_OPTIONS=--max-old-space-size=768 node node_modules/.bin/next dev </dev/null >> /home/z/my-project/scripts/next-dev.log 2>&1 &
disown 2>/dev/null
echo "[dev-boot] $(date -Is) next dev launched (pid $!)"
