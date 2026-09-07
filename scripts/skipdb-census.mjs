/**
 * Census: how many catalog animes can SkipDB cover?
 * 1. catalog malIds (db)
 * 2. wikidata MAL->IMDb map
 * 3. skipdb dump rows (approved intro/outro)
 * Reports per-title coverage + how the SkipDB data is keyed (season/episode).
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const catalog = await db.anime.findMany({
  where: { inCatalog: true },
  select: { malId: true, title: true, totalEpisodes: true, type: true },
  orderBy: { popularity: "asc" },
});
await db.$disconnect();

const imdbMap = JSON.parse(await readFile("scripts/wikidata-mal-imdb.json", "utf8"));

// SkipDB dump — build imdb -> [rows]
const dump = JSON.parse(await readFile("/tmp/skipdb-dump.json", "utf8"));
const byImdb = new Map();
for (const s of dump.segments ?? []) {
  if (s.status && s.status !== "approved") continue;
  if (!byImdb.has(s.imdb_id)) byImdb.set(s.imdb_id, []);
  byImdb.get(s.imdb_id).push(s);
}
console.log(`dump: ${dump.count} rows, ${byImdb.size} distinct imdb titles`);

// vendored aniskip dataset — who already has data?
const aniskip = JSON.parse(await readFile("src/lib/skip-times.data.json", "utf8"));
const aniskipAnime = new Set(Object.keys(aniskip).map(Number));

let mapped = 0, withData = 0, aniskipHas = 0, both = 0, neither = 0;
const hits = [], misses = [];
for (const a of catalog) {
  const imdb = imdbMap[a.malId];
  if (!imdb) { neither++; continue; }
  mapped++;
  const rows = byImdb.get(imdb);
  const hasSdb = !!(rows && rows.some((r) => r.segment_type === "intro" || r.segment_type === "outro"));
  const hasAni = aniskipAnime.has(a.malId);
  if (hasAni) aniskipHas++;
  if (hasSdb) { withData++; hits.push({ malId: a.malId, title: a.title, imdb, rows: rows.length }); if (hasAni) both++; }
  else if (!hasAni) misses.push({ malId: a.malId, title: a.title, imdb });
}
console.log(`catalog: ${catalog.length}`);
console.log(`wikidata-mapped: ${mapped} (${Math.round((mapped / catalog.length) * 100)}%)`);
console.log(`mapped AND skipdb-has-data: ${withData}`);
console.log(`  of which aniskip also covers: ${both}`);
console.log(`  skipdb-only (aniskip lacks): ${withData - both}`);
console.log(`aniskip covers overall: ${aniskipHas}/${catalog.length}`);
console.log(`unmapped+no-skipdb: ${neither}`);
console.log(`\n-- sample skipdb-only hits (top-30 by popularity) --`);
for (const h of hits.slice(0, 30)) console.log(`  ${h.malId} ${h.title} (${h.imdb}) rows=${h.rows}`);
console.log(`\n-- sample mapped-but-skipdb-empty (top-15) --`);
for (const m of misses.slice(0, 15)) console.log(`  ${m.malId} ${m.title} (${m.imdb})`);
