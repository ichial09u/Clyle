#!/usr/bin/env node
/**
 * Clyle OP-sub intro campaign — the dedicated One Piece (malId 21) sub fleet.
 *
 * User mandate: "Build a lot more bots that their main job is to go into
 * each and every one piece episode for sub and they click the skip intro
 * button and see if the opening ends with the last 3 seconds of the opening
 * still playing when you hit skip intro and the skip intro should appear
 * when opening arrives — let me know when you get half way through."
 *
 * How one bot "watches" one episode (same engine as intro-scout.mjs):
 *   1. resolve the episode's real sub HLS playlist via /api/stream
 *   2. stream the first ~300 s through ffmpeg -> 0.5 s RMS loudness envelope
 *   3. cross-match the envelope against the lane's rolling reference —
 *      openings repeat identically across episodes, dialogue never aligns —
 *      yielding the TRUE opening interval on OUR encode (±0.5 s)
 *
 * What each bot then verifies (the two user acceptance criteria):
 *   A. button appears when the opening arrives:
 *        player shows the button at served.start - 1  ->  late = that moment
 *        more than 2.5 s after the measured OP start
 *   B. clicking leaves the OP's last 3 seconds playing:
 *        player seeks to served.end - 3  ->  overshoot = served.end more
 *        than 2 s past the measured OP end (lands in episode content)
 *
 * Every successful measurement is REPAIRED into the IntroScout table (via
 * /api/bots/intro-scout, prod + local mirror): an exact per-episode scout
 * row outranks Zoko's late-shifted tags in withSkipDataLive, so the button
 * data itself gets fixed while the campaign runs.
 *
 * Progress: scripts/op-sub-fleet-status.json (atomically rewritten) +
 * scripts/op-sub-fleet-results.jsonl (one line per episode). Halfway mark
 * (>= 50% of episodes measured) flips status.halfwayAt — the operator
 * reports to the user off that flag.
 *
 * Usage:
 *   node scripts/op-sub-intro-bots.mjs --lanes 12              # campaign
 *   node scripts/op-sub-intro-bots.mjs --from 1 --to 4 --lanes 2   # smoke
 *   node scripts/op-sub-intro-bots.mjs --status                # progress
 *   node scripts/op-sub-intro-bots.mjs --verify                # re-score
 *                                                              # served data
 */

import { appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const args = process.argv.slice(2);
const flag = (name, def = false) => (args.includes(`--${name}`) ? true : def);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};

const MAL = 21;
const PROD = opt("prod", process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app");
const MIRROR = opt("mirror", process.env.SCOUT_MIRROR || "http://localhost:3000");
const TOKEN = opt("token", process.env.SCOUT_TOKEN || "clyle-scout-v1");
const LANES = Math.max(1, parseInt(opt("lanes", "12"), 10) || 12);
const DECODE_SLOTS = Math.max(1, parseInt(opt("decode-slots", "8"), 10) || 8);
const FROM = parseInt(opt("from", "0"), 10) || 0;
const TO = parseInt(opt("to", "0"), 10) || 0;
const LOOP = flag("loop");
const STATUS_MODE = flag("status");
const VERIFY_MODE = flag("verify");

const RESULTS_FILE = new URL("./op-sub-fleet-results.jsonl", import.meta.url).pathname;
const STATUS_FILE = new URL("./op-sub-fleet-status.json", import.meta.url).pathname;
const LOG_FILE = new URL("./op-sub-fleet.log", import.meta.url).pathname;

const MIN_QUALITY = 0.75; // envelope match gate for the chain
const WATCH_MIN_SEC = 300; // always feed at least 5 min (recap-heavy OPs sit late)
const WATCH_MAX_SEC = 350;
const APPEAR_TOL_LATE = 2.5; // button >2.5 s after OP arrival = "too late"
const APPEAR_TOL_EARLY = 45; // button >45 s before OP arrival = "early"
const LAND_TOL_OVER = 2; // landing past OP end by >2 s = overshoot
const LAND_TOL_UNDER = 4; // landing >4 s early = undershoot (extra OP cut)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function log(...parts) {
  console.log(`[${ts()}]`, ...parts);
  appendFile(LOG_FILE, `${new Date().toISOString()} ${parts.join(" ")}\n`).catch(() => {});
}

/* ---------------- status / results plumbing ---------------- */

const status = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  total: 0,
  measured: 0, // episodes with a successful measurement this campaign
  ok: 0, // served data already correct (button timing + landing in spec)
  late: 0, // button appeared too late
  early: 0, // button appeared way before the OP
  overshoot: 0, // skip landed past the OP end
  lateOvershoot: 0, // both of the above (the user's exact complaint)
  undershoot: 0,
  nodata: 0, // no Skip Intro data served at all
  noop: 0, // episode genuinely has no opening (recap specials)
  errors: 0, // measurement failed (retryable)
  repaired: 0, // findings accepted by the scout API
  lastEp: 0,
  halfwayAt: null,
  doneAt: null,
  lanes: LANES,
};

async function loadDone() {
  const done = new Map();
  try {
    const raw = await readFile(RESULTS_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        // resume: successful measurements are kept, errors are retried
        if (r.verdict && r.verdict !== "error") done.set(r.ep, r);
      } catch { /* torn line — ignore */ }
    }
  } catch { /* first run */ }
  return done;
}

