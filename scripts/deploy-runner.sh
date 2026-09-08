#!/bin/bash
# Deploy runner — double-detached so the tool shell can't reap it.
cd /home/z/my-project
setsid nohup node scripts/deploy-vercel.mjs > /tmp/deploy-retry.log 2>&1 < /dev/null &
disown
echo "launched: $(date)"
