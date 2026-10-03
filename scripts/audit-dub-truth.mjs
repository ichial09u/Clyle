/**
 * DUB truth audit — checks EVERY anime with hasDub == null:
 *   "none" -> Zoko has no dub entry           -> hasDub = false
 *   "fake" -> dub entry is a byte-copy of sub -> hasDub = false
 *   "real" -> dub entry is a distinct encode  -> hasDub = true
 *
 * Mirrors src/lib/dub-truth.ts (scripts can't import TS). Resumable via
 * db/dub-audit-progress.json; safe to re-run, only touches hasDub==null rows.
 *
 * Usage: node scripts/audit-dub-truth.mjs [concurrency=6] [limit=N] [ids=57181,21]
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const OBF_KEY = "otaku-embed-v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEAD_BYTES = 192 * 1024;
const PROGRESS_FILE = "db/dub-audit-progress.json";
const CONCURRENCY = Math.max(1, parseInt(process.argv[2] ?? "6", 10) || 6);

const db = new PrismaClient();

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(250 + Math.random() * 550);

async function fetchText(url, range) {
  const headers = {
    "User-Agent": UA,
    Origin: "https://zokoanime.video",
    Referer: "https://zokoanime.video/",
    Accept: "text/html,application/xhtml+xml,application/vnd.apple.mpegurl,*/*",
  };
  if (range) headers.Range = range;
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000), redirect: "follow" });
  if (!res.ok && res.status !== 206) return { status: res.status, text: null };
  return { status: res.status, text: await res.text() };
}

async function resolveSrc(malId, lang) {
  const { status, text } = await fetchText(`https://zokoanime.video/stream/mal/${malId}/1/${lang}`);
  if (status === 404 || !text) return null;
  const m = text.match(/window\.__P="([^"]+)"/);
  if (!m) return null;
  try {
    const json = JSON.parse(Buffer.from(xor(atob(m[1].trim())), "latin1").toString("utf8"));
    return typeof json.src === "string" && json.src ? json.src : null;
  } catch {
    return null;
  }
}

/** master + 720p(or middle) variant text in one call */
async function variantText(masterUrl) {
  const master = await fetchText(masterUrl);
  if (!master.text) return null;
  const lines = master.text.split("\n").map((l) => l.trim());
  let variant = null;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i].includes("1280x720")) {
      variant = lines[i + 1];
      break;
    }
  }
  if (!variant) {
    const list = lines.filter((l, i) => l && !l.startsWith("#") && lines[i - 1]?.startsWith("#EXT-X-STREAM-INF"));
    if (!list.length) return null;
    variant = list[Math.floor(list.length / 2)];
  }
  const variantUrl = new URL(variant, masterUrl).href;
  const pl = await fetchText(variantUrl);
  if (!pl.text) return null;
  return { url: variantUrl, text: pl.text };
}

