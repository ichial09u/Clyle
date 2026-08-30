#!/usr/bin/env bash
# Push this project to GitHub as "AnimeTest123".
#
#   1) With GitHub CLI  (easiest):
#        gh auth login
#        bash scripts/push-to-github.sh
#
#   2) Without GitHub CLI:
#        create an empty repo named AnimeTest123 on github.com, then:
#          git remote add origin https://github.com/<YOUR_USERNAME>/AnimeTest123.git
#          bash scripts/push-to-github.sh <YOUR_USERNAME>
set -euo pipefail

REPO_NAME="AnimeTest123"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Initializing git repository..."
  git init -b main
fi

git add -A
git commit -m "AnimeTest123 — Zoko-style anime app (Jikan API + Zoko player)" --allow-empty || true

if [ "$#" -ge 1 ]; then
  USERNAME="$1"
elif git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##; s#/.+$##')/${REPO_NAME}.git"
  USERNAME=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#/.+$##')
else
  USERNAME=""
fi

if [ -n "$USERNAME" ]; then
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${USERNAME}/${REPO_NAME}.git"
  git push -u origin main
  echo "Pushed to https://github.com/${USERNAME}/${REPO_NAME}"
  exit 0
fi

if command -v gh >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
  echo "Created and pushed to github.com/$(gh api user -q .login)/$REPO_NAME"
else
  cat <<EOF
GitHub CLI not found and no username given.

Option A — install gh, then:
    gh auth login
    gh repo create ${REPO_NAME} --public --source=. --push

Option B — create the empty repo on github.com, then:
    git remote add origin https://github.com/<YOUR_USERNAME>/${REPO_NAME}.git
    git push -u origin main
EOF
fi