async function writeStatus() {
  status.updatedAt = new Date().toISOString();
  const tmp = `${STATUS_FILE}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(status, null, 2));
    await rename(tmp, STATUS_FILE);
  } catch { /* status is best-effort */ }
}

async function recordResult(row) {
  await appendFile(RESULTS_FILE, JSON.stringify(row) + "\n").catch(() => {});
  if (row.verdict === "error") status.errors++;
  else if (row.verdict === "noop") status.noop++;
  if (row.verdict !== "error") {
    status.measured++;
    status.lastEp = Math.max(status.lastEp, row.ep);
    if (row.verdict === "ok") status.ok++;
    else if (row.verdict === "late") status.late++;
    else if (row.verdict === "early") status.early++;
    else if (row.verdict === "overshoot") status.overshoot++;
    else if (row.verdict === "late+overshoot") status.lateOvershoot++;
    else if (row.verdict === "undershoot") status.undershoot++;
    else if (row.verdict === "nodata") status.nodata++;
    if (!status.halfwayAt && status.total && status.measured >= Math.ceil(status.total / 2)) {
      status.halfwayAt = new Date().toISOString();
      log(`*** HALFWAY REACHED — ${status.measured}/${status.total} episodes measured (user report due) ***`);
    }
  }
  await writeStatus();
}

/* ---------------- repair reporting (same wire format as intro-scout) ---------------- */

let queuedFindings = [];
let flushTimer = null;
let repairedCount = 0;

function enqueueFinding(f) {
  queuedFindings.push(f);
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), 12_000);
}

async function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = queuedFindings;
  queuedFindings = [];
  if (!batch.length) return;
  const payload = JSON.stringify({ bot: batch[0].bot, findings: batch, refs: [] });
  const targets = [MIRROR, PROD].filter(Boolean);
  await Promise.allSettled(
    targets.map(async (base) => {
      const res = await fetch(`${base}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) log(`repair POST to ${base === PROD ? "prod" : "mirror"} -> ${res.status}`);
    }),
  );
  repairedCount += batch.length;
  status.repaired = repairedCount;
}

/* ---------------- episode list ---------------- */

async function fetchEpisodeList() {
  // straight from the local db — the same rows the site serves
  try {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    const rows = await db.episode.findMany({
      where: { animeId: MAL, lang: "sub" },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    await db.$disconnect();
    const eps = rows.map((r) => r.number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (eps.length) return eps;
  } catch (e) {
    log(`db episode list failed (${String(e).slice(0, 80)}) — falling back to 1..1176`);
  }
  return Array.from({ length: 1176 }, (_, i) => i + 1);
}

/* ---------------- stream helpers ---------------- */

const TRANSIENT = /no audio.*STARVED|segments? -> 4\d\d|segments? -> 5\d\d|timeout|ETIMEDOUT|ECONNRESET|fetch failed|master -> 4\d\d|master -> 5\d\d|variant -> 4\d\d|variant -> 5\d\d/i;

async function resolveStreamSrc(ep) {
  // local first (fast, current), prod as backup
  for (const base of [MIRROR, PROD]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${base}/api/stream?malId=${MAL}&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(90_000) });
        if (res.status === 404) return { src: null, served: null, notFound: true };
        if (!res.ok) throw new Error(`stream ${res.status}`);
        const s = await res.json();
        return { src: s?.src ?? null, served: s?.skip ?? null, notFound: false };
      } catch (err) {
        if (attempt === 2) break;
        await sleep(3_000);
      }
    }
  }
  return { src: null, served: null, notFound: false };
}

/**
 * watch one episode (with the standard one transient retry). The ffmpeg
 * decode is the RAM-hungry part — held under the shared decode semaphore so
 * 12 lanes never spawn 12 concurrent decodes (the OOM spiral guard).
 */
async function watchEpisode(ep) {
  const { src, served, notFound } = await resolveStreamSrc(ep);
  if (!src) return { notFound, served, analysis: null };
  await acquireDecodeSlot();
  let r;
  try {
    r = await analyzePlaylist(src, { log: () => {}, minSec: WATCH_MIN_SEC, maxSec: WATCH_MAX_SEC, keepPcm: true, pcmCapSec: WATCH_MAX_SEC });
    if (r.status !== "ok" && TRANSIENT.test(r.detail || "")) {
      await sleep(6_000);
      r = await analyzePlaylist(src, { log: () => {}, minSec: WATCH_MIN_SEC, maxSec: WATCH_MAX_SEC, keepPcm: true, pcmCapSec: WATCH_MAX_SEC });
    }
  } finally {
    releaseDecodeSlot();
  }
  return { notFound: false, served, analysis: r };
}

/** loudest contiguous ~70 s span — OP proxy anchor for establish (from intro-scout) */
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

/* ---------------- correlation edge refinement ----------------
 * The matchEnvelope mask (|gain*a+bias-b| < 0.16 on normalized RMS) reliably
 * pins the OPENING CORE, but its tail over-extends on shows whose post-OP
 * scenes sit at similar loudness: One Piece ep1 measured 0.5-109.5 while the
 * real OP ends ~97.5 (frame-checked: t=96 still OP, t=99 episode content),
 * and ep3 chain-matched to 149. The fix: the OP's AUDIO is identical across
 * episodes (Pearson ~1.0 window-by-window), post-OP content never is — so
 * walk the coarse edges with a 10 s correlation window and keep the last
 * position where ref and target still agree. */

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const a = xs[i], b = ys[i]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb) + 1e-9);
  return den > 0 ? num / den : 0;
}

