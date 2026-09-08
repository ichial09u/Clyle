/**
 * Mass dub hunt — BACKUP network edition. Sweeps the catalog for anime whose
 * MAIN chain cannot dub some episodes and whose backup providers DECLARE a
 * dub for them, then hands each (anime, provider, ep) to the audio fleet
 * (dub-audio-fleet-backup.mjs) for the real verdict: decoded-audio MD5,
 * loudness-envelope correlation, and ASR language classification. Rows land
 * in DubAudio(server="anivexa-<provider>"), which the episodes route and the
 * /api/stream anivexa branch consume as honesty gates — a provider whose
 * "dub" is measured as Japanese audio (or which can't actually serve) never
 * gets a button.
 *
 * Candidate "needed" episodes mirror the episodes-route logic:
 *   - boundaries known  -> [chainMax+1 .. total] plus per-episode probe holes
 *   - sub-only show     -> every episode (hasDub/hasDubKiwi/hasDubMega all
 *                          false, or chains proven 0)
 * Rows persist, so each pass only pays for unverified pairs; providers that
 * were down last pass get re-probed this pass (they recover on their own).
 *
 *   node scripts/dub-audio-sweep-backup.mjs [topN=40]
 */
import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TOPN = parseInt(process.argv[2] || "40", 10);
const LOG = join(process.cwd(), "scripts", "dub-audio-sweep-backup.jsonl");
const BASE = "https://anivexa-api.vercel.app";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROVIDERS = ["anineko", "animegg", "hianime", "allmanga", "reanime"];

const log = (obj) => {
  try { appendFileSync(LOG, JSON.stringify(obj) + "\n"); } catch {}
};

/* ------------------------- alId mapping + synonyms ------------------------ */

const AL_CACHE_DIR = join(process.cwd(), "db", "anilist-cache");
const AL_MAP = join(process.cwd(), "db", "al-map.json");
let alMap = {};
if (existsSync(AL_MAP)) { try { alMap = JSON.parse(readFileSync(AL_MAP, "utf8")); } catch {} }
const titleSynonyms = {};

