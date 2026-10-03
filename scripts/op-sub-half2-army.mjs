#!/usr/bin/env node
/**
 * OP-SUB HALF-2 ARMY — wave 3: the SECOND HALF of the One Piece sub
 * Skip Intro mission (eps 589..1176, 588 episodes).
 *
 * User order: "Start the next half" — after the halfway report covered the
 * first half, every episode 589..1176 gets the same treatment, upgraded with
 * everything waves 1-2 learned:
 *
 *   WAVE-2 GROUND TRUTH baked in: One Piece's served intro on hundreds of
 *   episodes is a ~163-171s [0, ~171] block (recap + OP as one skip block)
 *   — that shape is REAL, not bad data (the sustained music wall really
 *   ends at ~171.5s). So the old 150s shape ceiling is gone; the verdict
 *   comes from the ENCODE, not the shape.
 *
 * Per episode (one lane, full pipeline):
 *   1. RESOLVE   — /api/stream?malId=21&ep=N&lang=sub&server=1 (the exact
 *                  call the player makes on the sub path)
 *   2. BUTTON    — served skip.intro must exist (else: known-no-OP set from
 *                  wave 1, or pair-measure fix); the button window
 *                  [start-1, end] must be nonempty (button pops when the
 *                  opening arrives)
 *   3. CLICK     — the click seeks to max(start, end-3): landing must be
 *                  inside [start, end) so the last 3 seconds of the opening
 *                  are still playing
 *   4. STREAM    — playlist duration must cover `end`; the segments at the
 *                  click target and at `start` must serve real bytes
 *   5. ENCODE    — the definitive test (wave-2 method): 330s of the sub
 *                  encode through ffmpeg; at the click target (end-3) the
 *                  opening must still be playing (>=60% loud windows ±2s)
 *        loud at click  -> CERTIFIED (both mission criteria hold)
 *        not loud       -> the served end is wrong: POST the measured wall
 *                          (scout exact outranks zoko payload), re-verify
 *                          after the 60s scout cache turnover
 *   6. NO-OP     — episodes with no served intro that fail pair-measurement
 *                  with two different partners are honest no-button eps
 *                  (recap/special) — never force-written
 *
 * Progress: scripts/op-sub-half2-progress.json
 * Log:      scripts/op-sub-half2.log (JSONL, one row per episode)
 * Report:   scripts/op-sub-half2-report.json
 *
 * Usage: node scripts/op-sub-half2-army.mjs [--lanes 6] [--from 589] [--to 1176]
 */

import { appendFile, writeFile, readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { analyzePlaylist, matchEnvelope } from "./lib/intro-detect.mjs";

/* ---------------- config ---------------- */

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const MAL = 21; // ONE PIECE
const BASE = opt("base", "http://localhost:3000");
const SCOUT_TOKEN = opt("token", "clyle-scout-v1");
const LANES = Math.max(1, parseInt(opt("lanes", "6"), 10) || 6);
const FROM_EP = Math.max(1, parseInt(opt("from", "589"), 10) || 589);
const TO_EP = parseInt(opt("to", "1176"), 10) || 1176;
const LOUD_FRAC = 0.6;      // fraction of loud windows required around the click
const PAIR_QUALITY = 0.72;  // envelope cross-match quality gate (fleet standard)
const UA = "Mozilla/5.0 (ClyleOPHalf2/1.0)";

const PROGRESS_FILE = new URL("./op-sub-half2-progress.json", import.meta.url).pathname;
const REPORT_FILE = new URL("./op-sub-half2-report.json", import.meta.url).pathname;
const LOG_FILE = new URL("./op-sub-half2.log", import.meta.url).pathname;
const WAVE1_REPORT = new URL("./op-sub-intro-report.json", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

/* ---------------- state ---------------- */

const state = {
  startedAt: new Date().toISOString(), updatedAt: null,
  from: FROM_EP, to: TO_EP, total: 0,
  entered: 0, lastEp: 0, done: false, halfDone: false,
  certified: 0, fixed: 0, fixFailed: 0, noOp: 0, noOpKnown: 0,
  noButton: 0, badData: 0, streamFail: 0, resolveFail: 0, inconclusive: 0,
  failEps: [], fixedEps: [], noOpEps: [],
};
let totalWork = 0;
async function snapshot() {
  state.updatedAt = new Date().toISOString();
  state.done = state.entered >= totalWork && fixPending() === 0;
  await writeFile(PROGRESS_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}
async function logRow(row) {
  try { await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* never blocks */ }
}

/* CDN headers — mirrors the player's proxy registry (stream-proxy-registry.ts) */
const MEGAP_SUFFIXES = [".shiora.top", ".shiora.site", ".norami.top", ".akirax.buzz", ".mikora.top", ".kryntal.top", ".vaelith.top", ".imgnex.top"];
const ZOKO_REFERER = "https://zokoanime.video/";
const MEGAPLAY_REFERER = "https://megaplay.buzz/";
function cdnHeadersFor(rawUrl) {
  let host = "";
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return {}; }
  if (MEGAP_SUFFIXES.some((s) => host.endsWith(s))) return { Referer: MEGAPLAY_REFERER, Origin: MEGAPLAY_REFERER.replace(/\/$/, "") };
  if (host.endsWith(".hakunaymatata.com")) return {};
  return { Referer: ZOKO_REFERER, Origin: ZOKO_REFERER.replace(/\/$/, ""), "User-Agent": UA };
}

/* ---------------- stream helpers ---------------- */

async function resolveSubStream(ep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, {
        signal: AbortSignal.timeout(75_000), headers: { "User-Agent": UA },
      });
      if (res.status === 404) return { _404: true };
      if (!res.ok) throw new Error(`stream ${res.status}`);
      const s = await res.json();
      if (!s?.src) return null;
      return s;
    } catch {
      if (attempt < 2) { await sleep(3_000); continue; }
      return null;
    }
  }
  return null;
}

