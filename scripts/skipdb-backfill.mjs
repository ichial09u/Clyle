/**
 * SkipDB backfill bot — "for animes that aniskip don't have, use SkipDB".
 *
 * Phase 1 (mapping): give every catalog anime its IMDb id.
 *   - Wikidata dump (scripts/wikidata-mal-imdb.json, P4086+P345) — instant
 *   - Jikan /external as the slower fallback (rate-limited ~3 req/min)
 *   Results live in SkipDbTitle (found=false = miss-cache, recheck in 30d).
 *
 * Phase 2 (fill): vendor SkipDB's approved intro/outro segments into
 * SkipDbFill for every mapped title.
 *   - Source is the official dump (https://skipdb.tv/api/dump, ODbL 1.0),
 *     re-downloaded when older than 7 days — zero per-episode API calls.
 *   - MAL episode -> (IMDb season, episode) comes from ani.zip's per-episode
 *     seasonNumber/episodeNumber (cached under db/skipdb-animap/). Titles
 *     ani.zip doesn't know are filled only when the IMDb title has a single
 *     season (else skipped — a wrong season would silently mismatch keys).
 *   - Every candidate passes the same plausibility gate the player applies.
 *
 * Loops forever (double-detached): hourly passes pick up newly imported
 * catalog anime; the dump refresh brings in new SkipDB episodes weekly.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DUMP_PATH = "/tmp/skipdb-dump.json";
const DUMP_URL = "https://skipdb.tv/api/dump";
const ANIMAP_DIR = "db/skipdb-animap";
const WIKIDATA_MAP = "scripts/wikidata-mal-imdb.json";
const JIKAN_PACE_MS = 20_000; // ~3 req/min — the Jikan rule
const ANIZIP_PACE_MS = 1_200;
const LOOP_SLEEP_MS = 60 * 60 * 1000; // hourly
const DUMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- plausibility gate (mirrors src/lib/skip-times.ts) --------------- */
function plausible(iv, kind, epLenSec) {
  if (!iv || !Number.isFinite(iv.start) || !Number.isFinite(iv.end) || iv.end <= iv.start) return false;
  if (iv.end - iv.start > (kind === "op" ? 180 : 300)) return false;
  const cap = epLenSec && epLenSec > 30 * 60 ? 420 : 320;
  if (iv.start > cap) return false;
  if (epLenSec && iv.end > epLenSec + 30) return false;
  return true;
}

/* ------------------------------- dump handling ------------------------------- */
async function dumpAge() {
  try {
    const s = await stat(DUMP_PATH);
    return Date.now() - s.mtimeMs;
  } catch {
    return Infinity;
  }
}

async function loadDump() {
  if ((await dumpAge()) > DUMP_MAX_AGE_MS) {
    console.log(`[skipdb] dump stale (${Math.round((await dumpAge()) / 86400000)}d) — re-downloading`);
    try {
      const res = await fetch(DUMP_URL, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 1_000_000) {
          await writeFile(DUMP_PATH, buf);
          console.log(`[skipdb] dump downloaded: ${(buf.length / 1e6).toFixed(1)} MB`);
        }
      }
    } catch (e) {
      console.log(`[skipdb] dump download failed (${String(e).slice(0, 120)}) — using existing`);
    }
  }
  try {
    const d = JSON.parse(await readFile(DUMP_PATH, "utf8"));
    // imdb -> season -> episode -> kind -> best row
    const idx = new Map();
    for (const s of d.segments ?? []) {
      if (s.status && s.status !== "approved") continue;
      if (s.segment_type !== "intro" && s.segment_type !== "outro") continue;
      if (!idx.has(s.imdb_id)) idx.set(s.imdb_id, new Map());
      const bySeason = idx.get(s.imdb_id);
      if (!bySeason.has(s.season)) bySeason.set(s.season, new Map());
      const byEp = bySeason.get(s.season);
      if (!byEp.has(s.episode)) byEp.set(s.episode, {});
      const slot = byEp.get(s.episode);
      const kind = s.segment_type === "intro" ? "op" : "ed";
      const row = { start: s.start_ms / 1000, end: s.end_ms / 1000, conf: s.score ?? 0, dur: s.duration_ms ? s.duration_ms / 1000 : null, votes: s.votes_up ?? 0 };
      const cur = slot[kind];
      if (!cur || row.votes > cur.votes || (row.votes === cur.votes && row.conf > cur.conf)) slot[kind] = row;
    }
    console.log(`[skipdb] dump index: ${d.count} rows -> ${idx.size} imdb titles`);
    return idx;
  } catch {
    console.log(`[skipdb] no usable dump on disk yet`);
    return new Map();
  }
}

