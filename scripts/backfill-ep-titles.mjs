/**
 * Catalog backfill: real episode titles for every untitled episode.
 *
 * Episode rows created from AniList's aired count carry no title, so the
 * player header used to fall back to "Episode 1 DUB". Two sources, in order:
 *
 *   Phase A — AniList `streamingEpisodes` (healthy, ~1 request per 20 anime):
 *     titles like "Episode 1 - Ryomen Sukuna" for streaming-covered shows.
 *     Coverage is a sliding recent window for long-runners, complete for
 *     normal-length shows.
 *
 *   Phase B — MAL's paginated episode list (Jikan v4) for whatever is still
 *     missing. Complete data, but the public origin regularly 504-sheds, so
 *     this phase is circuit-broken (aborts the run after repeated failures —
 *     just re-run later; everything is resumable).
 *
 * Both phases only touch pages/rows that are actually untitled:
 *  - Resumable by construction: fully-titled anime cost one indexed query.
 *  - Popularity-first: shows people actually watch get titles early.
 *  - Jikan rate-limit aware: ~1.05 s spacing (≈57 req/min), 10 s backoff +
 *    retry on 429/5xx, circuit-break after 5 consecutive dead pages.
 *  - Jikan 404s (no MAL episode list) are memoised in scripts/ep-title-404.json
 *    — but ONLY true 404s, never rate-limit failures.
 *
 * Usage: node scripts/backfill-ep-titles.mjs [--limit N] [--only malId,...]
 *        [--skip-anilist] [--skip-jikan]
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// never let a stray async failure kill the run — log it and move on
process.on("unhandledRejection", (err) => {
  console.error("[backfill] unhandledRejection:", err?.message ?? err);
});
process.on("uncaughtException", (err) => {
  console.error("[backfill] uncaughtException:", err?.stack ?? err);
});

const STATE_404 = path.resolve("scripts/ep-title-404.json");

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (flag) => args.includes(flag);
const LIMIT = parseInt(argOf("--limit") ?? "0", 10) || Infinity;
const ONLY = (argOf("--only") ?? "")
  .split(",")
  .map((s) => parseInt(s, 10))
  .filter(Number.isFinite);
const DO_ANILIST = !hasFlag("--skip-anilist");
const DO_JIKAN = !hasFlag("--skip-jikan");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same acceptance rule as src/lib/sync.ts cleanEpisodeTitle — MAL's bare
 *  "Episode 12" placeholders would render as "Episode 12: Episode 12". */
function cleanTitle(raw) {
  const t = raw?.trim();
  if (!t) return null;
  if (/^ep(isode)?\.?\s*\d+(\s*(end|final))?$/i.test(t)) return null;
  return t;
}

/** "Episode 12 - Real Title" / "Episode 12: Real Title" -> [12, "Real Title"] */
function parseStreamingEpisodeTitle(raw) {
  const m = raw?.trim().match(/^Episode\s+(\d+)\s*[-–—:]\s*(.+)$/i);
  if (!m) return null;
  return { number: parseInt(m[1], 10), title: m[2].trim() };
}