/** first chunk of a segment — proves real bytes exist at that position */
async function segmentHasBytes(url) {
  try {
    const res = await fetch(url, { headers: cdnHeadersFor(url), signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return false;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    try { await reader.cancel(); } catch { /* fine */ }
    return !!value && value.length > 0;
  } catch { return false; }
}

/** master -> best variant -> time-mapped segment plan (the player's HLS walk) */
async function loadStreamPlan(srcUrl) {
  const pl = await fetch(srcUrl, { headers: cdnHeadersFor(srcUrl), signal: AbortSignal.timeout(30_000), cache: "no-store" }).catch(() => null);
  if (!pl || pl.status !== 200) return null;
  const masterText = await pl.text().catch(() => "");
  if (!masterText.includes("#EXTM3U")) return null;

  const lines = masterText.split("\n").map((l) => l.trim()).filter(Boolean);
  let variantUrl = null, bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) ?? [])[1] ?? "0", 10);
      const next = lines[i + 1];
      if (next && !next.startsWith("#") && bw >= bestBw) { bestBw = bw; variantUrl = new URL(next, srcUrl).href; }
    }
  }
  if (!variantUrl) variantUrl = lines.find((l) => !l.startsWith("#")) ? new URL(lines.find((l) => !l.startsWith("#")), srcUrl).href : null;

  let mediaText = masterText, mediaBase = srcUrl;
  if (variantUrl) {
    const vres = await fetch(variantUrl, { headers: cdnHeadersFor(variantUrl), signal: AbortSignal.timeout(30_000), cache: "no-store" }).catch(() => null);
    if (!vres || vres.status !== 200) return null;
    mediaText = await vres.text().catch(() => "");
    if (!mediaText.includes("#EXTM3U")) return null;
    mediaBase = variantUrl;
  }

  const segs = [];
  let pend = null;
  for (const line of mediaText.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#EXTINF:")) pend = parseFloat(t.slice(8));
    else if (t && !t.startsWith("#")) {
      if (pend == null || !Number.isFinite(pend)) pend = 4;
      segs.push({ url: new URL(t, mediaBase).href, start: 0, dur: pend });
      pend = null;
    }
  }
  if (!segs.length) return null;
  let acc = 0;
  for (const s of segs) { s.start = acc; acc += s.dur; }
  const duration = acc;
  const segmentAt = (tSec) => {
    const t = Math.max(0, tSec);
    for (const s of segs) {
      if (t >= s.start && t < s.start + s.dur + 0.001) return s;
      if (s.start > t) break;
    }
    return null;
  };
  return { duration, segmentAt };
}

/* ---------------- encode truth (wave-2 definitive test) ---------------- */

/** watch one episode's sub encode (330s of audio through ffmpeg) */
async function watchEncode(ep) {
  const resolved = await resolveSubStream(ep);
  if (!resolved || resolved._404 || !resolved.src) return null;
  let r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 330, minSec: 300 });
  if (r.status !== "ok" && /STARVED|timeout|fetch|429|503/i.test(r.detail || "")) {
    await sleep(6_000);
    r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 330, minSec: 300 });
  }
  if (r.status !== "ok") return null;
  return r;
}

