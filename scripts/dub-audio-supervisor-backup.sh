#!/bin/bash
# Supervisor for the BACKUP-network dub-audio sweep — harvests audio verdicts
# for the Anivexa backup DUB servers (AniNeko/AnimeGG/AniWatch/AllManga/
# Reanime) across the whole catalog. Providers degrade and recover on their
# own schedules (AniNeko's Backblaze 403 days, allmanga watch outages,
# reanime HTML days), so the loop just keeps taking passes: every pass pays
# only for anime/provider pairs still unverified, and a provider that was
# dead last pass gets re-probed this pass. Paced politely.
cd /home/z/my-project
while true; do
  echo "[bk-supervisor] $(date -Is) starting backup dub-audio sweep"
  node scripts/dub-audio-sweep-backup.mjs 40 >> scripts/dub-audio-sweep-backup.log 2>&1
  echo "[bk-supervisor] $(date -Is) sweep exited ($?) — next pass in 15 min"
  sleep 900
done
