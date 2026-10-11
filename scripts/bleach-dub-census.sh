#!/usr/bin/env bash
# Full Bleach dub census — every episode of every TYBW season + original tail
BASE="http://localhost:3000/api/stream"
TOKEN="clyle-owner-4f8e2d1c9b7a6f3e"
OUT=/home/z/my-project/scripts/bleach-dub-census.jsonl
> "$OUT"

probe () { # malId ep label
  local mal=$1 ep=$2 label=$3
  local res
  res=$(curl -s --max-time 45 "${BASE}?malId=${mal}&ep=${ep}&lang=dub&server=zoko" -H "x-owner-token: $TOKEN")
  echo "$res" | python3 -c "
import json, sys
mal, ep, label = '$mal', '$ep', '$label'
try: d = json.load(sys.stdin)
except Exception: print(f'{label} {ep} PARSE-FAIL'); sys.exit()
if d.get('error'): print(f'{label} {ep} MISS')
else: print(f'{label} {ep} OK {d.get(\"provider\") or \"-\"}')
" >> "$OUT"
}

# S1 41467 (13 eps)
for e in $(seq 1 13); do probe 41467 $e "S1"; done
# S2 53998 (13)
for e in $(seq 1 13); do probe 53998 $e "S2"; done
# S3 56784 (14)
for e in $(seq 1 14); do probe 56784 $e "S3"; done
# S4 60636 (8)
for e in $(seq 1 8); do probe 60636 $e "S4"; done
# original 269 — full sweep of the newest 40 (the tail that matters for catch-up)
for e in $(seq 327 366); do probe 269 $e "ORIG"; done

echo "== SUMMARY =="
sort "$OUT" | awk '{print $1, $3}' | sort | uniq -c
echo
echo "== MISS DETAILS =="
grep " MISS\|FAIL" "$OUT" || echo "(none — every episode probed has a working dub)"
