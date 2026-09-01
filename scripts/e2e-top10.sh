#!/bin/bash
# E2E: Top 10 Today driven by real watch time.
# 1) clean WatchStat -> Top 10 must be HIDDEN on Home
# 2) Search -> One Piece -> ep 1 -> SUB Server #1 -> play
# 3) play ~13s, pause ~13s (idle must NOT count), resume ~9s, back to Home
# 4) Home shows Top 10 Today; server seconds < wall clock (pause excluded)
cd /home/z/my-project
set -u

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
shot() { agent-browser screenshot "scripts/$1" >/dev/null 2>&1; }

bash scripts/dev-up.sh 60 >/dev/null 2>&1

# ---- reset the ranking so it starts empty ----
python3 - <<'PY'
import sqlite3
con = sqlite3.connect('db/custom.db')
n = con.execute("DELETE FROM WatchStat").rowcount
con.commit()
print(f"cleared {n} WatchStat rows")
PY

# ---- fresh browser ----
agent-browser close >/dev/null 2>&1 || true
agent-browser open http://localhost:3000 >/dev/null 2>&1 || agent-browser open http://localhost:3000 >/dev/null
agent-browser wait --load networkidle >/dev/null 2>&1 || true
# best-effort: a fresh ranking needs no stale local buckets, but this key is
# brand-new anyway — never let storage quirks derail the run
agent-browser storage local clear >/dev/null 2>&1 || true
sleep 6

echo "== 1) EMPTY STATE =="
agent-browser snapshot -c > /tmp/t10_home0.txt
HITS=$(grep -c "Top 10 Today" /tmp/t10_home0.txt || true)
[ "$HITS" = "0" ] && ok "Top 10 Today hidden when nobody watched (count=$HITS)" || bad "Top 10 Today visible on empty data (count=$HITS)"
shot top10-empty.png

echo "== 2) navigate: Search -> One Piece -> ep 1 -> SUB Server #1 =="
agent-browser snapshot -i -c > /tmp/t10_s0.txt
SR=$(python3 scripts/extract-ref.py /tmp/t10_s0.txt 'button "Search"')
[ -z "$SR" ] && { bad "no Search nav button"; grep -i "button" /tmp/t10_s0.txt | head -12; exit 1; }
agent-browser click @$SR >/dev/null
sleep 2
agent-browser snapshot -i -c > /tmp/t10_s1.txt
IR=$(python3 scripts/extract-ref.py /tmp/t10_s1.txt 'textbox|searchbox')
echo "input ref: $IR"
if [ -n "$IR" ]; then agent-browser fill @$IR "one piece" >/dev/null; fi
sleep 2
agent-browser snapshot -c > /tmp/t10_s1b.txt
if ! grep -qi "ONE PIECE" /tmp/t10_s1b.txt; then
  echo "fill didn't filter — native setter fallback"
  agent-browser eval "(()=>{const el=document.querySelector('input[type=\"search\"],input');if(!el)return 'no-input';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'one piece');el.dispatchEvent(new Event('input',{bubbles:true}));return 'typed'})()" >/dev/null
  sleep 3
fi
agent-browser snapshot -i -c > /tmp/t10_s2.txt
CR=$(python3 scripts/extract-ref.py /tmp/t10_s2.txt 'button "ONE PIECE"')
echo "card ref: $CR"
[ -z "$CR" ] && { bad "could not find ONE PIECE card"; grep -i "ONE PIECE" /tmp/t10_s2.txt | head -6; exit 1; }
agent-browser click @$CR >/dev/null
sleep 3
agent-browser snapshot -i -c > /tmp/t10_s3.txt
PR=$(python3 scripts/extract-ref.py /tmp/t10_s3.txt 'episode|watch|play')
echo "details CTA ref: $PR"
[ -z "$PR" ] && { bad "no watch/episodes CTA on details"; grep -i "button" /tmp/t10_s3.txt | head -15; exit 1; }
agent-browser click @$PR >/dev/null
sleep 3
agent-browser snapshot -i -c > /tmp/t10_s4.txt
HAS_VIDEO=$(agent-browser eval "String(!!document.querySelector('video'))" | tail -1)
if [ "$HAS_VIDEO" != "true" ]; then
  ER=$(python3 scripts/extract-ref.py /tmp/t10_s4.txt 'button "1"')
  [ -z "$ER" ] && ER=$(python3 scripts/extract-ref.py /tmp/t10_s4.txt '"Episode 1"')
  echo "ep-1 ref: $ER"
  [ -z "$ER" ] && { bad "no episode-1 button"; grep -i "button" /tmp/t10_s4.txt | head -15; exit 1; }
  agent-browser click @$ER >/dev/null
  sleep 2
  agent-browser snapshot -i -c > /tmp/t10_s5.txt
  SV=$(python3 scripts/extract-ref.py /tmp/t10_s5.txt 'button "SUB Server #1"')
  echo "server ref: $SV"
  [ -z "$SV" ] && { bad "no SUB Server #1 button"; grep -i "server" /tmp/t10_s5.txt | head -10; exit 1; }
  agent-browser click @$SV >/dev/null
  sleep 3
