#!/bin/bash
# One-shot repro: SP S13E1 player — Skip Intro behavior + seek-bar commit.
# Everything runs in THIS call because background procs die between tool calls.
cd /home/z/my-project/src
export DATABASE_URL=file:/home/z/my-project/src/db/custom.db

pkill -f "next dev" 2>/dev/null; sleep 1
nohup npx next dev -p 3000 > /home/z/my-project/scripts/next-dev.out 2>&1 &
for i in $(seq 1 60); do sleep 2; curl -s -o /dev/null http://localhost:3000/ && break; done
echo "dev ready: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)"

AB="agent-browser --session sprepro"
$AB close 2>/dev/null
$AB set viewport 800 400
$AB open http://localhost:3000/
$AB wait --load networkidle
# find South Park Season 13 via search
$AB find role button click --name "Search" 2>/dev/null || $AB eval "document.querySelector('a[href*=\"search\"],button[aria-label*=earch]')?.click()"
sleep 1
$AB snapshot -i -c 2>/dev/null | head -40
