#!/bin/bash
cd /home/z/my-project
if pgrep -f "dev-keepalive.sh" > /dev/null; then echo "[boot-dev] keepalive already running"; exit 0; fi
setsid nohup bash scripts/dev-keepalive.sh </dev/null >> /dev/null 2>&1 &
disown 2>/dev/null
echo "[boot-dev] $(date -Is) dev keepalive launched (pid $!)"