/** THE mission criterion: is the opening still playing at the click (end-3)? */
function clickLandsInOpening(env, start, end) {
  const click = end - 3;
  const idx = Math.floor(click / 0.5);
  const from = Math.max(0, idx - 4), to = Math.min(env.length, idx + 5); // ±2s around the click
  if (to - from < 3 || click > env.length * 0.5) return { ok: false, decisive: false, why: `click ${click.toFixed(0)}s beyond analyzed audio (${(env.length * 0.5).toFixed(0)}s)` };
  let loud = 0;
  for (let i = from; i < to; i++) if (env[i] >= 0.5) loud++;
  const frac = loud / (to - from);
  return { ok: frac >= LOUD_FRAC, decisive: true, why: `${(frac * 100).toFixed(0)}% loud at click ${click.toFixed(1)}s`, frac };
}

/* ---------------- fix path ---------------- */

async function reportFindings(bot, findings) {
  try {
    const res = await fetch(`${BASE}/api/bots/intro-scout?token=${encodeURIComponent(SCOUT_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ bot, findings }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch { return false; }
}

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

/** measure ep+partner envelopes, cross-match (consecutive eps share the OP) */
async function measurePair(bot, ep, partner) {
  const A = await watchEncode(ep);
  const B = A && partner !== ep ? await watchEncode(partner) : null;
  if (!A || !B) return { ok: false, why: "analyze failed (stream/starve)" };

  const anchorsA = [...(A.wall ? [A.wall] : []), loudestSpan(A.env)].filter(Boolean);
  const anchorsB = [...(B.wall ? [B.wall] : []), loudestSpan(B.env)].filter(Boolean);
  let mA = null, mB = null;
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
  if (!mA || !mB) return { ok: false, why: "no cross-alignment (pair)" };
  if (mA.end - mA.start < 40 || mA.end - mA.start > 210) return { ok: false, why: `interval ${mA.start.toFixed(0)}-${mA.end.toFixed(0)} not OP-shaped` };
  if (Math.min(mA.quality, mB.quality) < PAIR_QUALITY) return { ok: false, why: `quality ${(Math.min(mA.quality, mB.quality)).toFixed(2)} < ${PAIR_QUALITY}` };
  return { ok: true, A: mA, B: mB };
}

/* ---------------- fix ledger ---------------- */

const fixStrikes = new Map();
const noOpSet = new Set();       // eps confirmed (2 partner pairs) to have no opening
const fixDone = new Set();       // eps with a POSTed fix that re-verified PASS
const fixing = new Set();
function fixPending() { return fixing.size; }

/* ---------------- per-episode pipeline ---------------- */

async function runEpisode(bot, ep) {
  // 1. RESOLVE — the exact call the player makes on the sub path
  const resolved = await resolveSubStream(ep);
  if (!resolved) { state.resolveFail++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "RESOLVE-FAIL", detail: "stream resolve failed twice" }); return; }
  if (resolved._404) { state.resolveFail++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "RESOLVE-FAIL", detail: "no sub page for this episode (404)" }); return; }

  // 2. BUTTON — served skip.intro must exist
  const intro = resolved.skip?.intro;
  const source = resolved.skip?.source ?? "none";
  if (!intro || !Number.isFinite(intro.start) || !Number.isFinite(intro.end)) {
    if (wave1NoOp.has(ep)) {
      state.noOpKnown++; state.noOpEps.push(ep);
      await logRow({ bot, ep, verdict: "NO-OP-KNOWN", detail: "no served intro; wave 1 confirmed 2x no opening (recap/special) — button correctly absent" });
      return;
    }
    await fixNoButton(bot, ep);
    return;
  }

  const { start, end } = intro;
  const clickTarget = Math.max(start, end - 3);
  const popAt = start - 1;

  // window + landing sanity (the two mission criteria, data level)
  if (!(end > start) || clickTarget < start || clickTarget >= end) {
    state.badData++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "BAD-DATA", detail: `inverted/clamped landing: start=${start} end=${end} click=${clickTarget}`, source });
    return;
  }

  // 3+4. STREAM truth — duration covers the OP, click segment serves bytes
  const plan = await loadStreamPlan(resolved.src);
  if (!plan) { state.streamFail++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "STREAM-FAIL", detail: "sub playlist unreachable", source }); return; }
  if (end > plan.duration + 0.5) {
    state.badData++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "BAD-DATA", detail: `intro end ${end} beyond stream duration ${plan.duration.toFixed(0)}`, source });
    return;
  }
  const clickSeg = plan.segmentAt(clickTarget);
  if (!clickSeg) { state.badData++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "BAD-DATA", detail: `seek target ${clickTarget.toFixed(1)}s has no segment`, source }); return; }
  if (!(await segmentHasBytes(clickSeg.url))) {
    state.streamFail++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "STREAM-FAIL", detail: `segment at click target ${clickTarget.toFixed(1)}s serves no bytes`, source });
    return;
  }

  // 5. ENCODE truth — the definitive test: opening still playing at the click
  const enc = await watchEncode(ep);
  if (!enc) {
    state.inconclusive++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "INCONCLUSIVE", detail: `encode unwatchable (starve/CDN) — click math OK: pop ${popAt}s -> ${clickTarget.toFixed(1)}s`, source });
    return;
  }
  const c = clickLandsInOpening(enc.env, start, end);
  if (!c.decisive) {
    state.inconclusive++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "INCONCLUSIVE", detail: c.why, source });
    return;
  }
  if (c.ok) {
    state.certified++;
    await logRow({
      bot, ep, verdict: "CERTIFIED", intro, source, popAt, clickTarget,
      loudFrac: +c.frac.toFixed(2), duration: +plan.duration.toFixed(0),
      detail: `button pops at ${popAt}s (opening arrives) -> click lands ${clickTarget.toFixed(1)}s — ${c.why}, last 3s of the opening still playing`,
    });
    return;
  }

  // 6. FIX — click lands outside the opening: the served end is wrong.
  const wall = enc.wall;
  if (!wall || wall.end <= wall.start) {
    state.badData++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "FIX-NO-WALL", detail: `${c.why} but scanner found no usable wall to fix with`, source });
    return;
  }
  const posted = await reportFindings(bot, [{ malId: MAL, ep, status: "ok", start: wall.start, end: wall.end, quality: 0.9, detail: `op-half2 fix: served end ${end} not loud at click (${c.why}); measured wall ${wall.start.toFixed(1)}-${wall.end.toFixed(1)}` }]);
  if (!posted) { state.fixFailed++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "FIX-POST-FAIL", detail: "scout API rejected the measured wall" }); return; }
  await sleep(65_000); // scout cache turnover

  const now = await resolveSubStream(ep);
  const nowIntro = now?.skip?.intro;
  if (!nowIntro) { state.fixFailed++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "FIX-STILL-BAD", detail: `after fix: no intro served` }); return; }
  const nowEnc = enc; // same encode — the audio did not change
  const nowC = clickLandsInOpening(nowEnc.env, nowIntro.start, nowIntro.end);
  if (nowC.decisive && nowC.ok) {
    state.fixed++; state.fixedEps.push(ep);
    await logRow({ bot, ep, verdict: "FIXED", intro: nowIntro, source: now?.skip?.source, popAt: nowIntro.start - 1, clickTarget: Math.max(nowIntro.start, nowIntro.end - 3), loudFrac: +nowC.frac.toFixed(2), detail: `fix verified: ${nowC.why} (served ${nowIntro.start.toFixed(0)}-${nowIntro.end.toFixed(0)} now)` });
  } else {
    state.fixFailed++; state.failEps.push(ep);
    await logRow({ bot, ep, verdict: "FIX-STILL-BAD", detail: `after fix: ${nowIntro.start.toFixed(0)}-${nowIntro.end.toFixed(0)} ${nowC.decisive ? nowC.why : "no decisive audio"}` });
  }
}

/** no served intro: pair-measure the opening, POST it, re-verify */
async function fixNoButton(bot, ep) {
  fixing.add(ep);
  try {
    const partner = ep + 1 <= TO_EP ? ep + 1 : ep - 1;
    const r = await measurePair(bot, ep, partner);
    if (!r.ok) {
      const strikes = (fixStrikes.get(ep) ?? 0) + 1;
      fixStrikes.set(ep, strikes);
      if (strikes >= 2) {
        noOpSet.add(ep); state.noOp++;
        state.noButton = Math.max(0, state.noButton);
        await logRow({ bot, ep, verdict: "NO-OP-CONFIRMED", detail: `2 partner pairs failed to align (${r.why}) — episode likely has no opening; button correctly absent` });
      } else {
        await logRow({ bot, ep, verdict: "PAIR-RETRY", detail: `pair ${ep}+${partner}: ${r.why}` });
        await runEpisode(bot, ep); // one retry with (effectively) a different partner draw
      }
      return;
    }
    const findings = [{ malId: MAL, ep, status: "ok", start: r.A.start, end: r.A.end, quality: r.A.quality, detail: `op-half2 pair ${ep}+${partner} (measured on our sub encode)` }];
    const posted = await reportFindings(bot, findings);
    if (!posted) { state.noButton++; state.failEps.push(ep); await logRow({ bot, ep, verdict: "FIX-POST-FAIL", detail: "scout API rejected pair measurement" }); return; }
    await sleep(65_000);
    const now = await resolveSubStream(ep);
    const nowIntro = now?.skip?.intro;
    if (nowIntro) {
      state.fixed++; state.fixedEps.push(ep);
      await logRow({ bot, ep, verdict: "FIXED", intro: nowIntro, source: now?.skip?.source, popAt: nowIntro.start - 1, clickTarget: Math.max(nowIntro.start, nowIntro.end - 3), detail: `pair-measured ${r.A.start.toFixed(1)}-${r.A.end.toFixed(1)} (q=${r.A.quality.toFixed(2)}) -> button now served` });
    } else {
      state.noButton++; state.failEps.push(ep);
      await logRow({ bot, ep, verdict: "FIX-STILL-BAD", detail: "measured + posted but intro still not served" });
    }
  } finally {
    fixing.delete(ep);
    snapshot();
  }
}

/* ---------------- lanes ---------------- */

let cursor = FROM_EP - 1;
async function lane(bot) {
  for (;;) {
    const ep = ++cursor;
    if (ep > TO_EP) return;
    state.entered++;
    state.lastEp = ep;
    try {
      await runEpisode(bot, ep);
    } catch (e) {
      state.inconclusive++; state.failEps.push(ep);
      await logRow({ bot, ep, verdict: "LANE-ERROR", detail: String(e?.message ?? e).slice(0, 160) });
    }
    if (state.entered % 5 === 0) snapshot();
    // wave progress marker — halfway through THIS half
    if (!state.halfDone && state.entered >= Math.floor(totalWork / 2)) {
      state.halfDone = true;
      await logRow({ bot, ep, verdict: "WAVE-HALFWAY", detail: `${state.entered}/${totalWork} second-half episodes entered` });
      console.log(`[half2] *** WAVE HALFWAY: ${state.entered}/${totalWork} ***`);
    }
    await sleep(jitter(1_500));
  }
}

/* ---------------- boot ---------------- */

const db = new PrismaClient();
const wave1NoOp = new Set();

async function main() {
  // wave-1 confirmed no-OP episodes (2-strike) — honest no-button, don't re-measure
  try {
    const w1 = JSON.parse(await readFile(WAVE1_REPORT, "utf8"));
    for (const ep of w1.noOpEps ?? []) wave1NoOp.add(ep);
  } catch { /* optional input */ }

  totalWork = TO_EP - FROM_EP + 1;
  state.total = totalWork;
  console.log(`[half2] ONE PIECE sub HALF-2 army deployed: ${LANES} lanes, eps ${FROM_EP}..${TO_EP} (${totalWork}), ${wave1NoOp.size} known no-OP eps pre-loaded`);
  await logRow({ verdict: "WAVE-START", from: FROM_EP, to: TO_EP, lanes: LANES, knownNoOp: wave1NoOp.size });
  await snapshot();

  const lanes = [];
  for (let i = 1; i <= LANES; i++) lanes.push(lane(`op-half2-${i}`));
  const heart = setInterval(() => snapshot(), 5_000);
  await Promise.all(lanes);
  clearInterval(heart);

  // drain in-flight fixes
  for (let i = 0; i < 60 && fixPending(); i++) await sleep(5_000);
  state.done = true;
  await snapshot();

  const report = {
    campaign: "One Piece sub Skip Intro — SECOND HALF (wave 3)",
    mission: "eps 589..1176: button pops when the opening arrives, click keeps the last 3s of the opening playing",
    startedAt: state.startedAt, finishedAt: new Date().toISOString(),
    from: FROM_EP, to: TO_EP, total: totalWork, entered: state.entered,
    certified: state.certified, fixed: state.fixed, fixFailed: state.fixFailed,
    noOp: state.noOp, noOpKnown: state.noOpKnown,
    noButton: state.noButton, badData: state.badData, streamFail: state.streamFail,
    resolveFail: state.resolveFail, inconclusive: state.inconclusive,
    goodTotal: state.certified + state.fixed + state.noOp + state.noOpKnown,
    failEps: [...new Set(state.failEps)].sort((a, b) => a - b),
    fixedEps: [...new Set(state.fixedEps)].sort((a, b) => a - b),
    noOpEps: [...new Set(state.noOpEps)].sort((a, b) => a - b),
  };
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log("[half2] WAVE COMPLETE");
  console.log(JSON.stringify(report, null, 2));
  await logRow({ verdict: "WAVE-COMPLETE", ...report });
  await db.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[half2] fatal:", e);
  state.done = true;
  await snapshot();
  process.exit(1);
});
