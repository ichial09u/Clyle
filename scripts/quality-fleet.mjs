#!/usr/bin/env node
/**
 * QUALITY FLEET — bots that measure the REAL resolution ladder of every
 * episode's Zoko encode and store it on the Episode row.
 *
 * Owner report: the download dialog (and anything that assumed the classic
 * 360p/720p/1080p ladder) marked old Bleach ep1 "1080p" when the encode is
 * 360p. The truth is in each episode's HLS master playlist
 * (`#EXT-X-STREAM-INF:...,RESOLUTION=WxH`). These bots read it for every
 * episode and persist the height list (Episode.qualities, JSON array) so the
 * player shows/downloads only what actually exists.
 *
 * Per episode the work is 2 small fetches (stream page -> payload decode ->
 * master playlist) — no segments, no ffmpeg, so bots are fast. Re-runnable:
 * episodes with a stored ladder are skipped unless --force.
 *
 * Usage:
 *   node scripts/quality-fleet.mjs --top 300 --workers 6     (catalog sweep, popular first)
 *   node scripts/quality-fleet.mjs --malId 269 --eps 1-60    (one anime, e.g. Bleach)
 *   flags: --force --quiet --lang sub
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// the harness injects a global DATABASE_URL pointing at <root>/db/custom.db
// (which doesn't exist — the real db lives in src/db/) — always win here
process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const requireFromSrc = createRequire("/home/z/my-project/src/package.json");
const { PrismaClient } = requireFromSrc("@prisma/client");
const db = new PrismaClient();

const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_JSONL = join(__dirname, "quality-fleet-report.jsonl");
try {
  mkdirSync(__dirname, { recursive: true });
} catch {
  /* already there */
}

/* ---------------- args ---------------- */
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const MAL_ID = parseInt(flag("malId"), 10) || null;
const TOP_N = parseInt(flag("top"), 10) || null;
const EPS = flag("eps", null); // "1-366" | "25" | null = whatever Episode rows exist
const WORKERS = Math.max(1, parseInt(flag("workers"), 10) || 6);
const LANG = flag("lang") === "dub" ? "dub" : "sub";
const FORCE = flag("force") === true;
const QUIET = flag("quiet") === true;

const log = (...m) => { if (!QUIET) console.log(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, opts, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2_500 + Math.random() * 2_000);
    }
  }
}