/**
 * Trim a coarse matched interval to the true song edges.
 * @param env       target episode envelope (0.5 s windows)
 * @param refEnv    reference envelope
 * @param refInt    the OP interval inside refEnv (seconds)
 * @param coarse    the coarse matched interval in the TARGET timeline (seconds)
 */
function refineEdges(env, refEnv, refInt, coarse) {
  const WIN = 20; // 10 s correlation window
  const o = Math.round((coarse.start - refInt.start) / 0.5);
  if (!Number.isFinite(o) || Math.abs(coarse.start - refInt.start) > 90) return coarse;

  const wCorrAt = (k) => {
    // correlation of ref[k-WIN..k) vs target[o+k-WIN..o+k)
    if (k - WIN < 0 || k > refEnv.length || o + k > env.length || o + k - WIN < 0) return null;
    const xs = refEnv.slice(k - WIN, k);
    const ys = env.slice(o + k - WIN, o + k);
    return pearson(xs, ys);
  };

  // ---- END: largest e (in windows) whose trailing window still agrees ----
  const maxE = Math.min(Math.floor((coarse.end + 12) / 0.5), Math.floor((env.length - o) / 0.5), refEnv.length);
  let refinedEnd = null;
  for (let e = maxE; e >= Math.ceil((coarse.end - 40) / 0.5); e--) {
    const c = wCorrAt(e);
    if (c != null && c >= 0.72) { refinedEnd = e; break; }
  }

  // ---- START: first s whose leading window still agrees ------------------
  const minS = Math.max(0, Math.floor((coarse.start - 15) / 0.5));
  let refinedStart = null;
  for (let s = minS; s <= Math.ceil((coarse.start + 12) / 0.5); s++) {
    const c = wCorrAt(s + WIN);
    if (c != null && c >= 0.72) { refinedStart = s; break; }
  }

  const start = refinedStart != null ? refinedStart * 0.5 : coarse.start;
  const end = refinedEnd != null ? refinedEnd * 0.5 : coarse.end;
  // the refinement must keep a plausible opening; otherwise keep the coarse one
  if (!plausibleInterval(start, end)) return coarse;
  return { ...coarse, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, refined: true };
}

/* ---------------- raw-PCM edge refinement (the precise instrument) ----------------
 * RMS-envelope correlation still over-extends (One Piece ep1's post-OP walk
 * scene correlates 0.75+ at envelope level). The OP's actual MIX is
 * sample-identical across episodes of a run — raw 8 kHz PCM cross-correlation
 * separates the boundary at corr ~0.95 (same song) vs <0.4 (different
 * dialogue). Used whenever both episodes kept PCM; envelope refine is the
 * fallback. */

const PCM_SR = 8000;

/** Pearson correlation of two same-length Int16Array spans. */
function pcmCorr(a, ai, b, bi, len) {
  if (ai < 0 || bi < 0 || ai + len > a.length || bi + len > b.length) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < len; i++) {
    const x = a[ai + i], y = b[bi + i];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const num = len * sab - sa * sb;
  const den = Math.sqrt((len * saa - sa * sa) * (len * sbb - sb * sb) + 1e-9);
  return den > 0 ? num / den : 0;
}

/**
 * Trim a coarse matched interval to the true song edges using raw PCM.
 *
 * Strategy: WALK from the guaranteed-matching anchor core outward (end walks
 * up, start walks down) while 1.5 s cross-correlation blocks keep matching
 * (same-song blocks: corr ≈ 0.99; different content: < 0.4), tolerating only
 * short (< 4 s) dips inside the song. The walk stops at the correlation
 * CLIFF — the song's last sample-aligned moment. A top-down walk from the
 * coarse end would stop on shared post-OP audio (One Piece ep3's title-card
 * sting matched to 149.5); the anchor-rooted walk cannot.
 *
 * @param pcmT     target episode PCM (Int16Array @ 8 kHz)
 * @param pcmR     reference episode PCM
 * @param refInt   the OP interval inside the REFERENCE timeline (seconds)
 * @param coarse   coarse matched interval in the TARGET timeline (seconds)
 */