async function fingerprint(variant) {
  const seg = variant.text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!seg) return null;
  const segRes = await fetch(new URL(seg, variant.url).href, {
    headers: { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/", Range: `bytes=0-${HEAD_BYTES - 1}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!segRes.ok && segRes.status !== 206) return null;
  const buf = Buffer.from(await segRes.arrayBuffer());
  if (!buf.length) return null;
  const cr = segRes.headers.get("content-range");
  const total = cr ? parseInt(cr.split("/")[1] ?? "", 10) : buf.length;
  return { sha1: createHash("sha1").update(buf).digest("hex"), total: Number.isFinite(total) ? total : buf.length };
}

/** verdict for one anime (ep 1) — null = undetermined this run */
async function verdictFor(malId) {
  // resolve both pages in parallel — one extra page fetch for dub-less shows
  // is cheaper than serializing the common real-dub path
  const [subSrc, dubSrc] = await Promise.all([resolveSrc(malId, "sub"), resolveSrc(malId, "dub")]);
  if (!dubSrc) return subSrc ? "none" : null; // no dub entry at all
  if (!subSrc) return null; // sub missing is unexpected — skip
  const [vtSub, vtDub] = await Promise.all([variantText(subSrc), variantText(dubSrc)]);
  if (!vtSub || !vtDub) return null;
  // identical variant playlists -> same content, skip segment downloads
  if (vtSub.text === vtDub.text) return "fake";
  const [fpSub, fpDub] = await Promise.all([fingerprint(vtSub), fingerprint(vtDub)]);
  if (!fpSub || !fpDub) return null; // CDN hiccup — retry next run
  return fpSub.sha1 === fpDub.sha1 && fpSub.total === fpDub.total ? "fake" : "real";
}

function loadProgress() {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
  } catch {
    return { verdicts: {}, done: 0 };
  }
}

function saveProgress(p) {
  const tmp = `${PROGRESS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(p));
  renameSync(tmp, PROGRESS_FILE);
}

async function main() {
  const animes = await db.anime.findMany({ where: { hasDub: null }, select: { malId: true, title: true }, orderBy: { popularity: "asc" } });
  const prog = loadProgress();
  const limit = parseInt(process.argv[3] ?? "", 10);
  const idFilter = process.argv[4]?.startsWith("ids=")
    ? new Set(process.argv[4].slice(4).split(",").map(Number).filter(Number.isFinite))
    : null;
  const pool = idFilter ? animes.filter((a) => idFilter.has(a.malId)) : animes;
  const todo = pool.filter((a) => !(a.malId in prog.verdicts)).slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
  console.log(`[audit] ${animes.length} unprobed animes, ${todo.length} to check this run (concurrency ${CONCURRENCY})`);
  const stats = { none: 0, fake: 0, real: 0, unknown: 0 };
  for (const v of Object.values(prog.verdicts)) stats[v] = (stats[v] ?? 0) + 1;

  let idx = 0;
  let pendingWrites = [];
  let sinceSave = 0;

  async function worker(wid) {
    while (true) {
      const i = idx++;
      if (i >= todo.length) return;
      const { malId, title } = todo[i];
      let verdict = null;
      for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
        try {
          verdict = await verdictFor(malId);
        } catch {
          verdict = null;
        }
        if (!verdict) await sleep(1500 + attempt * 3000);
      }
      if (verdict) {
        prog.verdicts[malId] = verdict;
        stats[verdict]++;
        pendingWrites.push({ malId, hasDub: verdict === "real" });
      } else {
        stats.unknown++;
      }
      sinceSave++;
      if (i % 25 === 0 || i === todo.length - 1) {
        console.log(`[audit] ${i + 1}/${todo.length} | none=${stats.none} fake=${stats.fake} real=${stats.real} unknown=${stats.unknown} | last: ${title} (id ${malId})`);
      }
      if (pendingWrites.length >= 50 || i === todo.length - 1) {
        const batch = pendingWrites;
        pendingWrites = [];
        for (const w of batch) {
          await db.anime.update({ where: { malId: w.malId }, data: { hasDub: w.hasDub } }).catch(() => undefined);
        }
      }
      if (sinceSave >= 25) {
        sinceSave = 0;
        saveProgress(prog);
      }
      await jitter();
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  saveProgress(prog);

  // flush anything left
  if (pendingWrites.length) {
    for (const w of pendingWrites) {
      await db.anime.update({ where: { malId: w.malId }, data: { hasDub: w.hasDub } }).catch(() => undefined);
    }
  }

  console.log(`\n[audit] DONE. Verdicts: none(no dub entry)=${stats.none}  fake(copy of sub)=${stats.fake}  real dub=${stats.real}  unknown=${stats.unknown}`);
  console.log(`[audit] hasDub=true count in db:`, await db.anime.count({ where: { hasDub: true } }));
  console.log(`[audit] hasDub=false count in db:`, await db.anime.count({ where: { hasDub: false } }));
  console.log(`[audit] hasDub=null count in db:`, await db.anime.count({ where: { hasDub: null } }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[audit] fatal:", e);
  process.exit(1);
});