/* ---------------- zoko page + master playlist ---------------- */
function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decodeBlob(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

async function resolveStreamPage(malId, ep, lang) {
  for (const server of ["zoko", "kiwi"]) {
    try {
      const url = server === "kiwi"
        ? `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}?server=kiwi`
        : `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
      const res = await fetchRetry(url, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) });
      if (res.status === 404 || res.status === 410) continue;
      const html = await res.text();
      const m = html.match(/window\.__P="([^"]+)"/);
      if (!m) continue;
      const json = decodeBlob(m[1]);
      if (json?.src) return { server, src: json.src };
    } catch { /* try next server */ }
  }
  return null;
}

function parseHeights(master) {
  const out = new Set();
  for (const line of master.split("\n")) {
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const m = line.match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i);
    if (m) {
      const h = parseInt(m[2], 10);
      if (h > 0) out.add(h);
    }
  }
  return [...out].sort((a, b) => b - a);
}

async function measureEpisode(malId, ep) {
  const resolved = await resolveStreamPage(malId, ep, LANG);
  if (!resolved) return { ep, status: "no-stream" };
  let master;
  try {
    const res = await fetchRetry(resolved.src, { headers: H, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ep, status: `master-${res.status}`, server: resolved.server };
    master = await res.text();
  } catch (e) {
    return { ep, status: "master-error", server: resolved.server, detail: String(e.message).slice(0, 80) };
  }
  const heights = parseHeights(master);
  if (!heights.length) return { ep, status: "no-resolution-tags", server: resolved.server };
  return { ep, status: "ok", server: resolved.server, heights };
}

/* ---------------- work list ---------------- */
function epsRange(spec) {
  const out = [];
  for (const part of String(spec).split(",")) {
    const m = part.match(/^(\d+)(-(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[3] ? parseInt(m[3], 10) : a;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)];
}

async function buildWork() {
  // episode rows joined with anime popularity — the fleet sweeps the catalog
  // most-popular first, and only episodes with no stored ladder yet
  const where = { lang: "sub", ...(FORCE ? {} : { qualities: null }) };
  if (MAL_ID) where.animeId = MAL_ID;
  else if (TOP_N) {
    const animes = await db.anime.findMany({
      where: { inCatalog: true },
      orderBy: { popularity: { sort: "asc", nulls: "last" } },
      take: TOP_N,
      select: { malId: true },
    });
    where.animeId = { in: animes.map((a) => a.malId) };
  } else throw new Error("need --malId or --top N");

  const rows = await db.episode.findMany({
    where,
    select: { animeId: true, number: true },
    orderBy: { animeId: "asc" },
  });
  return rows;
}

/* ---------------- main ---------------- */
const t0 = Date.now();
const jobs = await buildWork();
if (EPS) {
  const want = new Set(epsRange(EPS));
  const filtered = jobs.filter((j) => want.has(j.number));
  if (filtered.length === 0) {
    // MAL-id mode may want episodes that have no Episode row yet — synthesize
    const anime = await db.anime.findUnique({ where: { malId: MAL_ID }, select: { title: true } });
    if (MAL_ID && anime) {
      const lo = Math.min(...want), hi = Math.max(...want);
      for (let i = lo; i <= hi; i++) filtered.push({ animeId: MAL_ID, number: i });
    }
  }
  jobs.length = 0;
  jobs.push(...filtered);
}
const titles = new Map(
  (await db.anime.findMany({ where: { malId: MAL_ID ? { in: [MAL_ID] } : undefined }, select: { malId: true, title: true } })).map((a) => [a.malId, a.title]),
);
log(`quality fleet: ${jobs.length} episodes, ${WORKERS} bots, lang=${LANG}`);

let idx = 0;
const progress = { done: 0, total: jobs.length, ok: 0, statuses: {} };
function tick(status) {
  progress.done++;
  progress.statuses[status] = (progress.statuses[status] ?? 0) + 1;
  if (status === "ok") progress.ok++;
}

async function bot(id) {
  // stagger the bots — simultaneous Zoko page hits at boot trip per-IP bursts
  await sleep((id - 1) * 4_000 + Math.random() * 1_500);
  for (;;) {
    const i = idx++;
    if (i >= jobs.length) return;
    const { animeId: malId, number: ep } = jobs[i];
    const title = titles.get(malId) ?? `Anime ${malId}`;
    try {
      const r = await measureEpisode(malId, ep);
      if (r.status === "ok" && r.heights?.length) {
        await db.episode.updateMany({
          where: { animeId: malId, number: ep, lang: "sub" },
          data: { qualities: JSON.stringify(r.heights) },
        });
      }
      tick(r.status);
      appendFileSync(REPORT_JSONL, JSON.stringify({ at: new Date().toISOString(), malId, title, ...r }) + "\n");
      log(`[bot${id}] ${title} ep${ep}: ${r.status}${r.heights ? ` ${r.heights.join("/")}` : ""}`);
    } catch (e) {
      tick("error");
      appendFileSync(REPORT_JSONL, JSON.stringify({ at: new Date().toISOString(), malId, title, ep, status: "error", detail: String(e.message).slice(0, 120) }) + "\n");
      log(`[bot${id}] ${title} ep${ep}: ERROR ${String(e.message).slice(0, 100)}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(WORKERS, Math.max(1, jobs.length)) }, (_, i) => bot(i + 1)));
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\nquality fleet done in ${mins}min — ${progress.done}/${progress.total} episodes, ${progress.ok} measured`);
console.log("statuses:", JSON.stringify(progress.statuses));
await db.$disconnect();
