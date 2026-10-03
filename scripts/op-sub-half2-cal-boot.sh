#!/bin/bash
# op-sub-half2-cal-boot.sh — double-detached calibration launch (fleet-boot pattern)
cd /home/z/my-project
setsid nohup node scripts/op-sub-half2-calibrate.mjs </dev/null >> /home/z/my-project/scripts/op-sub-half2-cal.out 2>&1 &
disown 2>/dev/null
echo "[cal-boot] $(date -Is) calibration launched (pid $!)"
