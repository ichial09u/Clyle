#!/bin/bash
# DUB WALK boot — skip-intro verification on the dub stream path.
# Launch ONLY after the sub campaign has fully drained (serial, so the
# providers see the same load as one campaign — the "not overworking" rule).
cd /home/z/my-project

if ! pgrep -f "all-shows-skip-army.mjs" >/dev/null 2>&1; then
  setsid nohup node scripts/all-shows-skip-army.mjs --scan-dub --lang dub --lanes 12 --repair-lanes 20 </dev/null >> scripts/all-shows-skip-army-dub.out 2>&1 &
  disown 2>/dev/null
  echo "[boot] DUB walk launched (pg $!)"
else
  echo "[boot] an army is still running — dub walk NOT launched (serial rule)"
fi
