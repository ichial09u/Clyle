#!/bin/bash
# OP-SUB INTRO AUDIT boot — double-detach (survives session boundaries)
cd /home/z/my-project
setsid nohup node scripts/op-sub-intro-audit.mjs </dev/null >> scripts/op-sub-intro-audit.out 2>&1 &
disown 2>/dev/null
echo "[op-audit-boot] $(date -Is) audit wave launched (pid $!)"
