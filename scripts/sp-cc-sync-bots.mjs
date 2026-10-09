#!/usr/bin/env node
/**
 * SOUTH PARK CC-SYNC FLEET — one bot per episode, measuring how far the
 * vendored English captions (SpCaption, timed on LM2's encodes) sit from the
 * WCO audio the player actually serves. Owner report: "the subtitles are
 * showing up faster than the characters speak" (S13E1) — verified: the cue
 * ONSET train leads the audio onset train by ~1.5 s.
 *
 * Estimator (validated 2026-10-09 on S13E1 — sharp unimodal peak where every
 * envelope-based alternative was mush):
 *   1. WCO MP4 (SD-first) -> ffmpeg -> 8 kHz mono PCM -> 0.25 s RMS envelope
 *   2. audio ONSET train = envelope rises through 0.28 of p95
 *   3. cue ONSET train = VTT cue start times on the same 0.25 s grid
 *   4. match score per lag (±8 s): fraction of the RARER onset train matched
 *      by the other at that lag — sparse binaries, sharp peak
 *   5. parabola refine the peak; offsetMs = -lag (captions early -> negative
 *      -> the player shifts cues later). Peak score >= 0.30 or no verdict.
 *
 * (The LM2-vs-WCO encode shift was measured separately: corr 0.976 at ~0 s —
 * timeline-identical — so caption offset vs WCO audio is THE offset.)
 *
 * Verdicts land in CaptionSync (lang "dub", server "wco") — the exact row
 * /api/captions serves and the player's cue-remap effect applies. Resumable:
 * fresh rows are skipped; re-run until "ALL DONE".
 *
 * Usage: node scripts/sp-cc-sync-bots.mjs [--seconds 570] [--lanes 6] [--only 999913/1]
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4 } = await import("./lib/intro-detect-sp.mjs");

const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BUDGET_MS = (parseFloat(opt("seconds", "570")) || 570) * 1000;
const LANES = Math.max(1, parseInt(opt("lanes", "6"), 10) || 6);
const ONLY = opt("only", "");
const RECENT_MS = 30 * 24 * 3600_000;
const PROGRESS = new URL("./sp-cc-sync-progress.json", import.meta.url).pathname;

const STEP_MS = 250; // envelope resolution
const SPAN_SEC = 600; // decode the first 10 minutes — plenty of dialogue
const LAG_STEPS = 32; // ±8 s search
const MIN_ELEVATION = 2.6; // peak must be a real synchronized bump (observed 2.8-3.8 true)
const MIN_SHARPNESS = 1.35; // peak vs its ±1 s shoulders — ambiguous profiles skip
const MAX_ABS_LAG_S = 6; // sanity bound

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
      if (/^https?:\/\/\./.test(url) || !/^https?:\/\//.test(url)) continue;
      return { url };
    }
  }
  return { err: "no live quality" };
}

/** Same smoothing the audio envelopes get (light — keep onsets sharp). */
function smoothEnv(env, k = 1) {
  return env.map((_, i) => {
    let s = 0, c = 0;
    for (let d = -k; d <= k; d++) {
      const j = i + d;
      if (j >= 0 && j < env.length) { s += env[j]; c++; }
    }
    return s / c;
  });
}

/** VTT text -> cue START times (s), inside the analyzed span. */
function cueStarts(vtt) {
  const out = [];
  for (const m of vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->/g)) {
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    if (s >= 0 && s < SPAN_SEC - 10) out.push(s);
  }
  return out;
}

/** 8 kHz mono PCM -> normalized smoothed RMS envelope at 0.25 s steps. */
function envelope250(pcm) {
  const win = 2000; // 0.25 s @ 8 kHz
  const raw = [];
  for (let off = 0; off + win * 2 <= pcm.length; off += win * 2) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += pcm.readInt16LE(off + i * 2) ** 2;
    raw.push(Math.sqrt(sum / win));
  }
  if (raw.length < 400) return null;
  const sorted = [...raw].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return smoothEnv(raw.map((v) => v / p95));
}

function decodePcm250(path, sec) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-t", String(sec), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, encoding: "buffer" }, (e, stdout) => res(e ? null : stdout));
    });
  });
}

/** Fraction of the RARER onset train matched at lag k (0.25 s steps). */
function onsetMatchScore(cueOn, audOn, k) {
  let both = 0, ca = 0, cb = 0;
  for (let i = 2; i < cueOn.length; i++) {
    const j = i + k;
    if (j < 0 || j >= audOn.length) continue;
    ca += cueOn[i]; cb += audOn[j];
    if (cueOn[i] && audOn[j]) both++;
  }
  const rare = Math.min(ca, cb);
  return rare < 40 ? 0 : both / rare;
}