function curlGet(url, timeoutMs = 25_000, extra = []) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      // NOTE: no --compressed — Jikan's origin 504s when gzip is requested
      ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), ...extra, "-w", "\n__STATUS__%{http_code}", url],
      { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return reject(new Error(stderr || err?.message || "curl failed"));
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

/* ================= Phase A — AniList streamingEpisodes ================= */

const AL_URL = "https://graphql.anilist.co";
let alRequests = 0;

async function anilistBatch(malIds) {
  const query = `
    query ($ids: [Int]) {
      Page(perPage: 50) {
        media(idMal_in: $ids, type: ANIME) {
          idMal
          streamingEpisodes { title }
        }
      }
    }`;
  const payload = JSON.stringify({ query, variables: { ids: malIds } });
  for (let tries = 0; tries < 3; tries++) {
    await sleep(alRequests === 0 ? 0 : 850); // ≈70 req/min, under AniList's 90
    alRequests++;
    if (alRequests % 25 === 0) console.log(`[backfill] … AniList heartbeat: ${alRequests} batch requests`);
    let status = 0;
    let body = "";
    try {
      ({ status, body } = await curlGet(AL_URL, 30_000, [
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-d", payload,
      ]));
    } catch {
      status = 0;
    }
    if (status === 200) {
      try {
        return JSON.parse(body)?.data?.Page?.media ?? [];
      } catch {
        status = 0; // malformed body — retry
      }
    }
    if (tries < 2) await sleep(20_000 * (tries + 1));
  }
  return null; // batch gave up — retried on a future run
}

async function phaseAniList(targets) {
  console.log(`[backfill] Phase A: AniList streamingEpisodes for ${targets.length} anime`);
  // chunks of 20 keep response size sane (long-runners carry 250+ entries)
  const chunks = [];
  for (let i = 0; i < targets.length; i += 20) chunks.push(targets.slice(i, i + 20));

  let animeTouched = 0;
  let episodesFilled = 0;
  for (const chunk of chunks) {
    const media = await anilistBatch(chunk);
    if (media == null) {
      console.log("[backfill] AniList batch gave up — continuing with the next chunk");
      continue;
    }
    // idMal_in can match several AniList entries; keep the richest per malId
    const best = new Map();
    for (const m of media) {
      if (!m?.idMal) continue;
      const eps = (m.streamingEpisodes ?? [])
        .map((e) => parseStreamingEpisodeTitle(e?.title))
        .filter(Boolean);
      if (!best.has(m.idMal) || best.get(m.idMal).length < eps.length) best.set(m.idMal, eps);
    }
    for (const [malId, eps] of best) {
      if (!eps.length) continue;
      let filled = 0;
      for (const e of eps) {
        const title = cleanTitle(e.title);
        if (!title || !Number.isFinite(e.number)) continue;
        const r = await db.episode.updateMany({
          where: { animeId: malId, number: e.number, lang: "sub", title: null },
          data: { title },
        });
        filled += r.count;
      }
      if (filled > 0) {
        animeTouched++;
        episodesFilled += filled;
      }
    }
  }
  console.log(`[backfill] Phase A done: ${episodesFilled} episodes titled across ${animeTouched} anime (${alRequests} AniList requests)`);
  return episodesFilled;
}

/* ================= Phase B — Jikan MAL episode lists ================= */

const MIN_INTERVAL_MS = 1050; // ≈57 req/min — safely under Jikan's 60/min
let lastRequestAt = 0;
let requests = 0;
let backoffs = 0;

async function jikanEpisodesPage(malId, page) {
  const url = `https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`;
  for (let tries = 0; tries < 3; tries++) {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    requests++;
    if (requests % 25 === 0) console.log(`[backfill] … Jikan heartbeat: ${requests} requests, ${backoffs} backoffs`);
    let status = 0;
    let body = "";
    try {
      ({ status, body } = await curlGet(url));
    } catch {
      status = 0;
    }
    if (status === 200) {
      try {
        return JSON.parse(body);
      } catch {
        status = 0; // malformed body — retry below
      }
    }
    if (status === 404) return null; // no episode list on MAL
    // 429 / 5xx — Jikan sheds load; back off and retry
    backoffs++;
    await sleep(10_000 * (tries + 1));
    lastRequestAt = Date.now();
  }
  return undefined; // gave up on this page (will be retried next run)
}

/* ---------------- 404 memo ---------------- */
let noList = new Set();
if (existsSync(STATE_404)) {
  try {
    noList = new Set(JSON.parse(readFileSync(STATE_404, "utf8")));
  } catch {
    noList = new Set();
  }
}
const save404 = () => {
  try {
    writeFileSync(STATE_404, JSON.stringify([...noList].sort((a, b) => a - b), null, 0));
  } catch {
    /* best-effort */
  }
};

async function phaseJikan(targets) {
  console.log(`[backfill] Phase B: Jikan MAL episode lists for ${targets.length} anime`);
  const t0 = Date.now();
  let animeDone = 0;
  let animeSkipped = 0;
  let episodesFilled = 0;
  let consecutiveDead = 0;

  for (const malId of targets) {
    if (animeDone >= LIMIT) break;
    if (noList.has(malId)) {
      animeSkipped++;
      continue;
    }
    if (consecutiveDead >= 5) {
      console.log(`[backfill] Jikan origin looks down (${consecutiveDead} dead pages in a row) — stopping Phase B; re-run later to resume`);
      break;
    }

    const missing = await db.episode.findMany({
      where: { animeId: malId, lang: "sub", title: null },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    if (missing.length === 0) continue; // filled by Phase A or an earlier run

    const want = new Set(missing.map((e) => e.number));
    const pages = [...new Set(missing.map((e) => Math.floor((e.number - 1) / 100) + 1))].sort((a, b) => a - b);

    let filled = 0;
    let listed = 0;
    let saw404 = false;
    let gaveUp = false;
    for (const page of pages) {
      const res = await jikanEpisodesPage(malId, page);
      if (res === null) {
        saw404 = true; // this page truly does not exist on MAL
        continue;
      }
      if (res === undefined) {
        gaveUp = true; // 429/5xx/timeout — retried on a future run, NOT a 404
        continue;
      }
      if (!res?.data?.length) continue;
      listed++;
      consecutiveDead = 0;
      for (const e of res.data) {
        if (!want.has(e.mal_id)) continue;
        const title = cleanTitle(e.title) ?? cleanTitle(e.title_english);
        if (!title) continue;
        const r = await db.episode.updateMany({
          where: { animeId: malId, number: e.mal_id, lang: "sub", title: null },
          data: { title },
        });
        filled += r.count;
      }
    }

    if (listed === 0 && (gaveUp || !saw404)) {
      // every page was network-dead (gave up) or unanswered — count toward
      // the breaker so a Jikan outage can't burn the whole run
      consecutiveDead++;
    }
    if (listed === 0 && saw404 && !gaveUp) {
      // MAL answered 404 for every page we probed — genuinely no episode list
      noList.add(malId);
      save404();
      console.log(`[backfill] ${malId} ${titleOf.get(malId) ?? ""} → no MAL episode list (memoised)`);
    } else {
      console.log(`[backfill] ${malId} ${titleOf.get(malId) ?? ""} → ${filled}/${missing.length} titled (pages ${pages.length}${gaveUp ? ", some gave up — will retry" : ""}, reqs ${requests}, backoffs ${backoffs})`);
    }
    episodesFilled += filled;
    animeDone++;
  }

  console.log(`[backfill] Phase B done in ${Math.round((Date.now() - t0) / 1000)}s — ${episodesFilled} episodes titled across ${animeDone} anime (${animeSkipped} skipped via 404 memo, ${requests} Jikan requests, ${backoffs} backoffs)`);
  return episodesFilled;
}

/* ---------------- main ---------------- */
const t0 = Date.now();
console.log(`[backfill] catalog episode-title backfill starting at ${new Date().toISOString()}`);

const groups = await db.episode.groupBy({
  by: ["animeId"],
  where: { lang: "sub", title: null },
  _count: { number: true },
});
let targets = groups.map((g) => g.animeId);
if (ONLY.length) targets = targets.filter((id) => ONLY.includes(id));

const animeRows = await db.anime.findMany({
  where: { malId: { in: targets } },
  select: { malId: true, title: true, popularity: true },
});
const popOf = new Map(animeRows.map((a) => [a.malId, a.popularity ?? Number.MAX_SAFE_INTEGER]));
const titleOf = new Map(animeRows.map((a) => [a.malId, a.title]));
targets.sort((a, b) => (popOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (popOf.get(b) ?? Number.MAX_SAFE_INTEGER));

console.log(`[backfill] ${targets.length} anime have untitled episodes (${groups.reduce((s, g) => s + g._count.number, 0)} episodes total)`);

let totalFilled = 0;
if (DO_ANILIST && targets.length) totalFilled += await phaseAniList(targets);

if (DO_JIKAN) {
  // only anime that are STILL untitled after Phase A
  const still = await db.episode.groupBy({
    by: ["animeId"],
    where: { lang: "sub", title: null },
    _count: { number: true },
  });
  let jikanTargets = still.map((g) => g.animeId);
  if (ONLY.length) jikanTargets = jikanTargets.filter((id) => ONLY.includes(id));
  jikanTargets.sort((a, b) => (popOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (popOf.get(b) ?? Number.MAX_SAFE_INTEGER));
  if (jikanTargets.length) totalFilled += await phaseJikan(jikanTargets);
  else console.log("[backfill] Phase B: nothing left — Phase A covered everything");
}

const remaining = await db.episode.count({ where: { lang: "sub", title: null } });
console.log(`[backfill] DONE in ${Math.round((Date.now() - t0) / 1000)}s — ${totalFilled} episodes titled; ${remaining} still untitled`);
await db.$disconnect();
