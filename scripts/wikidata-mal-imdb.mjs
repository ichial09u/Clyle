/**
 * Wikidata bulk MAL -> IMDb mapping.
 * Pulls every Wikidata item carrying BOTH MyAnimeList ID (P4086) and
 * IMDb ID (P345) and writes scripts/wikidata-mal-imdb.json: { malId: "tt..." }
 */
import { writeFile } from "node:fs/promises";

const QUERY = `SELECT ?mal ?imdb WHERE { ?item wdt:P4086 ?mal ; wdt:P345 ?imdb }`;
const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`;

const res = await fetch(url, {
  headers: {
    Accept: "application/sparql-results+json",
    "User-Agent": "ClyleSkipDB/1.0 (anime skip-time integration; contact: admin@clyle.app)",
  },
  signal: AbortSignal.timeout(120_000),
});
if (!res.ok) {
  console.error(`wikidata query failed: HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const rows = body?.results?.bindings ?? [];
const map = {};
let bad = 0;
for (const r of rows) {
  const mal = Number(r?.mal?.value);
  const imdb = String(r?.imdb?.value || "").trim();
  if (!Number.isFinite(mal) || mal <= 0 || !/^tt\d+$/.test(imdb)) { bad++; continue; }
  map[mal] = imdb;
}
await writeFile("scripts/wikidata-mal-imdb.json", JSON.stringify(map), "utf8");
console.log(`rows=${rows.length} kept=${Object.keys(map).length} bad=${bad}`);
