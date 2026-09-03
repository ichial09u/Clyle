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

const MIN_QUALITY = 0.72; // envelope match gate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queuedFindings = [];
let flushTimer = null;
const stats = { ok: 0, nodetect: 0, error: 0, refs: 0, scannedSec: 0, started: Date.now() };

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
  queuedFindings = [];
  if (!batch.length) return;
  const refs = batch.filter((f) => f._ref).map((f) => f._ref);
  try {
    const res = await fetch(`${PROD}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bot: batch[0]?.bot ?? "scout",
        findings: batch.map(({ _ref, ...f }) => f),
        refs,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      log(`report POST failed: ${res.status} ${JSON.stringify(body).slice(0, 150)} — ${batch.length} finding(s) dropped`);
    } else {
      stats.refs += refs.length;
    }
  } catch (err) {
    log(`report POST error: ${String(err).slice(0, 120)} — ${batch.length} finding(s) dropped`);
  }
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
async function watchEpisode(bot, malId, ep, title, maxSec) {
  const src = await resolveStreamSrc(malId, ep);
  if (!src) return null;
  const r = await analyzePlaylist(src, { log: () => {}, maxSec });
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

async function jobEstablish(item, bot) {
  const { malId, title, epA, epB } = item;
  const A = await watchEpisode(bot, malId, epA, title, 330);
  const B = await watchEpisode(bot, malId, epB, title, 330);

  const anchorA = A.wall ?? { start: 10, end: Math.min(200, A.analyzedSec - 40) };
  let mB = matchEnvelope(B.env, A.env, anchorA);
  let mA = null;
  if (mB) mA = matchEnvelope(A.env, B.env, mB);
  if (!mA || !mB) {
    // second chance: propose from B's wall instead
    const anchorB = B.wall;
    if (anchorB) {
      const mAtry = matchEnvelope(A.env, B.env, anchorB);
      if (mAtry) {
        const mBtry = matchEnvelope(B.env, A.env, mAtry);
        if (mBtry) { mA = mAtry; mB = mBtry; }
      }
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
    void logFinding({ bot, malId, title, ep, status: "ok", start: m.start, end: m.end, quality: m.quality });
  } else {
    stats.nodetect++;
    log(`${bot} MISS ${title} [${malId}] ep${ep} (m=${JSON.stringify(m)})`);
    enqueueFinding({ bot, malId, ep, status: "nodetect", detail: `verify vs ref failed: ${m ? `q=${m.quality}` : "no alignment"}` });
  }
}

/* ---------------- worker pool ---------------- */

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
        active++;
        const bot = `scout-${String((idx % lanes) + 1).padStart(2, "0")}`;
        const job = item.kind === "establish" ? jobEstablish(item, bot) : jobVerify(item, bot);
        job.then(done).catch(async (err) => {
          stats.error++;
          const malId = item.malId, ep = item.kind === "establish" ? item.epA : item.ep;
          log(`${bot} ERROR ${item.title} [${malId}] ep${ep}: ${String(err).slice(0, 120)}`);
          enqueueFinding({ bot, malId, ep, status: "error", detail: String(err).slice(0, 200) });
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

async function cycle(round) {
  const data = await fetchBacklog(900);
  if (!data.ok) throw new Error("backlog not ok");
  const items = MAX_ITEMS ? data.backlog.slice(0, MAX_ITEMS) : data.backlog;
  log(`round ${round}: backlog ${items.length} items (establish ${data.totals.establish} / verify ${data.totals.verify}; refs ${data.totals.refs}, measured ${data.totals.measured}/${data.totals.animes} animes)`);
  if (!items.length) return 0;
  await runQueue(items, LANES);
  await flush();
  return items.length;
}

async function main() {
  log(`intro-scout fleet starting: ${LANES} lanes -> ${PROD}${LOOP ? " (24/7 loop)" : ONCE ? " (single pass)" : ""}`);
  let round = 0;
  const statLine = () => {
    const mins = ((Date.now() - stats.started) / 60000).toFixed(0);
    log(`stats: ${stats.ok} openings measured, ${stats.nodetect} misses, ${stats.error} errors, ${stats.refs} refs, ${Math.round(stats.scannedSec / 60)} episode-minutes scanned in ${mins} min`);
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