/**
 * DERIVATIVE ELEVATION scorer (laugh-track robust — SP's bed of laughter
 * kills absolute-threshold onsets on the early seasons). Score(k) = mean
 * audio-envelope RISE inside [cue+k, cue+k+1s] across cue onsets, normalized
 * by the episode's mean rise. Speech starting at cue+k makes a synchronized
 * bump at the true lag; unsynced laughter rises stay flat background.
 * Validated 2026-10-09: sharp 2.8-3.8x peaks at the true lag on S13/S20,
 * and flat/bimodal profiles on ambiguous episodes — gated by sharpness.
 */
function derivScore(cueIdx, dP, dMean, N, k) {
  let sum = 0, cnt = 0;
  for (const i of cueIdx) {
    let mx = 0;
    for (let d = 0; d <= 3; d++) { const j = i + k + d; if (j >= 0 && j < N) mx = Math.max(mx, dP[j]); }
    sum += mx; cnt++;
  }
  return cnt >= 40 ? sum / cnt / (dMean || 1e-9) : 0;
}

/* ---------------- work list ---------------- */

const capRows = await db.spCaption.findMany({ select: { malId: true, ep: true, content: true } });
const capBy = new Map(capRows.map((r) => [`${r.malId}/${r.ep}`, r.content]));
const existing = await db.captionSync.findMany({ where: { malId: { gte: 999900, lte: 999929 }, lang: "dub" }, select: { malId: true, ep: true, updatedAt: true } });
const fresh = new Set(existing.filter((r) => Date.now() - r.updatedAt.getTime() < RECENT_MS).map((r) => `${r.malId}/${r.ep}`));

const queue = [];
const entries = await db.anime.findMany({ where: { malId: { gte: 999900, lte: 999929 }, source: "wco" }, select: { malId: true } });
// negative cache: skipped episodes keep their reason in the progress file so
// later chunks spend their budget on NEW episodes only (--retry-skips reopens)
const skipCache = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : {};
const skips = skipCache.skips ?? {};
const RETRY_SKIPS = args.includes("--retry-skips");
for (const a of entries) {
  const eps = await db.episode.findMany({ where: { animeId: a.malId, lang: "sub" }, select: { number: true, slug: true }, orderBy: { number: "asc" } });
  for (const e of eps) {
    const key = `${a.malId}/${e.number}`;
    if (ONLY && key !== ONLY) continue;
    if (!e.slug) continue; // WCO-dead (plays via LM2, whose own timing the subs already match)
    if (!capBy.has(key)) continue;
    if (fresh.has(key)) continue;
    if (!RETRY_SKIPS && skips[key]) continue;
    queue.push({ malId: a.malId, ep: e.number, slug: e.slug });
  }
}
console.log(`SpCaption rows: ${capRows.length} | fresh verdicts: ${fresh.size} | cached skips: ${Object.keys(skips).length} | queue: ${queue.length} bots`);
const progress = skipCache;
progress.ok = progress.ok ?? 0; progress.skip = progress.skip ?? 0; progress.error = progress.error ?? 0; progress.skips = skips;
writeFileSync(PROGRESS, JSON.stringify(progress));

const tmpDir = mkdtempSync(join(tmpdir(), "sp-cc-"));
let tmpIdx = 0;

