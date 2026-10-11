#!/usr/bin/env bash
# Fill all missing-episode-row holes via the owner import route.
# importEpisodes() only creates rows that have actually AIRED, so this is
# safe for shows whose next episode is still in the future.
TOKEN="clyle-owner-4f8e2d1c9b7a6f3e"
for mal in 53876 60601 61967 61323 61578 64534 61603 61987 64254 62922 64503 63293 56733 52480 63431 58518 63140 63337 63801 57612 59204 64340 53913 60948 61469 63754 63832 59741 59787 61153 59088 63382 64084 235; do
  res=$(curl -s --max-time 110 -X POST -H "x-clyle-owner: $TOKEN" -H "Content-Type: application/json" -d "{\"malId\": $mal}" "http://localhost:3000/api/import")
  echo "$res" | python3 -c "
import json,sys
mal = '$mal'
try: d = json.load(sys.stdin)
except Exception: print(f'{mal} PARSE-FAIL'); sys.exit()
if 'error' in d: print(f'{mal} ERROR {d[\"error\"][:60]}')
else:
    a = d.get('anime') or {}
    print(f'{mal} +{d.get(\"episodesAdded\",0)} eps  [{a.get(\"title\",\"?\")[:38]}]')
"
  sleep 1
done
