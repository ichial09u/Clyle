/**
 * export-catalog.mjs — Track C: dump the catalog DB into a single browser-ready
 * JS bundle for "Clyle Lite" (the static, serverless build).
 *
 * Output: download/clyle-lite/data.js  (window.CATALOG = {...})
 * Loaded via <script src="data.js"> so the Lite app works from file:// AND
 * GitHub Pages with zero fetch/CORS issues.
 *
 *   node scripts/export-catalog.mjs
 */

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire('/home/z/my-project/src/package.json');
const Database = require('better-sqlite3');

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DB = join(here, '..', 'db', 'custom.db');
const OUT_DIR = join(here, '..', '..', 'download', 'clyle-lite');

const db = new Database(SRC_DB, { readonly: true });

const rows = db
  .prepare(
    `SELECT malId, title, titleEnglish, image, banner, synopsis, type, status,
            airing, season, year, score, members, genres, totalEpisodes,
            nextEpisodeAt, nextEpisodeNum, hasDub, hasSub, logoUrl
     FROM Anime WHERE inCatalog = 1 ORDER BY members DESC`
  )
  .all();

const anime = rows.map((r) => ({
  i: r.malId,
  t: r.title,
  e: r.titleEnglish || undefined,
  img: r.image || undefined,
  ban: r.banner || undefined,
  logo: r.logoUrl || undefined,
  syn: r.synopsis || undefined,
  ty: r.type || undefined,
  st: r.status || undefined,
  air: r.airing ? 1 : undefined,
  season: r.season || undefined,
  y: r.year || undefined,
  sc: r.score || undefined,
  m: r.members || undefined,
  g: JSON.parse(r.genres || '[]'),
  eps: r.totalEpisodes || 0,
  next: r.nextEpisodeAt || undefined,
  nextN: r.nextEpisodeNum || undefined,
  dub: r.hasDub === 1 ? 1 : r.hasDub === 0 ? 0 : undefined,
  sub: r.hasSub === 1 ? 1 : r.hasSub === 0 ? 0 : undefined,
}));

const catalog = { generatedAt: new Date().toISOString(), count: anime.length, anime };

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, 'data.js');
writeFileSync(out, `/* Clyle Lite catalog — generated ${catalog.generatedAt} from the Clyle DB. Do not edit by hand. */\nwindow.CATALOG = ${JSON.stringify(catalog)};\n`, 'utf8');

const kb = (require('node:fs').statSync(out).size / 1024).toFixed(0);
console.log(`exported ${anime.length} titles → ${out} (${kb} KB)`);

// quick sanity: genres histogram + type histogram
const gCount = new Map();
for (const a of anime) for (const g of a.g) gCount.set(g, (gCount.get(g) ?? 0) + 1);
const top = [...gCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('top genres:', top.map(([g, n]) => `${g}(${n})`).join(' '));
console.log('dub-flagged:', anime.filter((a) => a.dub).length, '| sub-flagged:', anime.filter((a) => a.sub).length, '| with next-ep timer:', anime.filter((a) => a.next).length);
