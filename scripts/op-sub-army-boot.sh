#!/bin/bash
# OP-SUB INTRO ARMY boot — double-detach so the bots survive session boundaries
# (same pattern as fleet-boot.sh: setsid + nohup + disown)
cd /home/z/my-project
mkdir -p scripts
setsid nohup node scripts/op-sub-intro-army.mjs </dev/null >> scripts/op-sub-intro-army.out 2>&1 &
disown 2>/dev/null
echo "[op-army-boot] $(date -Is) army launched (pid $!)"