function refineEdgesPcm(pcmT, pcmR, refInt, coarse) {
  if (!pcmT || !pcmR) return null;
  const BLK = Math.floor(1.5 * PCM_SR);
  const refDur = refInt.end - refInt.start;

  // micro-align + FAMILY GATE: the envelope match quantizes the song offset
  // to 0.5 s windows; find the sub-window shift that maximizes correlation
  // mid-song (guaranteed matching region). A mid-song corr < 0.9 means the
  // two episodes carry DIFFERENT mixes/cuts of the song (One Piece alternates
  // encode families: 110 s long-cut vs 87 s TV-cut "We Are!") — sample-level
  // walking is meaningless there, so report the gate and let the caller fall
  // back to the same-episode loud-wall walk.
  let shift = 0, bestShiftC = -1;
  for (const s of [-0.5, -0.25, 0, 0.25, 0.5]) {
    const t = coarse.start + 0.5 * refDur;
    const pos = refInt.start + (t - coarse.start) + s;
    const ai = Math.round(t * PCM_SR) - BLK;
    const bi = Math.round(pos * PCM_SR) - BLK;
    if (ai < 0 || bi < 0 || ai + BLK > pcmT.length || bi + BLK > pcmR.length) continue;
    const c = pcmCorr(pcmT, ai, pcmR, bi, BLK);
    if (c > bestShiftC) { bestShiftC = c; shift = s; }
  }
  if (bestShiftC < 0.9) return null; // different family — use the wall walk

  // song-position t in the target timeline aligns with ref position
  // refInt.start + (t - coarse.start) + shift
  const blockCorr = (t) => {
    const pos = refInt.start + (t - coarse.start) + shift;
    const ai = Math.round(t * PCM_SR) - BLK;
    const bi = Math.round(pos * PCM_SR) - BLK;
    if (ai < 0 || bi < 0 || ai + BLK > pcmT.length || bi + BLK > pcmR.length) return null;
    return pcmCorr(pcmT, ai, pcmR, bi, BLK);
  };

  // ---- END: walk up from inside the song core (60% of refDur sits inside
  // the song even when the target's cut is shorter than the reference's) --
  const anchorEnd = coarse.start + 0.6 * refDur;
  let end = anchorEnd, gap = 0;
  for (let t = anchorEnd + 0.5; t <= Math.min(coarse.end + 8, anchorEnd + 60); t += 0.5) {
    const c = blockCorr(t);
    if (c != null && c >= 0.8) { end = t; gap = 0; }
    else if (++gap > 8) break; // 4 s of sustained mismatch = song is over
  }

  // ---- START: walk down from the 30% mark. The song's intro is quiet
  // (fade-in / sparse guitar) where 1.5 s blocks correlate weakly even for
  // the same mix — 0.6 separates "same song, quiet part" (0.7-0.95) from
  // "different audio" (< 0.4) well enough, and overshooting downward is
  // clamped by the coarse bound below.
  const anchorStart = coarse.start + 0.3 * refDur;
  let start = anchorStart;
  gap = 0;
  for (let t = anchorStart - 0.5; t >= Math.max(coarse.start - 20, 0); t -= 0.5) {
    const c = blockCorr(t + 1.5); // leading block [t, t+1.5]
    if (c != null && c >= 0.6) { start = t; gap = 0; }
    else if (++gap > 8) break;
  }

  if (end - start < 30) return null; // degenerate — let the envelope refiner try
  return {
    ...coarse,
    start: Math.round(start * 10) / 10,
    end: Math.round(end * 10) / 10,
    refined: "pcm",
  };
}

/**
 * Same-episode loud-wall edge walk — the family-independent fallback.
 * The opening is wall-to-wall music; the OP->post-OP transition virtually
 * always carries a silence gap (song resolve before the title-card sting —
 * frame-checked on One Piece: a 0.00 loudness window sits exactly at the
 * boundary on BOTH encode families). Walk the episode's OWN envelope out
 * from inside the song and stop at a sustained dip (>= 1.0 s below 0.32).
 * This cannot be fooled by loud post-OP content — the walk halts at the
 * transition gap, and dips inside the song are shorter than the tolerance.
 */
function wallWalkEdges(env, coarse, refDur) {
  const DIP = 1; // a single sub-loud sample ends the walk (the transition gap is ~0.5 s)
  const MIN_TAIL = 25; // the walk never stops this close to its anchor (mid-song dips)
  const MIN_HEAD = 20;
  const at = (t) => env[Math.round(t / 0.5)] ?? 0;

  // per-episode loudness: episodes are p95-normalized INDEPENDENTLY (ep2's
  // whole song sits at ~0.45 where ep1's sits at ~0.8), so a fixed 0.32 wall
  // threshold over-trims quiet-normalized encodes. Anchor on the episode's
  // OWN song core (±10 s around the 60% mark is guaranteed inside the song)
  // and demand half of that.
  const anchorEnd = coarse.start + 0.6 * refDur;
  const anchorStart = coarse.start + 0.3 * refDur;
  const core = [];
  for (let t = anchorEnd - 10; t <= anchorEnd + 10; t += 0.5) core.push(at(t));
  core.sort((a, b) => a - b);
  const songLevel = core[Math.floor(core.length / 2)] || 0.5;
  const LOUD = Math.max(0.12, 0.4 * songLevel);

  let end = anchorEnd, quiet = 0;
  for (let t = anchorEnd + 0.5; t <= Math.min(coarse.end + 8, coarse.start + refDur + 25, env.length * 0.5 - 0.5); t += 0.5) {
    if (at(t) >= LOUD) { end = t; quiet = 0; }
    else if (++quiet >= DIP && t >= anchorEnd + MIN_TAIL) break;
  }

  let start = anchorStart;
  quiet = 0;
  for (let t = anchorStart - 0.5; t >= Math.max(coarse.start - 30, 0); t -= 0.5) {
    if (at(t) >= LOUD) { start = t; quiet = 0; }
    else if (++quiet >= DIP && t <= anchorStart - MIN_HEAD) break;
  }

  if (end - start < 30) return null;
  return { ...coarse, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, refined: "wall" };
}

