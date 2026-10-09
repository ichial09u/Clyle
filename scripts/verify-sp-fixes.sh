#!/bin/bash
# Verify the seek fix + naming + download sheet in a real browser.
# The seek repro that FAILED before the fix (video reset to 0) must now hold.
cd /home/z/my-project/src
export DATABASE_URL=file:/home/z/my-project/src/db/custom.db

pkill -f "next dev" 2>/dev/null; sleep 1
nohup npx next dev -p 3000 > /home/z/my-project/scripts/next-dev.out 2>&1 &
for i in $(seq 1 60); do sleep 2; curl -s -o /dev/null http://localhost:3000/ && break; done
echo "dev ready: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)"

# payload checks first (cheap)
echo "--- S1E1 via zoko (server 1 = WCO) ---"
curl -s "http://localhost:3000/api/stream?malId=999901&ep=1&lang=dub&server=zoko" | python3 -c "import json,sys; d=json.load(sys.stdin); print('provider:',d.get('provider'),'direct:',d.get('direct'),'serverUsed:',d.get('serverUsed'))"
echo "--- S1E1 via kiwi (server 2 = LookMovie2) ---"
curl -s "http://localhost:3000/api/stream?malId=999901&ep=1&lang=dub&server=kiwi" | python3 -c "import json,sys; d=json.load(sys.stdin); print('provider:',d.get('provider'),'direct:',d.get('direct'),'serverUsed:',d.get('serverUsed'),'srcHost:',d.get('src','')[:40])"
echo "--- episodes payload serverNames ---"
curl -s "http://localhost:3000/api/anime/999901/episodes" | python3 -c "import json,sys; d=json.load(sys.stdin); print('serverNames:',d.get('serverNames'),'hasSub:',d.get('hasSub'))"
echo "--- captions sync verdict S13E1 ---"
curl -s "http://localhost:3000/api/captions?malId=999913&ep=1&lang=dub" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d)"

AB="agent-browser --session sprepro2"
$AB close 2>/dev/null
$AB set viewport 800 400
$AB open http://localhost:3000/search
$AB wait --load networkidle
$AB find role textbox fill "South Park Season 13" 2>/dev/null || true
sleep 2
$AB snapshot -i -c 2>&1 | rg -o 'button "[^"]*Season 13[^"]*" \[ref=[^]]*\]' | head -2
