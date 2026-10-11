#!/usr/bin/env node
/**
 * CC-CAPTION CENSUS — Battalion CC-1.
 * Sweeps EVERY in-catalog anime (zoko source) and decodes the zoko SUB + DUB
 * payloads for sample episodes, recording the FULL subtitle language set each
 * payload carries. Answers the owner's demand: "make sure we have all
 * languages in the captions for sub and dub".
 *
 * Per show (concurrency-limited):
 *   - ep 1 + latest episode rows from the Episode table
 *   - SUB payload  -> subtitle track count + normalized language labels
 *   - DUB payload  -> same (only when hasDub=1 — dub pages 404 otherwise)
 * Red flags collected:
 *   sub-zero      SUB payload carries ZERO caption tracks (viewer gets nothing)
 *   dub-zero      hasDub show whose DUB payload carries zero tracks while SUB
 *                 has tracks -> candidate for app-side caption inheritance
 *   tail-zero     latest ep lost the tracks ep1 had (new-ep caption lag)
 *
 * Resumable: progress file skips shows already swept. Report:
 *   scripts/cc-caption-census.json
 */
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const requireFromSrc = createRequire("/home/z/my-project/src/package.json");
const { PrismaClient } = requireFromSrc("@prisma/client");
const db = new PrismaClient();

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_JSON = join(__dirname, "cc-caption-census.json");
const PROGRESS = join(__dirname, "cc-caption-census-progress.jsonl");
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WORKERS = 8;
const TIMEOUT_MS = 15_000;

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- payload decode (same recipe as the app: b64 -> XOR -> unescape) ---------- */
function xorBuf(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}
function decodePayload(html) {
  const m = html.match(/window\.__P\s*=\s*"([^"]+)"/);
  if (!m) return null;
  let dec;
  try {
    dec = xorBuf(Buffer.from(m[1], "base64"), Buffer.from(KEY, "utf8")).toString("utf8");
  } catch {
    return null;
  }
  try {
    dec = decodeURIComponent(dec);
  } catch {
    /* already plain */
  }
  try {
    return JSON.parse(dec);
  } catch {
    try {
      return JSON.parse(dec.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    } catch {
      return null;
    }
  }
}
async function fetchPayload(malId, ep, lang) {
  const url = `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 404) return { missing: true };
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const html = await res.text();
      const payload = decodePayload(html);
      if (!payload) return { error: "no/undecodable __P" };
      return { payload };
    } catch (e) {
      clearTimeout(t);
      if (attempt === 1) return { error: String(e.message || e).slice(0, 80) };
      await sleep(1200);
    }
  }
  return { error: "unreachable" };
}

/* ---------- language label normalization ---------- */
function normLangs(subs) {
  if (!Array.isArray(subs)) return [];
  const seen = new Set();
  for (const s of subs) {
    const label = String(s?.label || s?.lang || "").trim();
    if (label) seen.add(label.toLowerCase());
  }
  return [...seen];
}

/* ---------- done set ---------- */
const done = new Set();
if (existsSync(PROGRESS)) {
  for (const line of readFileSync(PROGRESS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // error rows are retried on the next run — only successful sweeps count as done
      if (r.flag !== "error") done.add(r.malId);
    } catch {}
  }
}
const append = (row) => appendFileSync(PROGRESS, JSON.stringify(row) + "\n");

/* ---------------- main sweep ---------------- */
const animes = await db.anime.findMany({
  where: { inCatalog: true, malId: { lt: 999900 } },
  orderBy: { popularity: "desc" },
  select: { malId: true, title: true, hasDub: true },
});
const epBounds = await db.episode.groupBy({
  by: ["animeId"],
  _min: { number: true },
  _max: { number: true },
});
const boundsOf = new Map(epBounds.map((b) => [b.animeId, b]));
const boundsByMal = new Map();
for (const [animeId, b] of boundsOf) {
  // Anime.malId IS the primary key — animeId on Episode == malId
  boundsByMal.set(animeId, b);
}

const todo = animes.filter((a) => !done.has(a.malId));
log(`census: ${animes.length} shows, ${done.size} already swept, ${todo.length} to go, ${WORKERS} workers`);

const rows = [];
let idx = 0;
let flags = { subZero: 0, dubZero: 0, tailZero: 0 };

async function sweepShow(id, a, boundsFor) {
  const { _min, _max } = boundsFor;
  const ep1 = Math.max(1, _min?.number ?? 1);
  const epLast = Math.max(ep1, _max?.number ?? ep1);
  const eps = [...new Set([ep1, epLast])];

  const subResults = {};
  for (const ep of eps) {
    const r = await fetchPayload(a.malId, ep, "sub");
    subResults[ep] = r;
    await sleep(150);
  }
  let dubResult = null;
  if (a.hasDub) {
    dubResult = await fetchPayload(a.malId, ep1, "dub");
    await sleep(150);
  }

  const sub1 = subResults[eps[0]];
  const subL = subResults[eps[eps.length - 1]];
  const sub1Langs = sub1?.payload ? normLangs(sub1.payload.subtitles) : null;
  const subLLangs = subL?.payload ? normLangs(subL.payload.subtitles) : null;
  const dubLangs = dubResult?.payload ? normLangs(dubResult.payload.subtitles) : null;

  const row = {
    malId: a.malId,
    title: a.title,
    hasDub: !!a.hasDub,
    ep1,
    epLast,
    sub1Tracks: sub1Langs ? sub1Langs.length : null,
    sub1Langs,
    sub1Missing: !!sub1?.missing,
    sub1Error: sub1?.error || null,
    subLastTracks: subLLangs ? subLLangs.length : null,
    subLastLangs: subLLangs,
    subLastMissing: !!subL?.missing,
    subLastError: subL?.error || null,
    dubTracks: dubLangs ? dubLangs.length : null,
    dubLangs,
    dubMissing: dubResult ? !!dubResult.missing : null,
    dubError: dubResult?.error || null,
  };
  if (sub1Langs && sub1Langs.length === 0) row.flag = "sub-zero";
  else if (a.hasDub && dubLangs && dubLangs.length === 0 && sub1Langs && sub1Langs.length > 0) row.flag = "dub-zero";
  else if (subLLangs && subLLangs.length === 0 && sub1Langs && sub1Langs.length > 0 && epLast !== ep1) row.flag = "tail-zero";
  return row;
}

async function bot2(id) {
  await sleep(id * 350);
  for (;;) {
    const i = idx++;
    if (i >= todo.length) return;
    const a = todo[i];
    const b = boundsByMal.get(a.malId);
    const bounds = b ?? { _min: { number: 1 }, _max: { number: 1 } };
    try {
      const row = await sweepShow(id, a, bounds);
      rows.push(row);
      append({ malId: a.malId, flag: row.flag || null });
      if (row.flag === "sub-zero") flags.subZero++;
      if (row.flag === "dub-zero") flags.dubZero++;
      if (row.flag === "tail-zero") flags.tailZero++;
      if (row.flag) log(`[w${id}] ${a.title}: FLAG ${row.flag} (sub1=${row.sub1Tracks} dub=${row.dubTracks} last=${row.subLastTracks})`);
    } catch (e) {
      log(`[w${id}] ${a.title}: ERROR ${String(e.message || e).slice(0, 100)}`);
      append({ malId: a.malId, flag: "error" });
    }
    if (rows.length % 100 === 0) {
      writeFileSync(OUT_JSON + ".partial", JSON.stringify({ at: new Date().toISOString(), swept: rows.length, total: todo.length, flags, rows }, null, 0));
    }
  }
}

// build malId -> db id map done above

await Promise.all(Array.from({ length: WORKERS }, (_, i) => bot2(i + 1)));

/* ---------------- report ---------------- */
// a resume no-op (nothing new swept) must NOT clobber the previous full report
if (rows.length > 0) {
  const flagged = rows.filter((r) => r.flag);
const withSub = rows.filter((r) => r.sub1Tracks != null && r.sub1Tracks > 0);
const langHistogram = {};
for (const r of rows) {
  for (const l of r.sub1Langs || []) langHistogram[l] = (langHistogram[l] || 0) + 1;
}
const report = {
  at: new Date().toISOString(),
  swept: rows.length,
  total: animes.length,
  showsWithSubTracks: withSub.length,
  showsSubZero: rows.filter((r) => r.sub1Tracks === 0).length,
  showsDubProbed: rows.filter((r) => r.dubTracks != null).length,
  showsDubZero: rows.filter((r) => r.dubTracks === 0).length,
  showsDubInheritCandidates: rows.filter((r) => r.dubTracks === 0 && (r.sub1Tracks || 0) > 0).length,
  tailZero: rows.filter((r) => r.flag === "tail-zero").length,
  langHistogram,
  flagged,
  rows,
};
  writeFileSync(OUT_JSON, JSON.stringify(report));
  log(`DONE: ${rows.length}/${animes.length} swept`);
  log(`sub tracks>0: ${withSub.length} | sub=0: ${report.showsSubZero} | dub probed: ${report.showsDubProbed} | dub=0: ${report.showsDubZero} | inherit candidates: ${report.showsDubInheritCandidates}`);
  const topLangs = Object.entries(langHistogram).sort((a, b) => b[1] - a[1]).slice(0, 20);
  log(`top languages: ${topLangs.map(([l, n]) => `${l}:${n}`).join(", ")}`);
} else {
  log(`nothing new swept — previous report left untouched`);
}
await db.$disconnect();
