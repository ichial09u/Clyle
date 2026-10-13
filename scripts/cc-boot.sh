#!/bin/bash
# CC campaign boot — double-detach so bots survive session boundaries
# (the fleet-boot.sh pattern: setsid + nohup + disown inside a boot script)
# Usage: bash scripts/cc-boot.sh census|dubwave|subwave
cd /home/z/my-project
case "$1" in
  census)
    setsid nohup node scripts/cc-caption-census.mjs </dev/null >> scripts/cc-caption-census.out 2>&1 &
    disown 2>/dev/null
    echo "[cc-boot] $(date -Is) census launched (pid $!)"
    ;;
  dubwave)
    # top-150 hasDub shows x 2 eps, 6 bots; resumable (skips CaptionSync rows conf>=0.6)
    setsid nohup node scripts/cc-sync-fleet.mjs --top 150 --eps-per 2 --workers 6 --tag dubwave </dev/null >> scripts/cc-sync-dubwave.out 2>&1 &
    disown 2>/dev/null
    echo "[cc-boot] $(date -Is) dub sync wave launched (pid $!)"
    ;;
  subwave)
    # top-120 shows x 1 ep SUB sync (0 sub rows existed before this campaign)
    setsid nohup node scripts/cc-sync-fleet.mjs --top 120 --eps-per 1 --workers 6 --lang sub --tag subwave </dev/null >> scripts/cc-sync-subwave.out 2>&1 &
    disown 2>/dev/null
    echo "[cc-boot] $(date -Is) sub sync wave launched (pid $!)"
    ;;
  *)
    echo "usage: bash scripts/cc-boot.sh census|dubwave|subwave"
    ;;
esac
