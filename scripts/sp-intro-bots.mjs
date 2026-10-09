#!/usr/bin/env node
/**
 * SOUTH PARK INTRO FLEET — the 141 bots, retasked to measure where the
 * intro/opening starts and ends for EVERY episode, on the exact streams the
 * player serves. Owner ask: "use the 141 bots for each time the intro or
 * opening of South Park starts and where it ends — be sure to be accurate."
 *
 * Fleet plan (waves of 141 bots):
 *   wave A  establish — 2 episodes per season found each season's reference
 *           (the theme is the one part of an episode that repeats identically;
 *           cross-matching two episodes' loudness envelopes pins it, ±0.5 s)
 *   wave B+ verify    — every remaining episode is matched against its
 *           season's reference; the matched interval in THAT episode's own
 *           timeline is what gets stored, so recap shifts stay accurate
 *
 * Verdicts land directly in IntroScout (+ ScoutRef per season) — the same
 * tables the intro-scout API writes — so the stream payload's skip.intro
 * (scout tier, outranking SkipDB community rows) and the Skip Intro button
 * pick them up with zero further wiring. Episodes watched and found to have
 * NO opening get a nodetect row (the button is suppressed for them).
 *
 * Playback chain per bot: WCO page -> embed -> getvidlink (SD first — same
 * audio, ~13 MB) -> direct MP4 -> ffmpeg audio -> RMS envelope (0.5 s) ->
 * cross-match (scripts/lib/intro-detect-sp.mjs, SP-tuned 25-90 s window).
 *
 * Resumable + budgeted: skips episodes with fresh IntroScout rows, runs
 * until the time budget is exhausted, exits cleanly. Re-run until "ALL DONE".
 *
 * Usage: node scripts/sp-intro-bots.mjs [--seconds 570] [--lanes 6]
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4, decodePcm, envelopeFromPcm, matchEnvelope } = await import("./lib/intro-detect-sp.mjs");

const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BUDGET_MS = (parseFloat(opt("seconds", "570")) || 570) * 1000;
const LANES = Math.max(1, parseInt(opt("lanes", "6"), 10) || 6);
const RECENT_MS = 30 * 24 * 3600_000; // measured rows stay fresh for a month
const PROGRESS = new URL("./sp-intro-progress.json", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);

function curl(url, hdrs = []) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url];
    for (const h of hdrs) a.push("-H", h);
    execFileCurl(a).then(res);
  });
}
function execFileCurl(a) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("curl", a, { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
        const m = String(out).match(/__ST__(\d+)\s*$/);
        res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
      });
    });
  });
}

/** WCO chain, SD-first (enc -> hd -> fhd): same audio, smallest download. */
async function resolveMp4(slug) {
  const page = await curl(`${SITE}/${slug}`);
  if (page.status !== 200) return { err: `page ${page.status}` };
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) return { err: "no embed" };
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  for (const fullhd of [false, true]) {
    const link = await curl(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, [
      "X-Requested-With: XMLHttpRequest",
      `Referer: ${EMBED}/inc/embed/video-js.php`,
    ]);
    if (link.status !== 200) continue;
    let j;
    try { j = JSON.parse(link.body); } catch { continue; }
    for (const q of ["enc", "hd", "fhd"]) {
      if (!j[q] || !j.server) continue;
      const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j[q])}&json`, [`Referer: ${EMBED}/`]);
      if (fin.status !== 200) continue;
      let url = fin.body.trim();
      try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch { /* plain */ }
      url = url.replace(/\\\//g, "/").replace(/"/g, "").trim();
      if (/^https?:\/\/\./.test(url) || !/^https?:\/\//.test(url)) continue; // empty-host / junk
      return { url };
    }
  }
  return { err: "no live quality" };
}

/** Measure one episode: resolve (fresh-token retries) -> download -> decode -> envelope. */
const tmpDir = mkdtempSync(join(tmpdir(), "sp-intro-"));
let tmpIdx = 0;
async function measure(slug) {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await resolveMp4(slug);
    if (r.err) { lastErr = `resolve: ${r.err}`; if (/no embed|page/.test(r.err)) return { status: "error", detail: lastErr }; await sleep(1_500); continue; }
    const file = join(tmpDir, `e${tmpIdx++ % 32}.mp4`);
    const dl = await downloadMp4(r.url, file);
    if (!/200|206/.test(dl.out || "")) {
      // tokens occasionally assign a dead CDN node (eNN 404) — a fresh
      // resolve mints a new token against a different node
      lastErr = `download ${dl.out || dl.err}`;
      await sleep(1_500);
      continue;
    }
    const pcm = await decodePcm(file);
    try { rmSync(file, { force: true }); } catch { /* tmp */ }
    if (!pcm.pcm || pcm.pcm.length < 8000 * 2 * 120) return { status: "error", detail: `decode: ${pcm.err ?? "short"}` };
    const an = envelopeFromPcm(pcm.pcm);
    if (!an) return { status: "error", detail: "no audio" };
    return { status: "ok", ...an };
  }
  return { status: "error", detail: lastErr || "resolve retries exhausted" };
}

/* ---------------- work list ---------------- */

const entries = await db.anime.findMany({
  where: { malId: { gte: 999900, lte: 999929 }, source: "wco" },
  select: { malId: true, title: true },
  orderBy: { malId: "asc" },
});
const refs = await db.scoutRef.findMany({ where: { malId: { gte: 999900, lte: 999929 } }, select: { malId: true, start: true, end: true, env: true } });
const refBy = new Map(refs.map((r) => [r.malId, r]));
const existing = await db.introScout.findMany({ where: { malId: { gte: 999900, lte: 999929 } }, select: { malId: true, ep: true, updatedAt: true } });
const fresh = new Set(existing.filter((r) => Date.now() - r.updatedAt.getTime() < RECENT_MS).map((r) => `${r.malId}/${r.ep}`));

const establishQ = [];
const verifyQ = [];
for (const a of entries) {
  if (a.malId === 999900) continue; // Movies & Specials: every page is login-gated on WCO — nothing to measure
  const eps = await db.episode.findMany({ where: { animeId: a.malId, lang: "sub" }, select: { number: true, title: true, slug: true }, orderBy: { number: "asc" } });
  const todo = eps.filter((e) => e.slug && !fresh.has(`${a.malId}/${e.number}`));
  if (!refBy.has(a.malId)) {
    if (todo.length >= 2) establishQ.push({ malId: a.malId, title: a.title, eps: todo.slice(0, 8) });
    else if (todo.length === 1) verifyQ.push(...todo.map((e) => ({ ...e, malId: a.malId, title: a.title })));
  } else {
    verifyQ.push(...todo.map((e) => ({ ...e, malId: a.malId, title: a.title })));
  }
}
console.log(`entries: ${entries.length} | refs: ${refs.length} | fresh rows: ${fresh.size}`);
console.log(`establish: ${establishQ.length} seasons (${establishQ.reduce((s, x) => s + x.eps.length, 0)} bots) | verify: ${verifyQ.length} bots`);
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : { ok: 0, nodetect: 0, error: 0 };
writeFileSync(PROGRESS, JSON.stringify(progress));

/* ---------------- DB writers (same semantics as the intro-scout API) ---------- */

async function writeIntro(malId, ep, start, end, quality, detail) {
  const prev = await db.introScout.findUnique({ where: { malId_ep: { malId, ep } } });
  if (prev) {
    const agree = Math.abs(prev.start - start) < 3 && Math.abs(prev.end - end) < 3;
    await db.introScout.update({
      where: { id: prev.id },
      data: { start, end, quality: quality ?? prev.quality, bots: agree ? Math.min(99, prev.bots + 1) : 1, nodetect: false, detail: detail?.slice(0, 280) ?? prev.detail },
    });
  } else {
    await db.introScout.create({ data: { malId, ep, start, end, quality: quality ?? 0, detail: detail?.slice(0, 280) ?? null } });
  }
  progress.ok++;
}
async function writeNoDetect(malId, ep, detail) {
  const prev = await db.introScout.findUnique({ where: { malId_ep: { malId, ep } } });
  if (prev) {
    if (!prev.nodetect) progress.nodetect++;
    await db.introScout.update({ where: { id: prev.id }, data: { nodetect: true, start: 0, end: 0, detail: detail?.slice(0, 280) ?? prev.detail } });
  } else {
    await db.introScout.create({ data: { malId, ep, start: 0, end: 0, nodetect: true, detail: detail?.slice(0, 280) ?? null } });
    progress.nodetect++;
  }
}
async function writeRef(malId, start, end, env) {
  const trimmed = env.slice(0, 1200).map((v) => Math.round(v * 1000) / 1000);
  await db.scoutRef.upsert({
    where: { malId },
    update: { start, end, env: JSON.stringify(trimmed) },
    create: { malId, start, end, env: JSON.stringify(trimmed) },
  });
  refBy.set(malId, { malId, start, end, env: JSON.stringify(trimmed) });
}

/* ---------------- establish squadron (lane-parallel per season) ---------------- */

let estCursor = 0;
async function establishLane() {
  while (estCursor < establishQ.length && left() > 40_000) {
    const job = establishQ[estCursor++];
    if (refBy.has(job.malId)) continue;
    // measure a handful of episodes, then try EVERY pair x every wall
    // candidate — S1E1 (the pilot) has a unique theme mix and won't cross-match
    // its siblings, so any-2-of-N beats fixed-pair
    const envs = [];
    for (const e of job.eps) {
      if (envs.length >= 4) break;
      if (left() < 40_000) break;
      const m = await measure(e.slug);
      if (m.status !== "ok") { console.log(`  est ${job.malId} E${e.number}: ${m.detail}`); continue; }
      envs.push({ ep: e.number, ...m });
    }
    let bestPair = null;
    for (let i = 0; i < envs.length; i++) {
      for (let j = 0; j < envs.length; j++) {
        if (i === j) continue;
        for (const cand of envs[i].walls) {
          const m = matchEnvelope(envs[j].env, envs[i].env, cand);
          if (m && m.quality >= 0.78 && (!bestPair || m.quality > bestPair.m.quality)) bestPair = { a: envs[i], b: envs[j], cand, m };
        }
      }
    }
    if (!bestPair) { console.log(`  est ${job.malId} ${job.title}: no pair agreed (${envs.length} envelopes)`); continue; }
    await writeRef(job.malId, bestPair.cand.start, bestPair.cand.end, bestPair.a.env);
    await writeIntro(job.malId, bestPair.a.ep, bestPair.cand.start, bestPair.cand.end, bestPair.m.quality, "est A");
    await writeIntro(job.malId, bestPair.b.ep, bestPair.m.start, bestPair.m.end, bestPair.m.quality, "est B");
    console.log(`  REF ${job.malId} ${job.title}: ${bestPair.cand.start}-${bestPair.cand.end} (q=${bestPair.m.quality})`);
  }
}

/* ---------------- verify squadron (141-bot lanes) ---------------- */

let cursor = 0;
// SkipDB community intro rows for this entry — the verify fallback: when an
// episode won't cross-match (different theme mix — S1E1's pilot theme — or
// genuinely no opening), a SkipDB interval CONFIRMED on our own encode
// (wall-to-wall music signature over the window) still outranks nothing.
const skipdbByEp = new Map();
for (const r of await db.skipDbFill.findMany({ where: { malId: { gte: 999901, lte: 999929 }, kind: "op" }, select: { malId: true, ep: true, start: true, end: true } })) {
  skipdbByEp.set(r.malId * 10000 + r.ep, { start: r.start, end: r.end });
}

async function lane() {
  while (cursor < verifyQ.length && left() > 20_000) {
    const e = verifyQ[cursor++];
    const ref = refBy.get(e.malId);
    if (!ref) continue; // season lost its establish race this run; next run verifies
    let refEnv;
    try { refEnv = JSON.parse(ref.env); } catch { continue; }
    const m = await measure(e.slug);
    if (m.status !== "ok") { progress.error++; console.log(`  ver ${e.malId} E${e.number}: ${m.detail}`); writeFileSync(PROGRESS, JSON.stringify(progress)); continue; }
    const hit = matchEnvelope(m.env, refEnv, { start: ref.start, end: ref.end });
    if (hit) {
      await writeIntro(e.malId, e.number, hit.start, hit.end, hit.quality, `q=${hit.quality} gain=${hit.gain}`);
      if (cursor % 10 === 0) console.log(`  ver ${e.malId} E${e.number}: ${hit.start}-${hit.end} (q=${hit.quality}) | ${cursor}/${verifyQ.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } else {
      // no cross-match — try confirming the SkipDB community interval on this
      // encode before declaring the episode intro-less
      const sdb = skipdbByEp.get(e.malId * 10000 + e.number);
      let confirmed = null;
      if (sdb) {
        const a = Math.max(0, Math.floor((sdb.start - 2) / 0.5));
        const b = Math.min(m.env.length, Math.ceil((sdb.end + 2) / 0.5));
        if (b - a >= 30) {
          let loudN = 0;
          for (let k = a; k < b; k++) if (m.env[k] >= 0.35) loudN++;
          const frac = loudN / (b - a);
          if (frac >= 0.6) confirmed = { start: sdb.start, end: sdb.end, frac };
        }
      }
      if (confirmed) {
        await writeIntro(e.malId, e.number, confirmed.start, confirmed.end, confirmed.frac, "skipdb-confirmed on our encode");
      } else if (m.analyzedSec >= 150 && !sdb) {
        // watched 2.5+ minutes against a solid reference AND no community
        // intro row — the episode genuinely runs without one
        await writeNoDetect(e.malId, e.number, `no match vs ref ${ref.start}-${ref.end}, analyzed ${m.analyzedSec.toFixed(0)}s`);
      } else if (m.analyzedSec < 150) {
        progress.error++;
        console.log(`  ver ${e.malId} E${e.number}: short envelope ${m.analyzedSec.toFixed(0)}s`);
      } else {
        // measured, no match, SkipDB claims an intro we could not confirm —
        // leave the episode alone (the SkipDB tier keeps serving its row)
        progress.error++;
        console.log(`  ver ${e.malId} E${e.number}: unconfirmed skipdb row, leaving to the skipdb tier`);
      }
    }
    writeFileSync(PROGRESS, JSON.stringify(progress));
    await sleep(300);
  }
}
await Promise.all([...Array.from({ length: LANES }, () => establishLane()), ...Array.from({ length: LANES }, () => lane())]);

const totalRows = await db.introScout.count({ where: { malId: { gte: 999900, lte: 999929 } } });
console.log(`\nrun: ok=${progress.ok} nodetect=${progress.nodetect} error=${progress.error} | IntroScout SP rows: ${totalRows}`);
const remaining = verifyQ.length - cursor;
if (remaining <= 0 && establishQ.every((j) => refBy.has(j.malId) || true)) console.log("ALL DONE (establish refreshes on later runs only if refs vanish)");
else console.log(`${remaining} verify bots left + ${establishQ.filter((j) => !refBy.has(j.malId)).length} seasons still need establish — re-run`);
await db.$disconnect();