/* ----------------------------- ani.zip mapping ------------------------------ */
const anizipMem = new Map();
async function anizipEpisodes(malId) {
  if (anizipMem.has(malId)) return anizipMem.get(malId);
  const path = `${ANIMAP_DIR}/${malId}.json`;
  try {
    const j = JSON.parse(await readFile(path, "utf8"));
    anizipMem.set(malId, j);
    return j;
  } catch {
    /* fetch below */
  }
  try {
    const res = await fetch(`https://api.ani.zip/mappings?mal_id=${malId}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const j = await res.json();
      await writeFile(path, JSON.stringify(j)).catch(() => {});
      anizipMem.set(malId, j);
      await sleep(ANIZIP_PACE_MS);
      return j;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** MAL ep -> { season, episode } via ani.zip; null when unmappable */
function mapEp(anizip, ep) {
  const e = anizip?.episodes?.[String(ep)];
  if (e && Number.isFinite(e.seasonNumber) && Number.isFinite(e.episodeNumber)) {
    return { season: e.seasonNumber, episode: e.episodeNumber };
  }
  return null;
}

/* ------------------------------ phase 1: map ------------------------------- */
async function phase1(wikidata) {
  const animes = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true },
    orderBy: { popularity: "asc" },
  });
  const mapped = await db.skipDbTitle.findMany({ select: { malId: true, found: true, imdbId: true, checkedAt: true } });
  const byMal = new Map(mapped.map((r) => [r.malId, r]));
  let newWiki = 0, jikanHits = 0, jikanTried = 0;

  // 1) Wikidata — batched, no network: createMany everything not yet resolved
  const wikiRows = [];
  for (const a of animes) {
    const have = byMal.get(a.malId);
    if (have?.found) continue;
    const wiki = wikidata[a.malId];
    if (!wiki) continue;
    if (have) {
      await db.skipDbTitle.update({
        where: { malId: a.malId },
        data: { imdbId: wiki, found: true, via: "wikidata", checkedAt: new Date() },
      }).catch(() => {});
      newWiki++;
    } else {
      wikiRows.push({ malId: a.malId, imdbId: wiki, found: true, via: "wikidata" });
    }
  }
  if (wikiRows.length) {
    // SQLite Prisma has no skipDuplicates — wikiRows are pre-filtered against
    // the table (only malIds absent from SkipDbTitle), so a plain createMany
    // is collision-free in the single-instance bot.
    try {
      const r = await db.skipDbTitle.createMany({ data: wikiRows });
      newWiki += r.count ?? 0;
    } catch {
      for (const row of wikiRows) {
        await db.skipDbTitle.create({ data: row }).catch(() => {});
        newWiki++;
      }
    }
  }

  // 2) Jikan /external — paced fallback (only for animes Wikidata lacks)
  for (const a of animes) {
    const have = byMal.get(a.malId);
    if (have?.found) continue;
    if (wikidata[a.malId]) continue; // handled above
    if (have && !have.found && Date.now() - have.checkedAt.getTime() < TITLE_RECHECK_MS) continue; // fresh miss
    if (jikanTried >= 150) break; // per-run budget
    try {
      jikanTried++;
      const res = await fetch(`https://api.jikan.moe/v4/anime/${a.malId}/external`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const j = await res.json();
        const link = (j?.data ?? []).find((l) => /^https?:\/\/(?:www\.)?imdb\.com\/title\/tt\d+/.test(l?.url ?? ""));
        const imdb = link?.url?.match(/(tt\d+)/)?.[1] ?? null;
        await db.skipDbTitle.upsert({
          where: { malId: a.malId },
          create: { malId: a.malId, imdbId: imdb, found: !!imdb, via: "jikan" },
          update: { imdbId: imdb, found: !!imdb, via: "jikan", checkedAt: new Date() },
        });
        if (imdb) jikanHits++;
      } else {
        await sleep(JIKAN_PACE_MS / 2);
      }
    } catch {
      await sleep(JIKAN_PACE_MS / 2);
    }
    await sleep(JIKAN_PACE_MS);
  }
  console.log(`[skipdb] phase1: +${newWiki} from wikidata, jikan tried=${jikanTried} hits=${jikanHits}`);
}

