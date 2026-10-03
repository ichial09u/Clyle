#!/bin/bash
# op-sub-half2-boot.sh — double-detached launch of the second-half army
cd /home/z/my-project
setsid nohup node scripts/op-sub-half2-army.mjs --lanes 6 </dev/null >> scripts/op-sub-half2.out 2>&1 &
disown 2>/dev/null
echo "[half2-boot] $(date -Is) second-half army launched (pid $!)"