function alIdFromDiskCache(id) {
  const key = `MediaByMal:${JSON.stringify({ idMal: id })}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  try {
    const entry = JSON.parse(readFileSync(join(AL_CACHE_DIR, `${hash}.json`), "utf8"));
    const m = entry?.data?.Media;
    if (m?.id) {
      alMap[id] = m.id;
      titleSynonyms[id] = [m.title?.romaji, m.title?.english, ...(m.synonyms ?? [])].filter(Boolean);
      return m.id;
    }
  } catch {}
  return null;
}

async function anilistIdForMal(id) {
  if (alMap[id]) return alMap[id];
  const cached = alIdFromDiskCache(id);
  if (cached) { try { writeMap(); } catch {} return cached; }
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ query: "query($id:Int){Media(idMal:$id,type:ANIME){id}}", variables: { id } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const al = json?.data?.Media?.id ?? null;
    if (al) { alMap[id] = al; try { writeMap(); } catch {} }
    return al;
  } catch { return null; }
}
function writeMap() { try { writeFileSync(AL_MAP, JSON.stringify(alMap)); } catch {} }

function titlesRoughlyMatch(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter++;
  return inter / (Math.min(tx.size, ty.size) || 1) >= 0.6;
}
function metaMatchesShow(metaTitle, titles) {
  if (!metaTitle) return true;
  return titles.some((t) => titlesRoughlyMatch(t, metaTitle));
}

/* ------------------------------ anivexa calls ----------------------------- */

async function anivexaEpisodes(alId) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const res = await fetch(`${BASE}/episodes/${alId}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && typeof json === "object" && PROVIDERS.some((p) => json[p])) return json;
      }
    } catch {}
    if (tries === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/* -------------------------------- candidates ------------------------------ */

const verifiedPairs = new Set(
  (await db.dubAudio.findMany({ where: { server: { startsWith: "anivexa-" } }, select: { malId: true, ep: true, server: true } }))
    .map((r) => `${r.malId}:${r.ep}:${r.server}`),
);

const cands = await db.anime.findMany({
  where: { inCatalog: true, totalEpisodes: { gte: 1 } },
  orderBy: { popularity: "asc" },
  select: {
    malId: true, title: true, titleEnglish: true, totalEpisodes: true,
    hasDub: true, hasDubKiwi: true, hasDubMega: true, dubThruS1: true, dubThruS2: true,
  },
});

function neededEps(a) {
  const total = a.totalEpisodes;
  const s1 = a.dubThruS1, s2 = a.dubThruS2;
  const boundariesKnown = s1 != null || s2 != null;
  const provenNone = (s1 ?? 1) <= 0 && (s2 ?? 1) <= 0 && boundariesKnown;
  const chainClaimsNoDub = a.hasDub === false && a.hasDubKiwi === false && a.hasDubMega === false;
  const needed = [];
  const push = (from, to) => { for (let e = Math.max(1, from); e <= Math.min(to, total); e++) needed.push(e); };
  if (provenNone || (!boundariesKnown && chainClaimsNoDub)) {
    push(1, total); // sub-only show — every episode is a backup-dub candidate
  } else if (boundariesKnown) {
    const chainMax = Math.max(s1 ?? 0, s2 ?? 0);
    push(chainMax + 1, total);
  } else {
    return needed; // unprobed with a claimed dub — optimistic, no clutter
  }
  return [...new Set(needed)].sort((x, y) => x - y);
}

const work = [];
for (const a of cands) {
  const needed = neededEps(a);
  if (!needed.length) continue;
  work.push({ a, needed });
  if (work.length >= TOPN) break;
}
console.log(`sweep pass: ${work.length} candidate anime (of ${cands.length} catalog) — ${new Date().toISOString()}`);

let probes = 0, written = 0, skipped = 0;
for (const { a, needed } of work) {
  const title = a.titleEnglish?.trim() || a.title;
  const alId = await anilistIdForMal(a.malId);
  if (!alId) { log({ at: new Date().toISOString(), malId: a.malId, title, status: "no-alId" }); continue; }
  if (!titleSynonyms[a.malId]) titleSynonyms[a.malId] = [title];
  const neededSet = new Set(needed);

  const eps = await anivexaEpisodes(alId);
  if (!eps) { log({ at: new Date().toISOString(), malId: a.malId, title, status: "anivexa-down" }); continue; }

  // providers that declare dub for at least one NEEDED episode, right show
  const covering = [];
  for (const p of PROVIDERS) {
    const pv = eps[p];
    if (!pv || pv.error) continue;
    const metaTitle = pv.meta?.title?.trim();
    if (metaTitle && !metaMatchesShow(metaTitle, titleSynonyms[a.malId])) {
      log({ at: new Date().toISOString(), malId: a.malId, title, provider: p, status: "wrong-show", metaTitle });
      continue;
    }
    const dub = (pv.episodes?.dub ?? []).map((e) => Math.floor(e.number)).filter(Number.isFinite);
    const hit = dub.filter((e) => neededSet.has(e));
    if (hit.length) covering.push({ p, eps: hit });
  }
  if (!covering.length) { log({ at: new Date().toISOString(), malId: a.malId, title, status: "no-coverage", needed: needed.length }); continue; }

  console.log(`[${title}] needed=${needed.length} covering=${covering.map((c) => `${c.p}(${c.eps.length})`).join(",")}`);

  for (const { p, eps: hitEps } of covering.slice(0, 2)) {
    const server = `anivexa-${p}`;
    // at most 2 verdicts per provider per pass — first covered + one more
    const chosen = [hitEps[0], hitEps[Math.floor(hitEps.length / 2)], hitEps[hitEps.length - 1]]
      .filter((e, i, arr) => arr.indexOf(e) === i && !verifiedPairs.has(`${a.malId}:${e}:${server}`))
      .slice(0, 2);
    for (const ep of chosen) {
      probes++;
      try {
        const out = execSync(
          `node scripts/dub-audio-fleet-backup.mjs --malId ${a.malId} --eps ${ep} --providers ${p}`,
          { encoding: "utf8", timeout: 420_000, cwd: "/home/z/my-project" },
        );
        const lines = out.trim().split("\n");
        const verdictLine = lines.find((l) => / (REAL|FAKE) \(/.test(l));
        const last = lines.filter((l) => l.includes(`${ep}-${p}`)).pop() ?? "no-output";
        console.log(`  ${server} ep${ep}: ${last.slice(0, 110)}`);
        if (verdictLine) { written++; verifiedPairs.add(`${a.malId}:${ep}:${server}`); }
        else skipped++;
        log({ at: new Date().toISOString(), malId: a.malId, title, provider: p, ep, status: verdictLine ? "verdict" : "inconclusive", detail: last.slice(0, 140) });
      } catch (e) {
        console.log(`  ${server} ep${ep}: ERR ${String(e.message).slice(0, 90)}`);
        log({ at: new Date().toISOString(), malId: a.malId, title, provider: p, ep, status: "error", detail: String(e.message).slice(0, 140) });
      }
      await new Promise((r) => setTimeout(r, 10_000)); // politeness between probes
    }
  }
  await new Promise((r) => setTimeout(r, 4_000)); // politeness between anime
}
console.log(`pass done: probes=${probes} verdicts=${written} inconclusive=${skipped}`);
await db.$disconnect();
process.exit(0);
