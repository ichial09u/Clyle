#!/usr/bin/env bash
# Rebuild download/AnimeTest123-deploy.zip from git-tracked files,
# excluding caches that shouldn't ship (same recipe as the 549KB baseline).
set -euo pipefail
cd /home/z/my-project

OUT="download/AnimeTest123-deploy.zip"
mkdir -p download
rm -f "$OUT"

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