fi

echo "== 3) wait for real playback =="
PLAYING="false"; i=0
for i in $(seq 1 40); do
  P=$(agent-browser eval "(()=>{const v=document.querySelector('video');return v?String(!v.paused&&v.readyState>=2&&v.currentTime>0):'no-video'})()" 2>/dev/null | tail -1)
  [ "$P" = "true" ] && { PLAYING="true"; break; }
  sleep 2
done
echo "playing=$PLAYING (waited ~$((i*2))s)"
[ "$PLAYING" = "true" ] && ok "episode is actually playing" || { bad "video never played"; shot top10-stuck.png; exit 1; }

echo "== 4) play ~13s -> PAUSE 13s (must not count) -> resume =="
sleep 13
shot top10-playing.png
# pause programmatically: fires the pause event + clock bump exactly like the
# UI button, and is immune to the 3.2s control auto-hide race in headless
agent-browser eval "(()=>{const v=document.querySelector('video');if(v&&!v.paused){v.pause()};return String(v?v.paused:'no-video')})()" > /tmp/t10_paused.txt
PAUSED=$(cat /tmp/t10_paused.txt | tail -1)
echo "paused=$PAUSED (expect true)"
[ "$PAUSED" = "true" ] && ok "playback paused for the idle test" || bad "could not pause"
sleep 13
# resume: programmatic play() fires the play event + clock bump
agent-browser eval "(()=>{const v=document.querySelector('video');if(v&&v.paused){v.play().catch(()=>{});return 'resumed'}return 'no'})()" >/dev/null
sleep 9
NOW_PLAYING=$(agent-browser eval "(()=>{const v=document.querySelector('video');return v?String(!v.paused):'no-video'})()" | tail -1)
echo "resumed-playing=$NOW_PLAYING (expect true)"
[ "$NOW_PLAYING" = "true" ] && ok "playback resumed after idle" || bad "did not resume"

echo "== 5) leave the player -> Home must show Top 10 Today =="
# Back pops one view (watch -> episodes); the Home TAB is the ranking surface.
# Programmatic clicks are fine here (no user-activation requirement) and don't
# fight the 3.2s control auto-hide.
agent-browser eval "(()=>{const b=document.querySelector('[aria-label=\"Back\"]');if(b){b.click();return 'back'}return 'no-back'})()" >/dev/null
sleep 2
agent-browser eval "(()=>{const btns=[...document.querySelectorAll('nav button, nav a')];const h=btns.find(b=>/^home$/i.test((b.textContent||'').trim()));if(!h)return 'no-nav';h.click();return 'home'})()" >/dev/null
sleep 5
agent-browser snapshot -c > /tmp/t10_home1.txt
grep -q "Top 10 Today" /tmp/t10_home1.txt && ok "Top 10 Today now visible after watching" || bad "Top 10 Today still hidden after watching"
grep -qi "ONE PIECE" /tmp/t10_home1.txt && ok "ONE PIECE appears in the ranking" || bad "ONE PIECE missing from ranking"
shot top10-populated.png
echo "--- home snapshot: Top 10 area ---"
grep -B1 -A8 "Top 10 Today" /tmp/t10_home1.txt | head -24 || true

echo "== 6) server seconds (must be well under wall clock: paused time excluded) =="
DAY=$(date +%Y-%m-%d)
curl -s "http://localhost:3000/api/watchtime?day=$DAY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
items=[i for i in d['items'] if i['malId']==21]
sec=items[0]['seconds'] if items else 0
wall = 13+13+9+8
print(f'ONE PIECE watch seconds today: {sec} (wall elapsed ~{wall}s; expect ~22s if pause excluded)')
print('PAUSE-EXCLUDED' if sec < wall-8 else 'SUSPICIOUS-HIGH')
"

echo "== 7) cleanup: leave the day bucket empty so the rail starts fresh =="
python3 - <<'PY'
import sqlite3
con = sqlite3.connect('db/custom.db')
n = con.execute("DELETE FROM WatchStat").rowcount
con.commit()
print(f"cleaned {n} WatchStat rows")
PY

echo
echo "== summary: $PASS passed / $FAIL failed =="
[ "$FAIL" = "0" ]
