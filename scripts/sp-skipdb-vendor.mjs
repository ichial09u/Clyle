#!/usr/bin/env node
/**
 * Vendor SkipDB's approved South Park intro/outro segments into SkipDbFill.
 *
 * The skip-times tier stack reads SkipDbFill by malId — but South Park isn't
 * on MAL, so the normal MAL->IMDb mapping (Wikidata/Jikan) can't see it.
 * This script bridges directly: South Park's IMDb id tt0121955 -> our
 * synthetic entries (999900 + season; the Movies & Specials bucket gets the
 * S0 rows). 647 approved segments were found in the public dump — intros AND
 * outros for nearly every episode of every season.
 *
 * These are community timings on OTHER encodes — the intro bots (Task: SP
 * intro fleet) outrank them with per-episode measurements on OUR encodes;
 * this tier only fills what the bots leave blank.
 *
 * Usage: node scripts/sp-skipdb-vendor.mjs [--dump /path/dump.json]
 * The dump (https://skipdb.tv/api/dump, ODbL 1.0) is cached at /tmp.
 */
import { writeFileSync, existsSync, statSync } from "node:fs";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();

const IMDB = "tt0121955";
const DUMP_URL = "https://skipdb.tv/api/dump";
const DUMP_TMP = "/tmp/skipdb-dump.json";

async function loadDump() {
  if (existsSync(DUMP_TMP) && Date.now() - statSync(DUMP_TMP).mtimeMs < 6 * 3600_000) {
    return JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(DUMP_TMP, "utf8")));
  }
  const res = await fetch(DUMP_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`dump -> ${res.status}`);
  const text = await res.text();
  writeFileSync(DUMP_TMP, text);
  return JSON.parse(text);
}

const dump = await loadDump();
const segs = (dump.segments ?? []).filter((s) => s.imdb_id === IMDB && s.status === "approved");
console.log(`SP approved segments in dump: ${segs.length}`);

// malId by season: 1..29 -> 999901..999929, 0 (movies/specials) -> 999900
const malIdFor = (season) => 999900 + Number(season);

// per-season stats before write
const bySeason = {};
for (const s of segs) {
  const key = `${s.season}/${s.segment_type}`;
  bySeason[key] = (bySeason[key] ?? 0) + 1;
}

let upserted = 0, skipped = 0;
for (const s of segs) {
  const kind = s.segment_type === "intro" ? "op" : s.segment_type === "outro" ? "ed" : null;
  if (!kind) { skipped++; continue; }
  const start = (s.start_ms ?? 0) / 1000;
  const end = (s.end_ms ?? 0) / 1000;
  if (!(end > start) || start < 0) { skipped++; continue; }
  // plausibility mirrors skip-times.ts: intros start <=320s and run <=180s;
  // outros run <=300s. SkipDB rows for SP satisfy both (max intro ~40s).
  if (kind === "op" && (start > 320 || end - start > 180)) { skipped++; continue; }
  if (kind === "ed" && end - start > 300) { skipped++; continue; }
  const confidence = Math.max(0, Math.min(1, Number(s.score) || (s.votes_up > 0 ? 0.5 : 0.25)));
  await db.skipDbFill.upsert({
    where: { malId_ep_kind: { malId: malIdFor(s.season), ep: Number(s.episode), kind } },
    update: { start, end, confidence },
    create: { malId: malIdFor(s.season), ep: Number(s.episode), kind, start, end, confidence },
  });
  upserted++;
}

console.log(`upserted: ${upserted}, skipped: ${skipped}`);
console.log("per-season:", Object.fromEntries(Object.entries(bySeason).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))));
await db.$disconnect();