/**
 * PCM refine (same family) intersected with the envelope wall walk, else
 * whichever succeeded, else the coarse interval. The INTERSECTION is the
 * point: the PCM cliff can creep a few seconds past a soft song ending
 * (final chord ringing over the transition), while the wall walk's silence
 * gap marks the physical OP->post-OP cut. min(end) lands the button exactly
 * on the song's last seconds; min(start) keeps the button from ever
 * appearing after the opening has arrived.
 */
function refineMatched(envT, envR, refInt, coarse, pcmT, pcmR) {
  const refDur = refInt.end - refInt.start;
  const viaPcm = refineEdgesPcm(pcmT, pcmR, refInt, coarse);
  const viaWall = wallWalkEdges(envT, coarse, refDur);
  const pcmOk = viaPcm && plausibleInterval(viaPcm.start, viaPcm.end);
  const wallOk = viaWall && plausibleInterval(viaWall.start, viaWall.end);

  let m = null;
  if (pcmOk && wallOk) {
    m = {
      ...viaPcm,
      start: Math.min(viaPcm.start, viaWall.start),
      end: Math.min(viaPcm.end, viaWall.end + 1),
      refined: "pcm+wall",
    };
  } else if (pcmOk) m = viaPcm;
  else if (wallOk) m = viaWall;
  if (!m) return coarse;

  // sanity vs the coarse match: the refinement may only move the start a
  // little earlier (a longer pre-roll is the coarse match's job to find),
  // and the song can never run far past the reference's duration (same song
  // = same length; a shorter TV-cut is FINE, a longer one is signal drift).
  // The end clamp is one-sided ON PURPOSE: an over-small end just plays a
  // few extra seconds of the song's tail (harmless), while an over-large end
  // lands the button past the opening — the exact bug being fixed.
  m.start = Math.max(m.start, Math.max(0, coarse.start - 14));
  m.end = Math.min(m.end, m.start + refDur + 8);
  return plausibleInterval(m.start, m.end) ? m : coarse;
}

/**
 * Earliest-start-wins repair guard: the CDN rotates encode families per
 * resolve (One Piece ep3 served a black-leaded TV-cut, then a clean
 * long-cut within one hour). The button appearing LATE is the bug being
 * fixed, so when the already-stored scout row starts EARLIER than the new
 * measurement with a matching end, keep it — don't let a later-starting
 * family's measurement overwrite the earlier one.
 */
function servedKeepsEarlierStart(served, measured) {
  const intro = served?.intro;
  if (!intro || served?.source !== "scout") return false;
  return intro.start < measured.start && Math.abs(intro.end - measured.end) < 5;
}

/** verdict of the currently-served data against the measured truth */
function verdictFor(served, measured) {
  const intro = served?.intro;
  if (!intro || !Number.isFinite(intro.start) || !Number.isFinite(intro.end)) return "nodata";
  const appearAt = intro.start - 1; // when the button pops (WatchView: start-1)
  const landsAt = intro.end - 3; // where a click seeks (WatchView: end-3)
  const late = appearAt - measured.start > APPEAR_TOL_LATE;
  const early = measured.start - appearAt > APPEAR_TOL_EARLY;
  const over = intro.end - measured.end > LAND_TOL_OVER; // lands past OP end
  const under = measured.end - intro.end > LAND_TOL_UNDER;
  if (late && over) return "late+overshoot";
  if (late) return "late";
  if (over) return "overshoot";
  if (early) return "early";
  if (under) return "undershoot";
  return "ok";
}

/* ---------------- decode semaphore (OOM guard, same as intro-scout) ---------------- */

let activeDecodes = 0;
const decodeWaiters = [];
async function acquireDecodeSlot() {
  if (activeDecodes < DECODE_SLOTS) { activeDecodes++; return; }
  await new Promise((res) => decodeWaiters.push(res));
  activeDecodes++;
}
function releaseDecodeSlot() {
  activeDecodes--;
  const next = decodeWaiters.shift();
  if (next) next();
}

/* ---------------- the campaign logic ---------------- */

/**
 * One lane = one contiguous slice of the episode list + a rolling reference.
 * The chain: match each episode's envelope against the last matched
 * episode's; where they align IS the (same) opening. A failed match marks a
 * BOUNDARY (new opening / recap special) — the lane establishes a new
 * reference by cross-matching the boundary episode with its successor.
 */
