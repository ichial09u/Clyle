#!/usr/bin/env node
/**
 * Clyle intro-scout fleet — the 24/7 bot swarm that makes the Skip Intro
 * button accurate.
 *
 * "Copy the bot into 20 more bots that go into animes and see when the skip
 * intro pops up": N lanes (default 20) pull work from the site's backlog and
 * watch real episodes — the same HLS playlists the player serves. Each bot
 * listens to the first minutes of an episode through ffmpeg and reports when
 * the opening starts and ends, with the anime name and episode number:
 *
 *   - establish (2 episodes, no reference yet): both envelopes are matched
 *     against each other; where they align IS the opening. The pair founds
 *     the anime's reference fingerprint (ScoutRef) and two IntroScout rows.
 *   - verify (1 episode, reference exists): the episode's envelope is
 *     matched against the reference — a ~3 s scan pins that episode's
 *     opening exactly, even when recaps shift it.
 *
 * Findings are POSTed to /api/bots/intro-scout and logged locally to
 * scripts/scout-fleet.log (JSONL — one line per report, anime name +
 * episode + interval, the fleet's "we saw it" feed).
 *
 * Usage:
 *   node scripts/intro-scout.mjs --once            # drain one backlog, exit
 *   node scripts/intro-scout.mjs --loop            # 24/7: refetch every 5 min
 *   node scripts/intro-scout.mjs --lanes 8 --once  # fewer bots
 */

import { appendFile, mkdir } from "node:fs/promises";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const args = process.argv.slice(2);
const flag = (name, def = false) => (args.includes(`--${name}`) ? true : def);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PROD = opt("prod", process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app");
const TOKEN = opt("token", process.env.SCOUT_TOKEN || "clyle-scout-v1");
const LANES = Math.max(1, parseInt(opt("lanes", "20"), 10) || 20);
const ONCE = flag("once");
const LOOP = flag("loop");
const MAX_ITEMS = parseInt(opt("max-items", "0"), 10) || 0;
const LOG_FILE = new URL("./scout-fleet.log", import.meta.url).pathname;
// every finding is also mirrored to the local site (its SQLite is committed
// + deployed) — prod serverless instances each hold an ephemeral db copy,
// so the local db is the fleet's durable store
const MIRROR = opt("mirror", process.env.SCOUT_MIRROR || "http://localhost:3000");

const MIN_QUALITY = 0.72; // envelope match gate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queuedFindings = [];
let queuedDubFindings = [];
let flushTimer = null;
const stats = { ok: 0, nodetect: 0, error: 0, refs: 0, dubprobes: 0, scannedSec: 0, started: Date.now() };

function log(...parts) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...parts);
}

