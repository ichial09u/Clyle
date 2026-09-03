/**
 * DUB HUNT — the missing-dub campaign.
 *
 * "find all animes that doesn't have dub in yet that does include dub audio
 * like jjk season 2 it doesn't have all of dub so do that for both of the
 * new players for dub only"
 *
 * For every in-catalog anime whose dub verdicts are all false (Zoko/Kiwi/
 * flikhub) or whose dub is missing entirely:
 *
 *   1. MAP:   search AniKoto for the title; on a confident slug match store
 *             Anime.anikotoSeriesId — that unlocks the megaplay-embed dub
 *             backfill (megaplay.buzz getSources), which carries dubs
 *             flikhub's malId-keyed API misses (the JJK S2 case).
 *   2. PROBE: dub at ep 1 on the embed network (real-segment verification).
 *             A positive probe records DubProbe (chain s2, provider
 *             megaplay-embed) and re-opens the closed dub boundaries so the
 *             per-episode search can advance. A negative probe falls back
 *             to a FRESH flikhub megaplay check (its 1000 false verdicts
 *             predate the campaign) before giving up.
 *   3. SETTLE: when ep1 is real, probe the LAST episode too — if that's real
 *             as well the whole show is dubbed (thru = total immediately,
 *             no binary search needed). Partial dubs (JJK S2 style) settle
 *             via the fleet bots + episode visits later.
 *
 * Resumable: animes already mapped/probed this run are skipped, so the
 * script can be re-run after interruption. Results append to
 * scripts/dub-hunt-report.jsonl.
 *
 *   node scripts/dub-hunt.mjs [--limit 99999] [--concurrency 5] [--minutes 45]
 */
import { appendFile, readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT = parseInt(opt("limit", "99999"), 10);
const CONC = Math.max(1, parseInt(opt("concurrency", "5"), 10) || 5);
const MINUTES = parseInt(opt("minutes", "45"), 10);
const DEADLINE = Date.now() + MINUTES * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { mapped: 0, mappedReal: 0, settled: 0, partial: 0, flikhubFlip: 0, noMap: 0, noDub: 0, errors: 0 };

async function report(row) {
  console.log(JSON.stringify(row));
  try {
    await appendFile(new URL("./dub-hunt-report.jsonl", import.meta.url), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  } catch { /* logging never blocks */ }
}

/** resume support: malIds already given a definitive verdict this campaign */
async function loadProcessed() {
  try {
    const raw = await readFile(new URL("./dub-hunt-report.jsonl", import.meta.url), "utf8");
    const done = new Set();
    for (const line of raw.split("\n")) {
      try {
        const r = JSON.parse(line);
        // "flikhub-transient" = mapped but never got a definitive dub
        // verdict — retry those on the next pass instead of skipping
        if (r.malId && r.status && r.status !== "flikhub-transient") done.add(r.malId);
      } catch { /* skip partial lines */ }
    }
    return done;
  } catch {
    return new Set();
  }
}

/* ---- inline source probes (mirror src/lib, standalone) ------------------ */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const { execFile } = await import("node:child_process");

function curl(url, referer) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", `Referer: ${referer}`, "-H", "Accept-Language: en-US,en;q=0.9", url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
  });
}

