#!/usr/bin/env bash
# Rebuild download/AnimeTest123-deploy.zip from git-tracked files,
# excluding caches that shouldn't ship (same recipe as the 549KB baseline).
set -euo pipefail
cd /home/z/my-project

OUT="download/AnimeTest123-deploy.zip"
mkdir -p download
rm -f "$OUT"

# carry forward live user data (comments + Top 10 history) into the bundled db
# so it survives the update (same step scripts/deploy-vercel.mjs runs)
PROD_URL="${PROD_URL:-https://temporary-spry-granite-1f0h7ae.vercel.app}"
if curl -sf --max-time 30 "$PROD_URL/api/export" -o db/export-comments.tmp.json 2>/dev/null; then
  node scripts/merge-comments.mjs db/export-comments.tmp.json || echo "merge failed — zipping local db as-is"
else
  echo "no live data reachable ($PROD_URL) — zipping local db as-is"
fi

git ls-files \
  | rg -v "^scripts/" \
  | rg -v "^tool-results/" \
  | rg -v "^tsconfig\.tsbuildinfo$" \
  | rg -v "^db/(anilist-cache|zoko-stream)/" \
  | rg -v "^(dev|server)\.log$" \
  | rg -v "^download/" \
  | rg -v "^\.next/|^node_modules/" \
  | zip -q "$OUT" -@

echo "zip contents: $(unzip -l "$OUT" | tail -1)"
ls -la "$OUT"
