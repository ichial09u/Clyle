#!/usr/bin/env bash
# Battalion 3 — Bleach DUB catch-up probe (live stream-route verification).
# Hits /api/stream?lang=dub for every Bleach entry in the catalog, newest
# episodes first, and reports provider + audio verdict per episode.
TOKEN="clyle-owner-4f8e2d1c9b7a6f3e"
BASE="http://localhost:3000/api/stream"
OUT=/home/z/my-project/scripts/bleach-dub-probe.json

probe () { # malId ep label
  local mal=$1 ep=$2 label=$3
  local res
  res=$(curl -s --max-time 90 "${BASE}?malId=${mal}&ep=${ep}&lang=dub&server=zoko&fresh=1" -H "x-owner-token: $TOKEN")
  python3 - "$mal" "$ep" "$label" "$res" << 'PY'
import json, sys
mal, ep, label, raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    d = json.loads(raw)
except Exception:
    print(f"{label} ep{ep}: PARSE-FAIL {raw[:120]}"); sys.exit(0)
if d.get("error"):
    print(f"{label} ep{ep}: ERROR {d['error'][:80]}"); sys.exit(0)
url = d.get("src") if isinstance(d.get("src"), str) else (d.get("src") or {}).get("url", "")
subs = d.get("subtitles") or []
provider = d.get("provider") or "-"
server = d.get("serverUsed") or "-"
hls = ".m3u8" in url
print(f"{label} ep{ep}: OK provider={provider} server={server} hls={hls} subs={len(subs)} url={url[:58]}")
PY
}

echo "== BLEACH DUB CATCH-UP PROBE $(date -u +%H:%M:%S) =="
# Original series (366 eps) — newest + oldest
probe 269 366 "Bleach"
probe 269 320 "Bleach"
# TYBW S1 (13 eps) — hasDub flag says 0, verify reality
probe 41467 1  "TYBW-S1"
probe 41467 13 "TYBW-S1"
# TYBW S2 The Separation (13)
probe 53998 1  "TYBW-S2"
probe 53998 13 "TYBW-S2"
# TYBW S3 The Conflict (14)
probe 56784 1  "TYBW-S3"
probe 56784 14 "TYBW-S3"
# TYBW S4 The Calamity (airing, 8 sub eps) — ALL 8, dub catch-up is the question
for e in 1 2 3 4 5 6 7 8; do
  probe 60636 $e "TYBW-S4"
done
echo "== PROBE DONE $(date -u +%H:%M:%S) =="
