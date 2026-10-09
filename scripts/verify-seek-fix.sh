#!/bin/bash
# Full browser verification of the SP player fixes (proxied + Range):
# 1. playback starts (proxied MP4)
# 2. drag seek forward -> currentTime HOLDS (no reset to 0)
# 3. Skip Intro button -> lands near the intro end (~27s), NOT 0
cd /home/z/my-project/src
export DATABASE_URL=file:/home/z/my-project/src/db/custom.db

pkill -f "next dev" 2>/dev/null; sleep 1
nohup npx next dev -p 3000 > /home/z/my-project/scripts/next-dev.out 2>&1 &
for i in $(seq 1 60); do sleep 2; curl -s -o /dev/null http://localhost:3000/ && break; done
echo "dev ready: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)"
curl -s "http://localhost:3000/api/stream?malId=999901&ep=1&lang=dub&server=zoko" | python3 -c "import json,sys; d=json.load(sys.stdin); print('server1:',d.get('provider'),'proxied:',str(d.get('src','')).startswith('/api/stream/proxy'))"

AB="agent-browser --session spfix"
$AB close 2>/dev/null
$AB set viewport 800 400
$AB open http://localhost:3000/
$AB wait --load networkidle
$AB find role button click --name "Search"
sleep 1
$AB find role textbox fill "South Park Season 13"
sleep 3
$AB snapshot -i -c 2>&1 | rg -o 'button "South Park Season 13" \[ref=[^]]*\]' | head -1 > /tmp/s13ref.txt
REF=$(cat /tmp/s13ref.txt | rg -o '@e\d+')
echo "S13 card ref: $REF"
$AB click $REF
sleep 4
$AB find role button click --name "Watch"
sleep 3
$AB snapshot -i -c 2>&1 | rg -o 'button "1 NEW" \[ref=[^]]*\]' | head -1 > /tmp/ep1ref.txt
E1=$(cat /tmp/ep1ref.txt | rg -o '@e\d+')
echo "ep1 ref: $E1"
$AB click $E1
sleep 2
$AB find role button click --name "Server 1"
echo "waiting for playback..."
for i in $(seq 1 15); do
  sleep 3
  T=$($AB eval "(() => { const v=document.querySelector('video'); return v ? v.currentTime.toFixed(1) + '|' + (v.duration||0).toFixed(1) + '|' + (v.paused?'p':'playing') + '|' + ((v.currentSrc||'').includes('proxy')?'proxied':'other') : 'none'; })()" 2>/dev/null | tr -d '"')
  echo "t=$T"
  case "$T" in *playing*|*dur*) case "$T" in *"|1336|"*|*playing*) break;; esac;; esac
done
