#!/bin/bash
# Probe Cyberpunk: Edgerunners (42310) per-episode dub boundaries on both chains
# via the site's dub-probe bot endpoint (runs the full resolution chain incl. vidtube).
TOKEN="clyle-scout-v1"
BASE="${1:-http://localhost:3000}"
for ep in 1 2 3 4 5 6 7 8 9 10; do
  for chain in s1 s2; do
    R=$(curl -s -m 110 "$BASE/api/bots/dub-probe?token=$TOKEN&malId=42310&ep=$ep&chain=$chain")
    echo "ep $ep $chain: $(echo "$R" | head -c 220)"
  done
done
echo "=== anime row after probes:"
curl -s -m 30 "$BASE/api/anime/42310/episodes" | node -e "
let s=''; process.stdin.on('data', d=>s+=d).on('end', () => {
  try { const j = JSON.parse(s);
    console.log('hasDub:', j.hasDub, '| dubServers:', JSON.stringify(j.dubServers), '| dubThrough:', JSON.stringify(j.dubThrough), '| dubMissing:', JSON.stringify(j.dubMissing));
  } catch(e) { console.log('parse fail:', s.slice(0,200)); }
});
"
