/**
 * TMDB poster replacement — Task 23 (user ask: "Replace all anime posters and
 * use what moviedb api has, if they don't have all animes js keep them how they are").
 *
 * For every Anime row:
 *   1. search TMDB (tv first for TV/ONA/OVA/Special, movie first for Movie;
 *      the other endpoint is the fallback either way),
 *   2. score candidates by normalized-name similarity + year proximity,
 *   3. on a confident match with a real poster_path, REPLACE Anime.image with
 *      https://image.tmdb.org/t/p/w500<path>  (w500 = crisp on every card size),
 *   4. no confident match / no poster -> keep the existing (AniList) image.
 *
 * Resumable: progress is stored in scripts/tmdb-posters-progress.json so a
 * killed run picks up where it stopped. Rate-limit friendly: small concurrency
 * + jittered delays; TMDB's search cache makes reruns cheap.
 *
 * Run:  node scripts/tmdb-posters.mjs            (full batch)
 *       node scripts/tmdb-posters.mjs --dry      (no DB writes, report only)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DB_PATH = join(ROOT, "src", "db", "custom.db");
const PROGRESS_PATH = join(HERE, "tmdb-posters-progress.json");
const REPORT_PATH = join(HERE, "tmdb-posters-report.json");
const API_KEY = process.env.TMDB_KEY || "da679b1021912724c1ed572201e2864c";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const DRY = process.argv.includes("--dry");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- title normalization + scoring ---------- */
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // accents: Pokémon -> pokemon
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tv|ona|ova|movie special|special|the series|the movie|series)\b/g, (m, _1, off, str) => m)
    .replace(/\s+/g, " ")
    .trim();
}
// strip season/sequel decorations that MAL carries but TMDB titles split off
function looseNorm(s) {
  return norm(s)
    .replace(/\b(season|s|part|cour|arc|chapter|volume|vol)\s*\d+\b/g, "")
    .replace(/\b\d+(nd|rd|th|st)\s+season\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (t) => {
    const set = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let hits = 0;
  for (const [g, n] of A) {
    const m = B.get(g);
    if (m) hits += Math.min(n, m);
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/* ---------- TMDB ---------- */
async function tmdbSearch(endpoint, query, year) {
  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("page", "1");
  if (year) {
    if (endpoint === "tv") url.searchParams.set("first_air_date_year", String(year));
    else url.searchParams.set("primary_release_year", String(year));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (r.status === 429) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d.results) ? d.results : [];
    } catch {
      await sleep(800 * (attempt + 1));
    }
  }
  return [];
}

function scoreCandidates(results, rows) {
  const full = rows.titleEnglish || rows.title;
  const tN = norm(full);
  const tL = looseNorm(full);
  // MAL titles carry the franchise prefix ("Pokémon: Pikachu's Vacation") that
  // TMDB often drops ("Pikachu's Vacation") — the colon tail is its own query
  const tailRaw = full.includes(":") ? full.split(":").pop() : "";
  const tTail = tailRaw.trim().length >= 5 ? norm(tailRaw) : "";
  let best = null;
  for (const r of results) {
    if (!r.poster_path) continue;
    const name = r.name || r.title || "";
    const rN = norm(name);
    const rL = looseNorm(name);
    let sim = Math.max(dice(tN, rN), dice(tL, rL) * 0.97);
    if (tTail) sim = Math.max(sim, dice(tTail, rN) * 0.96);
    const air = r.first_air_date || r.release_date || "";
    const rYear = air ? parseInt(air.slice(0, 4), 10) : null;
    // ACCEPTANCE (strict — a wrong poster is worse than the current one):
    //   same year      -> sim >= 0.80
    //   year off by 1  -> sim >= 0.90 (TMDB sometimes anchors S2 to S1's date)
    //   year off by 2+ -> essentially exact title required (stops Code Geass
    //                     R2 grabbing S1's art)
    //   one year unknown -> near-exact title required
    const diff = rows.year && rYear ? Math.abs(rYear - rows.year) : null;
    const pass =
      (diff === 0 && sim >= 0.8) ||
      (diff === 1 && sim >= 0.9) ||
      (diff !== null && diff >= 2 && sim >= 0.99) ||
      (diff === null && sim >= 0.95);
    if (pass && (!best || sim > best.sim)) {
      best = { sim, rYear, id: r.id, poster: r.poster_path, name };
    }
  }
  return best;
}

/* ---------- DB (better-sqlite3 via prisma engine-free path) ---------- */
const { PrismaClient } = await import(join(ROOT, "src", "node_modules", "@prisma", "client", "index.js")).catch(
  () => import("@prisma/client"),
);
process.env.DATABASE_URL = `file:${DB_PATH}`;
const db = new PrismaClient();

async function main() {
  const rows = await db.anime.findMany({
    select: { malId: true, title: true, titleEnglish: true, type: true, year: true, image: true },
    orderBy: { popularity: "asc" }, // popular titles first — most visible posters get the best effort
  });
  console.log(`[tmdb] ${rows.length} anime rows`);

  // CUSTOM LOCAL ART is sacred: images that live in /public/art (the user's
  // hand-picked One Piece Elbaph arc poster, op-elbaph-poster.jpg) must never
  // be swapped for TMDB art — a previous session set them by explicit ask.
  const customArt = new Set(rows.filter((r) => r.image && r.image.startsWith("/")).map((r) => r.malId));
  if (customArt.size) console.log(`[tmdb] protecting ${customArt.size} custom local-art row(s): ${[...customArt].join(", ")}`);

  const progress = existsSync(PROGRESS_PATH) ? JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) : { done: {} };

  // unique search cache across rows with the same normalized title
  const searchCache = new Map(); // cacheKey -> best candidate or null
  const report = { matched: 0, kept: 0, noPoster: 0, errors: 0, samples: [] };
  let i = 0;

  for (const row of rows) {
    i++;
    if (customArt.has(row.malId)) continue; // never touch hand-picked art
    if (progress.done[row.malId]) continue;
    // idempotent re-runs: rows already on TMDB art are done — skip cheaply
    if (row.image && row.image.startsWith(POSTER_BASE)) {
      progress.done[row.malId] = { poster: row.image.slice(POSTER_BASE.length), name: "(already tmdb)", sim: 1 };
      continue;
    }
    const display = (row.titleEnglish || "").trim() || row.title;
    const displayAlt = row.titleEnglish && row.title.trim() !== row.titleEnglish.trim() ? row.title : null;

    // BOTH endpoints always compete — a Special on MAL is often a movie on
    // TMDB and vice versa (Pikachu's Vacation: the tv search surfaced the
    // WRONG "Winter Vacation" special; the movie search has the exact hit)
    const endpoints = row.type === "Movie" ? ["movie", "tv"] : ["tv", "movie"];
    let best = null;
    for (const q of [display, displayAlt]) {
      if (!q) continue;
      const missing = endpoints.filter((ep) => !searchCache.has(`${q}|${row.year || ""}|${ep}`));
      if (missing.length) {
        // both endpoint searches race — TMDB tolerates a handful of rps fine
        const settled = await Promise.all(
          missing.map(async (ep) => {
            const results = await tmdbSearch(ep, q, row.year);
            if (!results.length && row.year) results.push(...(await tmdbSearch(ep, q, null)));
            return [`${q}|${row.year || ""}|${ep}`, results];
          }),
        );
        for (const [k, v] of settled) searchCache.set(k, v);
        await sleep(45 + Math.random() * 60);
      }
      for (const ep of endpoints) {
        const cand = scoreCandidates(searchCache.get(`${q}|${row.year || ""}|${ep}`), row);
        if (cand && (!best || cand.sim > best.sim)) best = cand;
      }
      if (best && best.sim >= 0.995) break; // exact hit — no need for alt titles
    }

    if (best && best.poster) {
      const url = POSTER_BASE + best.poster;
      if (!DRY) await db.anime.update({ where: { malId: row.malId }, data: { image: url } });
      report.matched++;
      if (report.samples.length < 25) {
        report.samples.push({ malId: row.malId, title: display, type: row.type, year: row.year, hit: best.name, hitYear: best.rYear, sim: Number(best.sim.toFixed(3)) });
      }
    } else {
      report.kept++;
    }

    progress.done[row.malId] = best ? { poster: best.poster, name: best.name, sim: best.sim } : false;
    if (i % 50 === 0) {
      writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
      console.log(`[tmdb] ${i}/${rows.length} — matched ${report.matched}, kept ${report.kept}`);
    }
    await sleep(25);
  }

  writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
  console.log(`[tmdb] DONE — matched ${report.matched}, kept ${report.kept} (existing art)`);
}

main()
  .catch((e) => {
    console.error("[tmdb] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