async function runLane(laneId, slice, done, botTag) {
  const bot = `${botTag}-${String(laneId).padStart(2, "0")}`;
  let ref = null; // { env, int, ep }

  const establishPair = async (epA, epB) => {
    const A = await watchEpisode(epA);
    if (!A.analysis || A.analysis.status !== "ok") return { A, B: null, m: null };
    const B = await watchEpisode(epB);
    if (!B.analysis || B.analysis.status !== "ok") return { A, B: null, m: null };
    const anchorsA = [...(A.analysis.wall ? [A.analysis.wall] : []), ...A.analysis.walls?.() ?? [], loudestSpan(A.analysis.env)].filter(Boolean);
    const anchorsB = [...(B.analysis.wall ? [B.analysis.wall] : []), ...B.analysis.walls?.() ?? [], loudestSpan(B.analysis.env)].filter(Boolean);
    let mA = null, mB = null;
    for (const a of anchorsA) {
      const t = matchEnvelope(B.analysis.env, A.analysis.env, a);
      if (t) { mB = t; mA = matchEnvelope(A.analysis.env, B.analysis.env, t); if (mA) break; mB = null; }
    }
    if (!mA || !mB) {
      for (const b of anchorsB) {
        const t = matchEnvelope(A.analysis.env, B.analysis.env, b);
        if (t) { mA = t; mB = matchEnvelope(B.analysis.env, A.analysis.env, t); if (mB) break; mA = null; }
      }
    }
    if (mA && mB && plausibleInterval(mA.start, mA.end) && plausibleInterval(mB.start, mB.end)
        && Math.min(mA.quality, mB.quality) >= MIN_QUALITY) {
      // trim both intervals to the true song edges (raw-PCM correlation when
      // both episodes kept PCM; envelope refine otherwise — the amplitude
      // mask alone over-extends into the post-OP scene)
      const rA = refineMatched(A.analysis.env, B.analysis.env, mB, mA, A.analysis.pcm, B.analysis.pcm);
      const rB = refineMatched(B.analysis.env, A.analysis.env, mA, mB, B.analysis.pcm, A.analysis.pcm);
      return { A, B, m: { A: rA, B: rB } };
    }
    return { A, B, m: null };
  };

  for (let i = 0; i < slice.length; i++) {
    const ep = slice[i];
    if (done.has(ep)) { continue; }
    const t0 = Date.now();

    try {
      // ---- chain match against the rolling reference ------------------
      if (ref) {
        const { served, analysis } = await watchEpisode(ep);
        if (!analysis || analysis.status !== "ok") {
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: analysis?.detail?.slice(0, 160) ?? "stream unavailable", servedBefore: served ?? null });
          log(`${bot} ep${ep} ERROR ${analysis?.detail?.slice(0, 80) ?? "no stream"}`);
          continue;
        }
        const m0 = matchEnvelope(analysis.env, ref.env, ref.int);
        const m = m0 ? refineMatched(analysis.env, ref.env, ref.int, m0, analysis.pcm, ref.pcm) : null;
        if (m && m.quality >= MIN_QUALITY && plausibleInterval(m.start, m.end)) {
          const verdict = verdictFor(served, m);
          const keepEarlier = servedKeepsEarlierStart(served, m);
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict, measured: { start: m.start, end: m.end, quality: m.quality }, servedBefore: served ?? null, mode: "chain", repairSkipped: keepEarlier || undefined });
          if (!keepEarlier) {
            enqueueFinding({ bot, malId: MAL, ep, status: "ok", start: m.start, end: m.end, quality: m.quality, detail: `op-sub campaign (chain vs ep${ref.ep})` });
          }
          log(`${bot} ep${ep} ${verdict.toUpperCase()} op ${m.start}-${m.end} (q=${m.quality}${m.refined === "pcm" ? ", pcm-refined" : ""}) vs served ${JSON.stringify(served?.intro ?? null)} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
          ref = { env: analysis.env, int: m, ep, pcm: analysis.pcm };
          continue;
        }
        // ---- boundary: opening changed here, or this episode has none ---
        const nextEp = slice[i + 1];
        if (!nextEp) {
          const ownWall = analysis.walls?.().length || (analysis.wall ? 1 : 0);
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: ownWall ? "error" : "noop", detail: "boundary at list end", servedBefore: served ?? null });
          log(`${bot} ep${ep} boundary-at-end (${ownWall ? "error" : "noop"})`);
          break;
        }
        const est = await establishPair(ep, nextEp);
        if (est.m) {
          const vA = verdictFor(est.A.served, est.m.A);
          const vB = verdictFor(est.B.served, est.m.B);
          const keepA = servedKeepsEarlierStart(est.A.served, est.m.A);
          const keepB = servedKeepsEarlierStart(est.B.served, est.m.B);
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: vA, measured: { start: est.m.A.start, end: est.m.A.end, quality: est.m.A.quality }, servedBefore: est.A.served ?? null, mode: "boundary-establish", repairSkipped: keepA || undefined });
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep: nextEp, verdict: vB, measured: { start: est.m.B.start, end: est.m.B.end, quality: est.m.B.quality }, servedBefore: est.B.served ?? null, mode: "boundary-establish", repairSkipped: keepB || undefined });
          if (!keepA) enqueueFinding({ bot, malId: MAL, ep, status: "ok", start: est.m.A.start, end: est.m.A.end, quality: est.m.A.quality, detail: `op-sub campaign (boundary pair with ep${nextEp})` });
          if (!keepB) enqueueFinding({ bot, malId: MAL, ep: nextEp, status: "ok", start: est.m.B.start, end: est.m.B.end, quality: est.m.B.quality, detail: `op-sub campaign (boundary pair with ep${ep})` });
          log(`${bot} ep${ep}+ep${nextEp} NEW OPENING ${est.m.A.start}-${est.m.A.end} / ${est.m.B.start}-${est.m.B.end} (q=${est.m.A.quality}/${est.m.B.quality})`);
          ref = { env: est.B.analysis.env, int: est.m.B, ep: nextEp, pcm: est.B.analysis.pcm };
          i++; // both consumed
        } else {
          // could not pair. ONLY a watched episode with NO sustained loud
          // wall earns a no-OP suppression (the button must never vanish
          // because a fetch hiccuped) — everything else is a retryable error.
          const an = est.A?.analysis;
          if (!an || an.status !== "ok") {
            await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: `stream unavailable: ${(an?.detail ?? "no stream").slice(0, 120)}`, servedBefore: est.A?.served ?? null });
            log(`${bot} ep${ep} ERROR (stream unavailable) — ref reset`);
          } else {
            const ownWall = an.walls?.().length || (an.wall ? 1 : 0);
            if (ownWall) {
              await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: "boundary establish failed (wall present)", servedBefore: est.A.served ?? null });
              log(`${bot} ep${ep} ERROR (establish failed, wall present) — ref reset`);
            } else {
              await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "noop", detail: "no loud wall — likely recap/no OP", servedBefore: est.A.served ?? null });
              enqueueFinding({ bot, malId: MAL, ep, status: "nodetect", detail: "op-sub campaign: no sustained loud wall (recap/no-OP episode)" });
              log(`${bot} ep${ep} NOOP (recap?) — ref reset`);
            }
          }
          ref = null; // next episode re-establishes with its successor
        }
        continue;
      }

      // ---- no reference: establish with the successor ------------------
      const nextEp = slice[i + 1];
      if (!nextEp) {
        await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: "tail episode without partner" });
        break;
      }
      const est = await establishPair(ep, nextEp);
      if (est.m) {
        const vA = verdictFor(est.A.served, est.m.A);
        const vB = verdictFor(est.B.served, est.m.B);
        const keepA2 = servedKeepsEarlierStart(est.A.served, est.m.A);
        const keepB2 = servedKeepsEarlierStart(est.B.served, est.m.B);
        await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: vA, measured: { start: est.m.A.start, end: est.m.A.end, quality: est.m.A.quality }, servedBefore: est.A.served ?? null, mode: "establish", repairSkipped: keepA2 || undefined });
        await recordResult({ at: new Date().toISOString(), lane: laneId, ep: nextEp, verdict: vB, measured: { start: est.m.B.start, end: est.m.B.end, quality: est.m.B.quality }, servedBefore: est.B.served ?? null, mode: "establish", repairSkipped: keepB2 || undefined });
        if (!keepA2) enqueueFinding({ bot, malId: MAL, ep, status: "ok", start: est.m.A.start, end: est.m.A.end, quality: est.m.A.quality, detail: `op-sub campaign (establish pair with ep${nextEp})` });
        if (!keepB2) enqueueFinding({ bot, malId: MAL, ep: nextEp, status: "ok", start: est.m.B.start, end: est.m.B.end, quality: est.m.B.quality, detail: `op-sub campaign (establish pair with ep${ep})` });
        log(`${bot} ep${ep}+ep${nextEp} ESTABLISH ${est.m.A.start}-${est.m.A.end} / ${est.m.B.start}-${est.m.B.end} (q=${est.m.A.quality}/${est.m.B.quality})`);
        ref = { env: est.B.analysis.env, int: est.m.B, ep: nextEp, pcm: est.B.analysis.pcm };
        i++;
      } else {
        const an = est.A?.analysis;
        if (!an || an.status !== "ok") {
          await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: `stream unavailable: ${(an?.detail ?? "no stream").slice(0, 120)}`, servedBefore: est.A?.served ?? null });
          log(`${bot} ep${ep} ERROR (stream unavailable)`);
        } else {
          const ownWall = an.walls?.().length || (an.wall ? 1 : 0);
          if (ownWall) {
            await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: "establish failed (wall present)", servedBefore: est.A.served ?? null });
            log(`${bot} ep${ep} ERROR (establish failed, wall present)`);
          } else {
            await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "noop", detail: "no loud wall — likely recap/no OP", servedBefore: est.A.served ?? null });
            enqueueFinding({ bot, malId: MAL, ep, status: "nodetect", detail: "op-sub campaign: no sustained loud wall (recap/no-OP episode)" });
            log(`${bot} ep${ep} NOOP (recap?)`);
          }
        }
        // ref stays null — the successor gets its own establish next round
      }
    } catch (err) {
      await recordResult({ at: new Date().toISOString(), lane: laneId, ep, verdict: "error", detail: String(err).slice(0, 160) });
      log(`${bot} ep${ep} EXCEPTION ${String(err).slice(0, 120)}`);
    }
  }
}

/* ---------------- main modes ---------------- */

async function campaign() {
  const all = await fetchEpisodeList();
  const eps = all.filter((e) => (!FROM || e >= FROM) && (!TO || e <= TO));
  status.total = eps.length;
  const done = await loadDone();
  log(`campaign: ${eps.length} episodes (${done.size} already measured on disk), ${LANES} lanes, ${DECODE_SLOTS} decode slots`);
  await writeStatus();

  // contiguous slices so each lane's rolling chain stays within one opening run
  const chunk = Math.ceil(eps.length / LANES);
  const slices = [];
  for (let k = 0; k < LANES; k++) {
    const s = eps.slice(k * chunk, (k + 1) * chunk);
    if (s.length) slices.push(s);
  }

  // jitter staggers the lanes; episode decodes are gated by the semaphore
  // inside watchEpisode
  await Promise.all(
    slices.map(async (slice, k) => {
      await sleep(Math.random() * 4_000);
      // runLane catches per-episode errors; this guards lane-level crashes
      await runLane(k + 1, slice, done, "opsub").catch((e) => log(`lane ${k + 1} crashed: ${String(e).slice(0, 200)}`));
    }),
  );

  await flush();
  await writeStatus();
  log(`campaign pass complete: measured ${status.measured}/${status.total}, ok ${status.ok}, late ${status.late}, overshoot ${status.overshoot}, late+overshoot ${status.lateOvershoot}, nodata ${status.nodata}, noop/errors ${status.errors}, repaired ${status.repaired}`);
}

/** re-score: recompute verdicts from the CURRENT served data (post-repair) */
async function verify() {
  const done = await loadDone();
  const rows = [...done.values()].sort((a, b) => a.ep - b.ep);
  let ok = 0, off = 0, nodata = 0, failed = 0;
  log(`verify: re-scoring ${rows.length} measured episodes against the live /api/stream merge`);
  for (const r of rows) {
    if (!r.measured) continue;
    try {
      const res = await fetch(`${MIRROR}/api/stream?malId=${MAL}&ep=${r.ep}&lang=sub`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) { failed++; continue; }
      const j = await res.json();
      const v = verdictFor(j.skip, r.measured);
      if (v === "ok") ok++;
      else if (v === "nodata") nodata++;
      else off++;
      if (v !== "ok") log(`  ep${r.ep}: NOW ${v} served=${JSON.stringify(j.skip?.intro ?? null)} measured=${JSON.stringify(r.measured)}`);
    } catch {
      failed++;
    }
  }
  log(`verify result: ok ${ok}/${rows.length}, still-off ${off}, nodata ${nodata}, fetch-failed ${failed}`);
  const report = { at: new Date().toISOString(), episodes: rows.length, ok, off, nodata, failed };
  await writeFile(new URL("./op-sub-verify-report.json", import.meta.url).pathname, JSON.stringify(report, null, 2)).catch(() => {});
}

async function printStatus() {
  try {
    const s = JSON.parse(await readFile(STATUS_FILE, "utf8"));
    const pct = s.total ? Math.round((s.measured / s.total) * 100) : 0;
    console.log(JSON.stringify(s));
    console.log(`\nOP-sub campaign: ${s.measured}/${s.total} measured (${pct}%) | ok=${s.ok} late=${s.late} overshoot=${s.overshoot} late+overshoot=${s.lateOvershoot} early=${s.early} undershoot=${s.undershoot} nodata=${s.nodata} err=${s.errors} repaired=${s.repaired}`);
    console.log(`last ep measured: ${s.lastEp} | halfwayAt: ${s.halfwayAt ?? "not yet"} | doneAt: ${s.doneAt ?? "running"}`);
  } catch (e) {
    console.log(`no status yet (${e.message?.slice(0, 60)})`);
  }
}

/** re-post every measured interval to the MIRROR db — reconciliation for
 *  episodes measured while the local dev server was down (their repair only
 *  reached prod; the local db is what ships with deploys). */
async function repost() {
  const done = await loadDone();
  const rows = [...done.values()].filter((r) => r.measured);
  console.log(`repost: ${rows.length} measured rows -> ${MIRROR}`);
  let sent = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40).map((r) => ({
      bot: "opsub-repost",
      malId: MAL,
      ep: r.ep,
      status: "ok",
      start: r.measured.start,
      end: r.measured.end,
      quality: r.measured.quality ?? 0.9,
      detail: "op-sub campaign (repost reconcile)",
    }));
    try {
      const res = await fetch(`${MIRROR}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot: "opsub-repost", findings: batch, refs: [] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) sent += batch.length;
      else console.log(`  batch ${i}: HTTP ${res.status}`);
    } catch (e) {
      console.log(`  batch ${i}: ${String(e).slice(0, 80)}`);
    }
    await sleep(1_500);
  }
  console.log(`repost done: ${sent}/${rows.length} sent to the mirror db`);
}

async function main() {
  if (STATUS_MODE) return printStatus();
  if (VERIFY_MODE) return verify();
  if (args.includes("--repost")) return repost();

  log(`OP-sub intro campaign starting: ${LANES} lanes -> mirror ${MIRROR} / prod ${PROD}`);
  if (LOOP) {
    for (;;) {
      await campaign();
      if (!status.doneAt && status.total && status.measured >= status.total) status.doneAt = new Date().toISOString();
      await writeStatus();
      log(`cycle done — re-sweeping errors/misses in 10 min`);
      await sleep(10 * 60_000);
    }
  } else {
    await campaign();
    if (status.total && status.measured >= status.total) status.doneAt = new Date().toISOString();
    await writeStatus();
  }
  process.exit(0);
}

main().catch((e) => { log(`fatal: ${String(e).slice(0, 300)}`); process.exit(1); });

// the campaign runs unattended for hours — never die silently. Log anything
// unexpected; the shell supervisor restarts the process (results resume).
process.on("uncaughtException", (e) => { log(`uncaughtException: ${String(e?.stack || e).slice(0, 500)}`); process.exit(1); });
process.on("unhandledRejection", (e) => { log(`unhandledRejection: ${String(e?.stack || e).slice(0, 500)}`); process.exit(1); });
