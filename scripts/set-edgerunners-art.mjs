#!/usr/bin/env node
/**
 * set-edgerunners-art.mjs — re-pin Cyberpunk: Edgerunners (malId 42310) art.
 *
 * The sync sweep keeps re-writing TMDB URLs into the Anime row; the durable
 * fix is the ART_OVERRIDES pin in src/lib/sync.ts, but the row itself (and
 * the WatchStat / Top10Event snapshot tables that embed art URLs) still need
 * a one-shot UPDATE so the app shows the official Netflix key art before the
 * next sync runs. Safe to re-run at any time — idempotent.
 *
 * Usage: node scripts/set-edgerunners-art.mjs   (from /home/z/my-project/src)
 */
import { createRequire } from "node:module";

const DB = new URL("../src/db/custom.db", import.meta.url).pathname;
const PIN = "/art/edgerunners-poster.jpg";
const MAL_ID = 42310;

// the app's node_modules live one level up from this script (src/ is the app root)
const require2 = createRequire(new URL("../src/package.json", import.meta.url));
const Database = require2("better-sqlite3");

const db = new Database(DB);
db.pragma("journal_mode = WAL");

const anime = db.prepare("UPDATE Anime SET image = ? WHERE malId = ?").run(PIN, MAL_ID);
const watch = db.prepare("UPDATE WatchStat SET image = ? WHERE malId = ? AND image IS NOT ?").run(PIN, MAL_ID, PIN);
const top10 = db.prepare("UPDATE Top10Event SET image = ? WHERE malId = ? AND image IS NOT ?").run(PIN, MAL_ID, PIN);

const row = db.prepare("SELECT malId, title, image FROM Anime WHERE malId = ?").get(MAL_ID);
console.log("[set-edgerunners-art]", JSON.stringify(row));
console.log(`[set-edgerunners-art] anime rows: ${anime.changes}, watchStat rows: ${watch.changes}, top10 rows: ${top10.changes}`);
db.close();
