#!/bin/bash
# Keeps seeding until every catalog row has details. Tolerates Jikan 504 flakiness
# by re-running the (resumable) seed script with breaks between rounds.
cd /home/z/my-project
for i in $(seq 1 12); do
  pending=$(bun -e 'import {db} from "./src/lib/db"; const n = await db.anime.count({where:{inCatalog:true,lastSyncedAt:null}}); console.log(n); await db.$disconnect();' 2>/dev/null | tail -1)
  echo "[round $i] pending details: $pending"
  if [ "$pending" = "0" ]; then
    echo "catalog fully detailed"
    break
  fi
  bun scripts/seed-catalog.ts --limit 8 >> scripts/seed.log 2>&1
  sleep 20
done
echo "seed loop finished"