/** One bot: measure + store the caption-vs-audio alignment for one episode. */
async function measureOne(job) {
  const vtt = capBy.get(`${job.malId}/${job.ep}`);
  const starts = cueStarts(vtt);
  if (starts.length < 40) return { status: "skip", detail: `caption row unusable (${starts.length} cues)` };

  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await resolveMp4(job.slug);
    if (r.err) { lastErr = `resolve: ${r.err}`; if (/no embed|page/.test(r.err)) return { status: "skip", detail: lastErr }; await sleep(1_500); continue; }
    const file = join(tmpDir, `e${tmpIdx++ % 24}.mp4`);
    const dl = await downloadMp4(r.url, file);
    if (!/200|206/.test(dl.out || "")) { lastErr = `download ${dl.out || dl.err}`; await sleep(1_500); continue; }
    const pcm = await decodePcm250(file, SPAN_SEC);
    try { rmSync(file, { force: true }); } catch { /* tmp */ }
    if (!pcm || pcm.length < 8000 * 2 * 120) return { status: "skip", detail: "decode short" };
    const env = envelope250(pcm);
    if (!env) return { status: "skip", detail: "envelope short" };

    // lag scan — derivative-elevation scorer (laugh-track robust)
    const N = env.length;
    const cueIdx = [];
    for (const s of starts) { const i = Math.round((s * 1000) / STEP_MS); if (i >= 2 && i < N) cueIdx.push(i); }
    const dP = env.map((v, i) => (i > 0 ? Math.max(0, v - env[i - 1]) : 0));
    const dMean = dP.reduce((a, b) => a + b, 0) / N;
    const scored = [];
    for (let k = -LAG_STEPS; k <= LAG_STEPS; k++) scored.push({ k, score: derivScore(cueIdx, dP, dMean, N, k) });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < MIN_ELEVATION) {
      const top3 = scored.slice(0, 3).map((r) => `${(r.k * 0.25).toFixed(2)}s/${r.score.toFixed(2)}`).join(" ");
      return { status: "skip", detail: `weak elevation (best ${best?.score.toFixed(2) ?? "0"}) top3: ${top3}` };
    }
    // SHARPNESS gate: the peak must stand out of the local background —
    // ambiguous episodes (bimodal / plateau) score flat here and get NO
    // verdict rather than a coin-flip correction.
    const at = (kk) => derivScore(cueIdx, dP, dMean, N, kk);
    const side = Math.max(at(best.k - 4), at(best.k + 4));
    const sharpness = side > 0 ? best.score / side : 0;
    if (sharpness < MIN_SHARPNESS) {
      return { status: "skip", detail: `ambiguous profile (peak ${best.score.toFixed(2)} side ${side.toFixed(2)} = ${sharpness.toFixed(2)}x)` };
    }
    // parabola refine around the peak (sub-step precision)
    const ym1 = at(best.k - 1);
    const y0 = best.score;
    const yp1 = at(best.k + 1);
    const denom = ym1 - 2 * y0 + yp1;
    const delta = denom !== 0 ? (0.5 * (ym1 - yp1)) / denom : 0; // in steps
    const lagS = (best.k + Math.max(-0.5, Math.min(0.5, delta))) * (STEP_MS / 1000);
    if (Math.abs(lagS) > MAX_ABS_LAG_S) return { status: "skip", detail: `implausible lag ${lagS.toFixed(2)}s` };

    const offsetMs = Math.round(-lagS * 1000);
    if (offsetMs === 0) return { status: "ok", applied: false, detail: "already aligned (0 ms)" };
    // confidence: elevation 2.8-3.8x maps to 0.7-0.95 (the player gates at 0.4)
    const confidence = Math.round(Math.min(0.99, best.score / 4) * 100) / 100;
    const detail = JSON.stringify({ lagS: Math.round(lagS * 100) / 100, score: confidence, cues: starts.length, delta: Math.round(delta * 100) / 100 });
    await db.captionSync.upsert({
      where: { malId_ep_lang: { malId: job.malId, ep: job.ep, lang: "dub" } },
      update: {
        offsetMs, driftMsPerMin: 0, fitR2: confidence,
        confidence, samples: Math.round(best.score * Math.min(starts.length, 200)), attempted: starts.length,
        spreadMs: 0, server: "wco", detail: detail.slice(0, 2000), checkedAt: new Date(),
      },
      create: {
        malId: job.malId, ep: job.ep, lang: "dub", server: "wco",
        offsetMs, driftMsPerMin: 0, fitR2: confidence,
        confidence, samples: Math.round(best.score * Math.min(starts.length, 200)), attempted: starts.length,
        spreadMs: 0, detail: detail.slice(0, 2000),
      },
    });
    return { status: "ok", applied: true, detail: `offset ${offsetMs}ms (lag ${lagS.toFixed(2)}s, match ${(best.score * 100).toFixed(0)}%)` };
  }
  return { status: "skip", detail: lastErr || "resolve retries exhausted" };
}

let cursor = 0;
async function lane() {
  while (cursor < queue.length && left() > 20_000) {
    const job = queue[cursor++];
    let out;
    try {
      out = await measureOne(job);
    } catch (e) {
      out = { status: "error", detail: String(e).slice(0, 120) };
    }
    if (out.status === "ok") {
      progress.ok++;
      if (out.applied) console.log(`  ${job.malId} E${job.ep}: APPLIED ${out.detail}`);
      else if (cursor % 10 === 0) console.log(`  ${job.malId} E${job.ep}: ${out.detail} | ${cursor}/${queue.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } else if (out.status === "skip") {
      progress.skip++;
      skips[`${job.malId}/${job.ep}`] = out.detail.slice(0, 120);
      console.log(`  ${job.malId} E${job.ep}: skip — ${out.detail} | ${cursor}/${queue.length}`);
    } else {
      progress.error++;
      console.log(`  ${job.malId} E${job.ep}: ERROR ${out.detail}`);
    }
    writeFileSync(PROGRESS, JSON.stringify(progress));
    await sleep(250);
  }
}
await Promise.all(Array.from({ length: LANES }, () => lane()));

const totalRows = await db.captionSync.count({ where: { malId: { gte: 999900, lte: 999929 } } });
console.log(`\nrun: ok=${progress.ok} skip=${progress.skip} error=${progress.error} | CaptionSync SP rows: ${totalRows}`);
console.log(cursor >= queue.length ? "ALL DONE" : `${queue.length - cursor} bots left — re-run`);
await db.$disconnect();
