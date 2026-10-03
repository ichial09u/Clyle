#!/bin/bash
# Verify Cyberpunk: Edgerunners (42310) dub resolution for all 10 eps via the site chain
for ep in 1 2 3 4 5 6 7 8 9 10; do
  R=$(curl -s -m 90 "http://localhost:3000/api/stream?malId=42310&ep=$ep&lang=dub")
  echo "$R" > /tmp/edg-route-ep$ep.json
  node -e "
  const d = JSON.parse(require('fs').readFileSync('/tmp/edg-route-ep$ep.json','utf8'));
  if (d.error) { console.log('ep $ep: ERROR', d.error); }
  else {
    console.log('ep $ep: provider=' + d.provider + ' | subs=' + (d.stream?.subtitles||[]).length + ' | intro=' + JSON.stringify(d.stream?.skip?.intro));
  }
  "
done
