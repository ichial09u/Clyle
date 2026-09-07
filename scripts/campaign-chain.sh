#!/bin/bash
# Serial campaign chain — the "not overworking" rule, enforced:
# wait until the SUB army process has fully exited, rest the providers
# for 5 minutes, then fire the DUB walk (which has its own single-army
# guard). Double-detached so it survives session restarts.
cd /home/z/my-project

echo "[chain] waiting for the sub army to drain..."
while pgrep -f "all-shows-skip-army.mjs" >/dev/null 2>&1; do
  sleep 120
done
echo "[chain] sub army drained at $(date -u +%FT%TZ) — resting providers 5 min"
sleep 300
echo "[chain] launching DUB walk"
bash scripts/all-shows-dub-boot.sh
echo "[chain] done"