async function logFinding(row) {
  try {
    await mkdir(LOG_FILE.slice(0, LOG_FILE.lastIndexOf("/")), { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  } catch { /* logging never blocks the fleet */ }
}

/* ---------------- reporting ---------------- */

function enqueueFinding(f) {
  queuedFindings.push(f);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flush(), 10_000);
}

async function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = queuedFindings;
  const dubBatch = queuedDubFindings;
  queuedFindings = [];
  queuedDubFindings = [];
  if (!batch.length && !dubBatch.length) return;
  const refs = batch.filter((f) => f._ref).map((f) => f._ref);
  const payload = JSON.stringify({
    bot: batch[0]?.bot ?? dubBatch[0]?.bot ?? "scout",
    findings: batch.map(({ _ref, ...f }) => f),
    refs,
    dubFindings: dubBatch,
  });
  // report to prod (what users get NOW) + mirror to the local site (what
  // survives in the committed db and ships with the next deploy) — prod's
  // serverless db is per-instance ephemeral, the local db is the durable store
  const targets = [PROD, MIRROR].filter(Boolean);
  await Promise.allSettled(
    targets.map(async (base) => {
      const res = await fetch(`${base}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) log(`report POST to ${base === PROD ? "prod" : "mirror"} -> ${res.status}`);
    }),
  );
  stats.refs += refs.length;
}

/* ---------------- prod helpers ---------------- */

async function resolveStreamSrc(malId, ep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${PROD}/api/stream?malId=${malId}&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return null; // zoko has no such episode page
      if (!res.ok) throw new Error(`stream ${res.status}`);
      const s = await res.json();
      if (!s?.src) return null;
      return s.src;
    } catch (err) {
      if (attempt === 2) { log(`resolve malId=${malId} ep=${ep} failed: ${String(err).slice(0, 100)}`); return null; }
      await sleep(3_000);
    }
  }
  return null;
}

/* ---------------- detection jobs ---------------- */

/** watch one episode; returns { env, wall, analyzedSec } or null */
async function watchEpisode(bot, malId, ep, title, maxSec, minSec = 0) {
  const src = await resolveStreamSrc(malId, ep);
  if (!src) return null;
  const r = await analyzePlaylist(src, { log: () => {}, maxSec, minSec });
  if (r.status !== "ok") throw new Error(r.detail || "analyze failed");
  stats.scannedSec += r.analyzedSec;
  return r;
}

function refFromEnv(env, interval) {
  const from = Math.max(0, Math.floor(interval.start / 0.5) - 90);
  const to = Math.min(env.length, Math.ceil(interval.end / 0.5) + 40);
  if (to - from < 100) return null; // too small to be a usable fingerprint
  return {
    env: env.slice(from, to),
    // interval relative to the snippet, in seconds
    int: { start: interval.start - from * 0.5, end: interval.end - from * 0.5 },
  };
}

/**
 * Loudest contiguous ~70 s span in the envelope — a much better OP proxy
 * than a fixed window when the wall proposer comes up empty (the OP is
 * almost always the loudest sustained music in the first minutes).
 */
function loudestSpan(env, spanSec = 70) {
  const span = Math.floor(spanSec / 0.5);
  if (env.length <= span) return env.length ? { start: 0, end: env.length * 0.5 } : null;
  let bestI = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < env.length; i++) {
    sum += env[i];
    if (i >= span) sum -= env[i - span];
    if (i >= span - 1 && sum > bestSum) { bestSum = sum; bestI = i - span + 1; }
  }
  return { start: bestI * 0.5, end: (bestI + span) * 0.5 };
}

async function jobEstablish(item, bot) {
  const { malId, title, epA, epB } = item;
  // establish feeds a full 300 s of both episodes: openings may sit late
  // (recaps push them past 2:00) and the pair must contain the whole song
  const A = await watchEpisode(bot, malId, epA, title, 330, 300);
  const B = A && epB !== epA ? await watchEpisode(bot, malId, epB, title, 330, 300) : A;
  if (!A || !B) {
    // zoko has no page for one of the episodes — definitive miss
    stats.nodetect++;
    log(`${bot} establish SKIP ${title} [${malId}] ep${epA}+ep${epB} (stream unavailable)`);
    enqueueFinding({ bot, malId, ep: epA, status: "nodetect", detail: "stream unavailable" });
    if (epB !== epA) enqueueFinding({ bot, malId, ep: epB, status: "nodetect", detail: "stream unavailable" });
    return;
  }

  // multi-candidate matching: try each loud-wall anchor (top 3), plus the
  // loudest-span fallback, in both directions — the first hit wins
  let mA = null, mB = null;
  const anchorsA = [...(A.wall ? [A.wall] : []), ...A.walls?.() ?? [], loudestSpan(A.env)].filter(Boolean);
  const anchorsB = [...(B.wall ? [B.wall] : []), ...B.walls?.() ?? [], loudestSpan(B.env)].filter(Boolean);
  for (const a of anchorsA) {
    const t = matchEnvelope(B.env, A.env, a);
    if (t) { mB = t; mA = matchEnvelope(A.env, B.env, t); if (mA) break; mB = null; }
  }
  if (!mA || !mB) {
    for (const b of anchorsB) {
      const t = matchEnvelope(A.env, B.env, b);
      if (t) { mA = t; mB = matchEnvelope(B.env, A.env, t); if (mB) break; mA = null; }
    }
  }

  if (mA && mB && plausibleInterval(mA.start, mA.end) && plausibleInterval(mB.start, mB.end) && Math.min(mA.quality, mB.quality) >= MIN_QUALITY) {
    const ref = refFromEnv(A.env, mA);
    enqueueFinding({ bot, malId, ep: epA, status: "ok", start: mA.start, end: mA.end, quality: mA.quality, detail: `establish pair with ep${epB}` });
    enqueueFinding({ bot, malId, ep: epB, status: "ok", start: mB.start, end: mB.end, quality: mB.quality, detail: `establish pair with ep${epA}` });
    if (ref) {
      enqueueFinding({ bot, malId, ep: epA, status: "establish", start: mA.start, end: mA.end, detail: "reference founded", _ref: { malId, start: ref.int.start, end: ref.int.end, env: ref.env } });
    }
    stats.ok += 2;
    log(`${bot} ESTABLISH ${title} [${malId}] ep${epA}+ep${epB} -> ${mA.start}-${mA.end} / ${mB.start}-${mB.end} (q=${mA.quality}/${mB.quality})`);
    void logFinding({ bot, malId, title, ep: epA, status: "ok", start: mA.start, end: mA.end, quality: mA.quality });
    void logFinding({ bot, malId, title, ep: epB, status: "ok", start: mB.start, end: mB.end, quality: mB.quality });
    return;
  }

  stats.nodetect += 2;
  log(`${bot} establish MISS ${title} [${malId}] ep${epA}+ep${epB} (mA=${JSON.stringify(mA)}, mB=${JSON.stringify(mB)})`);
  enqueueFinding({ bot, malId, ep: epA, status: "nodetect", detail: "establish pair failed" });
  enqueueFinding({ bot, malId, ep: epB, status: "nodetect", detail: "establish pair failed" });
}

async function jobVerify(item, bot) {
  const { malId, title, ep, ref } = item;
  const C = await watchEpisode(bot, malId, ep, title, Math.min(ref.end + 170, 400));
  const m = matchEnvelope(C.env, ref.env, { start: ref.start, end: ref.end });
  if (m && plausibleInterval(m.start, m.end) && m.quality >= MIN_QUALITY) {
    stats.ok++;
    log(`${bot} OK ${title} [${malId}] ep${ep} -> opening ${m.start}-${m.end} (q=${m.quality})`);
    enqueueFinding({ bot, malId, ep, status: "ok", start: m.start, end: m.end, quality: m.quality });
    void logFinding({ bot, title, ep, status: "ok", start: m.start, end: m.end, quality: m.quality });
  } else {
    stats.nodetect++;
    log(`${bot} MISS ${title} [${malId}] ep${ep} (m=${JSON.stringify(m)})`);
    enqueueFinding({ bot, malId, ep, status: "nodetect", detail: `verify vs ref failed: ${m ? `q=${m.quality}` : "no alignment"}` });
  }
}

/**
 * Dub boundary probe — one step of the per-episode binary search. The
 * endpoint literally clicks the DUB server (runs the player's full dub
 * resolution chain, fake-dub verification included) and records the verdict;
 * the bot just executes and logs it.
 */
async function jobDubProbe(item, bot) {
  const { malId, title, ep, chain } = item;
  const res = await fetch(
    `${PROD}/api/bots/dub-probe?token=${encodeURIComponent(TOKEN)}&malId=${malId}&ep=${ep}&chain=${chain}`,
    { signal: AbortSignal.timeout(90_000) },
  );
  if (!res.ok) throw new Error(`dub-probe ${res.status}`);
  const d = await res.json();
  if (d.verdict === null || d.verdict === undefined) {
    log(`${bot} DUBPROBE ${title} [${malId}] ep${ep} ${chain}: transient — retry later`);
    return;
  }
  stats.dubprobes++;
  const v = d.verdict ? "HAS DUB" : "no dub";
  const b = d.boundaries ? ` (thru s1=${d.boundaries.s1} s2=${d.boundaries.s2})` : "";
  log(`${bot} DUBPROBE ${title} [${malId}] ep${ep} ${chain}: ${v}${b}`);
  // mirror the verdict into the local db too — prod's instance-local db is
  // ephemeral; the committed local db is what survives deploys
  queuedDubFindings.push({ bot, malId, ep, chain, ok: !!d.verdict, detail: `fleet dubprobe` });
  scheduleFlush();
  void logFinding({ bot, title, ep, status: "dubprobe", verdict: d.verdict, chain });
}

/* ---------------- worker pool ---------------- */

const doneThisSession = new Set(); // malId/ep already reported — skip on later sweeps
const markDone = (item) => {
  const eps = item.kind === "establish" ? [item.epA, item.epB] : [item.ep];
  for (const ep of eps) doneThisSession.add(`${item.kind === "dubprobe" ? "dub" : "intro"}/${item.malId}/${ep}`);
};

async function runQueue(items, lanes) {
  let idx = 0;
  let active = 0;
  const total = items.length;
  return new Promise((resolveAll) => {
    const done = () => {
      active--;
      if (idx >= total && active === 0) resolveAll();
      else pump();
    };
    const pump = () => {
      while (active < lanes && idx < total) {
        const item = items[idx++];
        const itemEps = item.kind === "establish" ? [item.epA, item.epB] : [item.ep];
        const ns = item.kind === "dubprobe" ? "dub" : "intro";
        if (itemEps.every((ep) => doneThisSession.has(`${ns}/${item.malId}/${ep}`))) continue; // already measured this session
        markDone(item);
        active++;
        const bot = `scout-${String((idx % lanes) + 1).padStart(2, "0")}`;
        const job =
          item.kind === "establish" ? jobEstablish(item, bot)
          : item.kind === "dubprobe" ? jobDubProbe(item, bot)
          : jobVerify(item, bot);
        job.then(done).catch(async (err) => {
          stats.error++;
          const malId = item.malId, ep = item.kind === "establish" ? item.epA : item.ep;
          log(`${bot} ERROR ${item.title} [${malId}] ep${ep}: ${String(err).slice(0, 120)}`);
          if (item.kind !== "dubprobe") {
            enqueueFinding({ bot, malId, ep, status: "error", detail: String(err).slice(0, 200) });
          }
          done();
        });
      }
      if (idx >= total && active === 0) resolveAll();
    };
    pump();
  });
}

/* ---------------- main ---------------- */

async function fetchBacklog(limit) {
  const res = await fetch(`${PROD}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}&limit=${limit}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`backlog ${res.status}`);
  return res.json();
}

/**
 * The fleet's dub report — "which anime still require dub". Fetched after
 * every sweep, logged to the console and appended to dub-report.log so the
 * list survives between runs.
 */
async function fetchDubReport() {
  try {
    const res = await fetch(`${PROD}/api/bots/dub-report?token=${encodeURIComponent(TOKEN)}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log(`dub-report -> ${res.status}`);
      return;
    }
    const r = await res.json();
    if (!r.ok) return;
    const line = `DUB REPORT ${r.generatedAt}: ${r.totals.anime} anime — ${r.totals.dubBehind} have dub behind the latest episodes, ${r.totals.noDubAtAll} sub-only, ${r.totals.unprobed} unprobed`;
    log(line);
    const still = (r.stillRequiringDub ?? []).slice(0, 60);
    if (still.length) {
      log(`still requiring dub (top ${still.length}):`);
      for (const a of still) log(`  - ${a.title} [${a.malId}] dubbed through ep ${a.dubThrough}/${a.total} (${a.episodesMissingDub} episodes missing dub)`);
    }
    try {
      await appendFile(
        new URL("./dub-report.log", import.meta.url).pathname,
        JSON.stringify({ at: new Date().toISOString(), totals: r.totals, stillRequiringDub: r.stillRequiringDub, noDubAtAll: (r.noDubAtAll ?? []).slice(0, 500) }) + "\n",
      );
    } catch { /* logging never blocks */ }
  } catch (err) {
    log(`dub-report failed: ${String(err).slice(0, 100)}`);
  }
}

async function cycle(round) {
  // big sweeps: the fleet must confirm skip times across the WHOLE catalog
  // (2141 anime / 34k+ episodes) — the API interleaves establish:verify 1:3,
  // so most of each sweep verifies measured shows' episodes
  const data = await fetchBacklog(2500);
  if (!data.ok) throw new Error("backlog not ok");
  const items = MAX_ITEMS ? data.backlog.slice(0, MAX_ITEMS) : data.backlog;
  log(`round ${round}: backlog ${items.length} items (dubprobes ${data.totals.dubprobes} / establish ${data.totals.establish} / verify ${data.totals.verify}; refs ${data.totals.refs}, measured ${data.totals.measured}/${data.totals.animes} animes)`);
  if (!items.length) return 0;
  await runQueue(items, LANES);
  await flush();
  await fetchDubReport();
  return items.length;
}

async function main() {
  log(`intro-scout fleet starting: ${LANES} lanes -> ${PROD}${LOOP ? " (24/7 loop)" : ONCE ? " (single pass)" : ""}`);
  let round = 0;
  const statLine = () => {
    const mins = ((Date.now() - stats.started) / 60000).toFixed(0);
    log(`stats: ${stats.ok} openings measured, ${stats.nodetect} misses, ${stats.dubprobes} dub probes, ${stats.error} errors, ${stats.refs} refs, ${Math.round(stats.scannedSec / 60)} episode-minutes scanned in ${mins} min`);
  };
  const statTimer = LOOP ? setInterval(statLine, 10 * 60_000) : null;

  try {
    if (ONCE || !LOOP) {
      round++;
      await cycle(round);
      statLine();
    } else {
      for (;;) {
        round++;
        const n = await cycle(round);
        if (n === 0) {
          statLine();
          log(`backlog empty — next sweep in 5 min`);
          await sleep(5 * 60_000);
        }
      }
    }
  } catch (err) {
    log(`fatal: ${String(err).slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    if (statTimer) clearInterval(statTimer);
    await flush();
  }
  process.exit(0);
}

main();