function norm(t) {
  return String(t || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

async function anikotoSearch(title) {
  const q = norm(title).replace(/ /g, "+");
  if (!q) return [];
  try {
    const html = await curl(`https://anikototv.to/filter?keyword=${q}`, "https://anikototv.to/");
    const out = [];
    const seen = new Set();
    const re = /data-tip="(\d+)"[^>]*>\s*<a href="[^"]*\/watch\/([a-zA-Z0-9-]+?)\/ep-\d+/g;
    let m;
    while ((m = re.exec(html))) {
      const id = parseInt(m[1], 10);
      if (Number.isFinite(id) && !seen.has(id)) { seen.add(id); out.push({ id, slug: m[2] }); }
    }
    return out;
  } catch {
    return [];
  }
}

function slugTitle(slug) {
  return norm(String(slug || "").replace(/-[a-z0-9]{5}$/i, ""));
}

function pickHit(hits, titles) {
  const wants = titles.map(norm).filter(Boolean);
  let best = null;
  for (const hit of hits) {
    const st = slugTitle(hit.slug);
    for (const want of wants) {
      if (!st || !want) continue;
      let score = 0;
      if (st === want) score = 100;
      else if (st.startsWith(want) || want.startsWith(st)) {
        const ratio = Math.min(want.length, st.length) / Math.max(want.length, st.length);
        score = 60 + Math.round(ratio * 35);
      }
      if (score >= 75 && (!best || score > best.score)) best = { hit, score };
    }
  }
  return best?.hit ?? null;
}

async function anikotoEps(seriesId) {
  const body = await curl(`https://anikotoapi.site/series/${seriesId}`, "https://anikototv.to/");
  const j = JSON.parse(body);
  if (!j || j.ok !== true || !j.data) throw new Error("anikotoapi invalid");
  return (j.data.episodes ?? [])
    .map((e) => ({ number: Number(e.number ?? e.episode ?? 0), embedId: e.episode_embed_id != null ? Number(e.episode_embed_id) || null : null }))
    .filter((e) => e.number > 0);
}

/** real-dub verdict for one embed id: null transient / false stub / true real.
 * getSources intermittently answers empty for a beat — a single "no file" is
 * NOT proof; require two agreeing attempts before a definitive miss. */
async function embedDubVerdict(embedId) {
  let file = null;
  for (let round = 0; round < 2; round++) {
    let res;
    try {
      res = await curl(`https://megaplay.buzz/stream/getSources?id=${embedId}&type=dub`, "https://megaplay.buzz/");
    } catch {
      return null;
    }
    let json;
    try {
      json = JSON.parse(res);
    } catch {
      return null;
    }
    const f = json?.sources?.file;
    if (f) { file = f; break; }
    if (round === 0) await sleep(1500);
    else return false; // two clean "no file" answers
  }
  try {
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
    const mres = await fetch(file, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return null;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return false;
    const vres = await fetch(new URL(variant.trim(), file).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return null;
    const vtext = await vres.text();
    const real = vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
    return real >= 3;
  } catch {
    return null;
  }
}

/** fresh flikhub megaplay verdict (same as src/lib/megaplay.ts) */
async function flikhubVerdict(malId, ep) {
  try {
    const res = await fetch(`https://api.flikhub.net/megaplay?mal=${malId}&ep=${ep}&type=dub`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null; // 404 = unmapped, but a retry later may map it
    const json = await res.json();
    if (!json.m3u8) return false;
    const headers = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
    const mres = await fetch(json.m3u8, { headers, signal: AbortSignal.timeout(12000) });
    if (!mres.ok) return null;
    const master = await mres.text();
    const variant = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return false;
    const vres = await fetch(new URL(variant.trim(), json.m3u8).href, { headers, signal: AbortSignal.timeout(12000) });
    if (!vres.ok) return null;
    const vtext = await vres.text();
    const real = vtext.split("\n").filter((l) => {
      const s = l.trim();
      return s && !s.startsWith("#") && /seg-\d+-/.test(s) && !/tiktokcdn\.com/.test(s);
    }).length;
    return real >= 3;
  } catch {
    return null;
  }
}

/* ---- per-anime pipeline -------------------------------------------------- */

async function huntAnime(a) {
  const titles = [a.titleEnglish, a.title].filter(Boolean);
  // 1. MAP via AniKoto
  let seriesId = a.anikotoSeriesId ?? null;
  if (!seriesId) {
    const hits = await anikotoSearch(a.titleEnglish || a.title);
    const hit = pickHit(hits, titles);
    if (!hit) {
      stats.noMap++;
      await report({ malId: a.malId, title: a.title, status: "no-map" });
      return;
    }
    seriesId = hit.id;
    await db.anime.update({ where: { malId: a.malId }, data: { anikotoSeriesId: seriesId } }).catch(() => undefined);
    stats.mapped++;
  }

  // 2. PROBE ep 1 on the embed network
  let eps;
  try {
    eps = await anikotoEps(seriesId);
  } catch (e) {
    stats.errors++;
    await report({ malId: a.malId, title: a.title, seriesId, status: "eps-error", detail: String(e).slice(0, 80) });
    return;
  }
  const ep1 = eps.find((e) => e.number === 1)?.embedId ?? null;
  if (!ep1) {
    stats.noDub++;
    await report({ malId: a.malId, title: a.title, seriesId, status: "no-ep1-embed" });
    return;
  }
  const v1 = await embedDubVerdict(ep1);
  if (v1 === null) {
    stats.errors++;
    await report({ malId: a.malId, title: a.title, seriesId, status: "probe-transient" });
    return;
  }
  if (v1 === false) {
    // 2b. fallback: fresh flikhub check — its old false verdicts may be stale
    const fv = await flikhubVerdict(a.malId, 1);
    if (fv === true) {
      stats.flikhubFlip++;
      await db.dubProbe.upsert({
        where: { malId_ep_chain: { malId: a.malId, ep: 1, chain: "s2" } },
        create: { malId: a.malId, ep: 1, chain: "s2", ok: true, provider: "yenime", detail: "dub-hunt: fresh flikhub hit" },
        update: { ok: true, provider: "yenime", detail: "dub-hunt: fresh flikhub hit" },
      }).catch(() => undefined);
      await reOpen(a.malId);
      await report({ malId: a.malId, title: a.title, seriesId, status: "flikhub-has-dub" });
      return;
    }
    stats.noDub++;
    await report({ malId: a.malId, title: a.title, seriesId, status: fv === false ? "no-dub" : "flikhub-transient" });
    return;
  }

  // 3. REAL DUB at ep1 — record + re-open boundaries
  stats.mappedReal++;
  await db.dubProbe.upsert({
    where: { malId_ep_chain: { malId: a.malId, ep: 1, chain: "s2" } },
    create: { malId: a.malId, ep: 1, chain: "s2", ok: true, provider: "megaplay-embed", detail: `dub-hunt: anikoto series ${seriesId}` },
    update: { ok: true, provider: "megaplay-embed", detail: `dub-hunt: anikoto series ${seriesId}` },
  }).catch(() => undefined);
  await reOpen(a.malId);
  await report({ malId: a.malId, title: a.title, seriesId, status: "HAS-DUB", ep1: "real" });

  // 4. SETTLE: probe the last episode too — real there => fully dubbed.
  // Probe MAL's total (anikoto may list extras/specials MAL doesn't count).
  const malTotal = a.totalEpisodes ?? 0;
  const lastEp = malTotal > 1 ? malTotal : eps.length ? Math.max(...eps.map((e) => e.number)) : 0;
  if (lastEp > 1) {
    const last = eps.find((e) => e.number === lastEp)?.embedId ?? null;
    if (last) {
      const vLast = await embedDubVerdict(last);
      if (vLast === true) {
        await db.dubProbe.upsert({
          where: { malId_ep_chain: { malId: a.malId, ep: lastEp, chain: "s2" } },
          create: { malId: a.malId, ep: lastEp, chain: "s2", ok: true, provider: "megaplay-embed", detail: "dub-hunt: last-ep settle" },
          update: { ok: true, provider: "megaplay-embed", detail: "dub-hunt: last-ep settle" },
        }).catch(() => undefined);
        // thru advances to lastEp via recordProbe-equivalent fold
        const cur = await db.anime.findUnique({ where: { malId: a.malId }, select: { dubThruS2: true, totalEpisodes: true } });
        const thru = Math.max(cur?.dubThruS2 ?? 0, Math.min(lastEp, cur?.totalEpisodes ?? lastEp));
        await db.anime.update({ where: { malId: a.malId }, data: { dubThruS2: thru, dubThruCheckedAt: new Date() } }).catch(() => undefined);
        stats.settled++;
        await report({ malId: a.malId, title: a.title, seriesId, status: "SETTLED-FULL", thruS2: thru });
      } else if (vLast === false) {
        // partial dub (JJK S2 style) — record the miss so binary search bounds it
        await db.dubProbe.upsert({
          where: { malId_ep_chain: { malId: a.malId, ep: lastEp, chain: "s2" } },
          create: { malId: a.malId, ep: lastEp, chain: "s2", ok: false, detail: "dub-hunt: last-ep miss" },
          update: { ok: false, detail: "dub-hunt: last-ep miss" },
        }).catch(() => undefined);
        const cur = await db.anime.findUnique({ where: { malId: a.malId }, select: { dubHiS2: true, dubThruS2: true } });
        const hi = Math.min(cur?.dubHiS2 ?? lastEp, lastEp);
        // never LOWER an already-proven thru (ep1 is proven real by this path)
        const thru = Math.max(cur?.dubThruS2 ?? 0, 1);
        await db.anime.update({ where: { malId: a.malId }, data: { dubHiS2: hi, dubThruS2: thru, dubThruCheckedAt: new Date() } }).catch(() => undefined);
        stats.partial++;
        await report({ malId: a.malId, title: a.title, seriesId, status: "PARTIAL", hiS2: hi, thruS2: thru });
      }
    }
  }
}

/** re-open closed boundaries so the per-episode search runs again */
async function reOpen(malId) {
  const a = await db.anime.findUnique({
    where: { malId },
    select: { dubThruS1: true, dubThruS2: true, dubThruCheckedAt: true },
  });
  if (!a) return;
  const data = {};
  if (a.dubThruS1 === 0) data.dubThruS1 = null;
  if (a.dubThruS2 === 0) data.dubThruS2 = null;
  data.dubThruCheckedAt = null; // force the search to re-run on next visit
  await db.anime.update({ where: { malId }, data }).catch(() => undefined);
}

/* ---- main ---------------------------------------------------------------- */

async function main() {
  const processed = await loadProcessed();
  const all = await db.anime.findMany({
    where: {
      inCatalog: true,
      hasDub: false,
      hasDubKiwi: false,
      OR: [{ hasDubMega: false }, { hasDubMega: null }],
    },
    select: {
      malId: true, title: true, titleEnglish: true, totalEpisodes: true, type: true,
      anikotoSeriesId: true, dubThruS1: true, dubThruS2: true,
    },
    orderBy: [{ popularity: "asc" }, { malId: "asc" }],
    take: LIMIT,
  });
  const batch = all.filter((a) => !processed.has(a.malId));
  console.log(`dub-hunt: ${batch.length} candidates (${all.length - batch.length} already processed this campaign), concurrency ${CONC}, ${MINUTES} min budget`);
  let idx = 0;
  let active = 0;
  await new Promise((resolveAll) => {
    const done = () => {
      active--;
      if ((idx >= batch.length && active === 0) || Date.now() > DEADLINE) resolveAll();
      else pump();
    };
    const pump = () => {
      while (active < CONC && idx < batch.length && Date.now() <= DEADLINE) {
        const a = batch[idx++];
        active++;
        huntAnime(a)
          .catch(async (err) => {
            stats.errors++;
            await report({ malId: a.malId, title: a.title, status: "error", detail: String(err).slice(0, 120) });
          })
          .finally(done);
        // tiny stagger keeps anikotoapi/megaplay happy
        void sleep(150);
      }
      if (idx >= batch.length && active === 0) resolveAll();
      if (Date.now() > DEADLINE && active === 0) resolveAll();
    };
    pump();
  });
  console.log("DONE", JSON.stringify(stats));
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error("fatal", e);
  process.exit(1);
});
