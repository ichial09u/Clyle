#!/bin/sh
# Clyle container entrypoint — seeds the SQLite catalog into an empty
# volume on first boot, then hands off to the Next.js standalone server.
#
# Why: deployments that mount a volume at /app/db (Dokploy, Coolify, a raw
# VPS) shadow the packaged ./db/custom.db with an empty directory, which
# would otherwise boot Prisma against a blank SQLite file ("no such table").
# The seed copy lives at /opt/seed (outside /app/db) so it survives the
# mount and can be copied in.
set -e

DB="/app/db/custom.db"
SEED="/opt/seed/custom.db"

mkdir -p "$(dirname "$DB")"

if [ -f "$SEED" ]; then
  if [ ! -f "$DB" ]; then
    cp "$SEED" "$DB"
    echo "[clyle] seeded $DB from packaged catalog"
  elif [ "$DB_RESEED" = "1" ]; then
    cp "$SEED" "$DB"
    echo "[clyle] DB_RESEED=1 — catalog DB refreshed from packaged seed"
  fi
fi

exec "$@"