/* ------------------------------ phase 2: fill ------------------------------ */
async function phase2(dumpIdx) {
  const titles = await db.skipDbTitle.findMany({ where: { found: true }, select: { malId: true, imdbId: true } });
  const catalog = await db.anime.findMany({ where: { inCatalog: true }, select: { malId: true, totalEpisodes: true } });
  const epCount = new Map(catalog.map((a) => [a.malId, a.totalEpisodes ?? null]));
  let fills = 0, anizipMiss = 0, multiSeasonSkip = 0;

  for (const t of titles) {
    const seasons = dumpIdx.get(t.imdbId);
    if (!seasons || !seasons.size) continue; // SkipDB has nothing for this title
    const total = epCount.get(t.malId) ?? null;

    const anizip = await anizipEpisodes(t.malId);
    let epMapMode = "anizip";
    if (!anizip?.episodes || !Object.keys(anizip.episodes).length) {
      if (seasons.size === 1) {
        epMapMode = "flat"; // single-season IMDb title: MAL ep N == (S1, N)
      } else {
        multiSeasonSkip++;
        continue; // no safe mapping — never guess across seasons
      }
    }
    const maxEp = Math.min(total ?? 4000, 2000);

    for (let ep = 1; ep <= maxEp; ep++) {
      const key = epMapMode === "flat" ? { season: 1, episode: ep } : mapEp(anizip, ep);
      if (!key) continue;
      const slot = seasons.get(key.season)?.get(key.episode);
      if (!slot) continue;
      const op = slot.op, ed = slot.ed;
      if (!op && !ed) continue;

      const opIv = op ? { start: Math.round(op.start * 10) / 10, end: Math.round(op.end * 10) / 10 } : null;
      const edIv = ed ? { start: Math.round(ed.start * 10) / 10, end: Math.round(ed.end * 10) / 10 } : null;
      const epLen = op?.dur ?? ed?.dur ?? null;
      const opOk = opIv && plausible(opIv, "op", epLen) ? opIv : null;
      const edOk = edIv && plausible(edIv, "ed", epLen) ? edIv : null;
      if (!opOk && !edOk) continue;

      for (const [kind, iv, conf] of [
        ["op", opOk, op?.conf ?? 0],
        ["ed", edOk, ed?.conf ?? 0],
      ]) {
        if (!iv) continue;
        await db.skipDbFill.upsert({
          where: { malId_ep_kind: { malId: t.malId, ep, kind } },
          create: { malId: t.malId, ep, kind, start: iv.start, end: iv.end, confidence: conf },
          update: { start: iv.start, end: iv.end, confidence: conf },
        });
        fills++;
      }
    }
  }
  console.log(`[skipdb] phase2: titles=${titles.length} fills=${fills} aniZipMiss(multiSeason)=${multiSeasonSkip}`);
}

/* --------------------------------- main ---------------------------------- */
await mkdir(ANIMAP_DIR, { recursive: true }).catch(() => {});
let wikidata = {};
try {
  wikidata = JSON.parse(await readFile(WIKIDATA_MAP, "utf8"));
} catch {
  console.log(`[skipdb] WARNING: wikidata map missing — Jikan-only mapping`);
}

while (true) {
  const t0 = Date.now();
  try {
    const dumpIdx = await loadDump();
    if (dumpIdx.size) await phase2(dumpIdx); // vendor what's mapped first...
    await phase1(wikidata); // ...then grow the mapping (wikidata instant, Jikan paced)
    const fills = await db.skipDbFill.count();
    const titles = await db.skipDbTitle.count({ where: { found: true } });
    console.log(
      `[skipdb] pass done in ${((Date.now() - t0) / 1000).toFixed(0)}s — mapped titles=${titles}, fills=${fills}`,
    );
  } catch (e) {
    console.log(`[skipdb] pass error: ${String(e?.stack || e).slice(0, 400)}`);
  }
  await sleep(LOOP_SLEEP_MS);
}
