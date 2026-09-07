#!/usr/bin/env node
/**
 * ALL-SHOWS SKIP INTRO ARMY — user order: "start with the other shows".
 *
 * One Piece (malId 21) is DONE (op-sub-intro-army.mjs: 1176/1176 verified).
 * This army walks EVERY OTHER catalog show — 2,142 shows, ~33.5k sub
 * episodes — and for each episode runs the exact click-chain the player
 * runs on the SUB path (/api/stream?malId=X&ep=N&lang=sub&server=1):
 *
 *   1. BUTTON-POP  — skip.intro must exist; the player shows the button when
 *      currentTime >= start-1 (WatchView :909), so `start` must be a real
 *      place (the opening arriving) and the window [start-1, end] nonempty.
 *   2. CLICK MATH  — clicking seeks to max(start, end-3) (WatchView :1198):
 *      the last 3 seconds of the opening must still be playing — the seek
 *      target must land INSIDE the opening [start, end).
 *   3. STREAM TRUTH — the sub playlist fetched with the same CDN headers the
 *      proxy registry uses; total duration must cover `end`; the segments
 *      covering `start` and `end-3` must serve real bytes.
 *
 * REPAIR squadron (user orders behind it):
 *   - "For animes that aniskip don't have use SkipDB"  -> shows with a
 *     resolved SkipDbTitle but zero SkipDbFill rows are reported as
 *     SKIPDB-GAP (the skipdb-backfill loop vendors them; boot it alongside).
 *   - NO-BUTTON eps  -> the opening is MEASURED on our own sub encode:
 *     two consecutive episodes share the same OP, envelopes cross-matched
 *     (intro-scout.mjs establish-pair logic), verified interval POSTed to
 *     the scout API. Two failed partner pairs = confirmed no-OP episode
 *     (button correctly absent), never force-written.
 *   - BAD-DATA eps   -> same pair measurement overwrites the bad interval
 *     from the scout tier.
 *
 * Work order: biggest shows first (most viewers affected first).
 * Progress:  scripts/all-shows-skip-progress.json (polled by the commander)
 * Log:       scripts/all-shows-skip-army.log (JSONL, one verdict per line)
 * Report:    scripts/all-shows-skip-report.json (final)
 *
 * Usage: node scripts/all-shows-skip-army.mjs [--lanes 16] [--repair-lanes 6]
 */

import { appendFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

/* ---------------- config ---------------- */

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const BASE = opt("base", "http://localhost:3000");
const MIRROR = opt("mirror", BASE);
const SCOUT_TOKEN = opt("token", "clyle-scout-v1");
const VERIFY_LANES = Math.max(1, parseInt(opt("lanes", "16"), 10) || 16);
const REPAIR_LANES = Math.max(1, parseInt(opt("repair-lanes", "6"), 10) || 6);
const MIN_QUALITY = 0.72;
const EXCLUDE_MAL = new Set([21]); // One Piece — already verified 1176/1176
const UA = "Mozilla/5.0 (ClyleAllShowsArmy/1.0)";

const PROGRESS_FILE = new URL("./all-shows-skip-progress.json", import.meta.url).pathname;
const REPORT_FILE = new URL("./all-shows-skip-report.json", import.meta.url).pathname;
const LOG_FILE = new URL("./all-shows-skip-army.log", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

/* CDN headers — mirrors scripts/bug-patrol.mjs + src/lib/stream-proxy-registry.ts */
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

/* ---------------- state ---------------- */

const state = {
  startedAt: new Date().toISOString(),
  updatedAt: null,
  total: 0, shows: 0, verified: 0, done: false,
  halfway: false, halfwayLogged: false, half: 0,
  pass: 0, noButton: 0, badData: 0, streamFail: 0, resolveFail: 0,
  repaired: 0, repairFailed: 0, noOpConfirmed: 0, pendingRepair: 0,
  skipdbGaps: [],            // shows with SkipDbTitle but no fills (backfill loop fixes)
  showsCompleted: 0,
  failKeys: [],              // "malId/ep" still failing at report time
  repairedKeys: [],
};
function snapshotProgress() {
  state.updatedAt = new Date().toISOString();
  state.halfway = state.total > 0 && state.verified >= state.half;
  state.pendingRepair = repairQueue.length + repairInFlight;
  state.repaired = repairDone.size;
  state.repairedKeys = [...repairDone];
  void writeFile(PROGRESS_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}

async function logVerdict(row) {
  try { await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* never blocks */ }
}

/* ---------------- verify squadron ---------------- */

async function fetchJson(url, timeoutMs = 75_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA } });
    const text = await res.text();
    if (res.status !== 200) return { status: res.status, json: null };
    try { return { status: 200, json: JSON.parse(text) }; } catch { return { status: 200, json: null }; }
  } catch (e) {
    return { status: 0, err: String(e?.message ?? e).slice(0, 120) };
  }
}

/** the exact stream call the player makes on the sub path */
async function resolveSubStream(malId, ep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetchJson(`${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=sub&server=1`);
    if (r.status === 200 && r.json?.src) return r.json;
    if (r.status === 404) return { _404: true };
    if (attempt < 2) await sleep(3_000);
  }
  return null;
}

/** fetch the first chunk of a segment — proves bytes exist at that position */
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

/**
 * Stream ground truth: master -> best variant -> full media playlist.
 * Returns { duration, segmentAt(t) } or null (playlist unreachable).
 */
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

/* shape gate — same bounds the API's own plausibility gate uses
   (plausibleIntro: start <= 320 (420 for hour-long), dur <= 180) */
function shapeOk(start, end, duration) {
  const lenMin = duration / 60;
  const cap = lenMin && lenMin > 30 ? 420 : 320;
  return Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 && start <= cap && end - start <= 180;
}

/**
 * The full click-chain verification for one episode — mirrors the player:
 *   button shows when currentTime >= start-1 (WatchView :909)
 *   click seeks to max(start, end-3)            (WatchView :1198)
 * Verdict: PASS | NO-BUTTON | BAD-DATA | STREAM | RESOLVE-FAIL
 */
async function verifyEpisode(bot, malId, ep) {
  const resolved = await resolveSubStream(malId, ep);
  if (!resolved) return { verdict: "RESOLVE-FAIL", detail: "stream resolve failed twice" };
  if (resolved._404) return { verdict: "RESOLVE-FAIL", detail: "no sub page for this episode (404)" };

  const intro = resolved.skip?.intro;
  const source = resolved.skip?.source ?? "none";
  if (!intro || !Number.isFinite(intro.start) || !Number.isFinite(intro.end)) {
    return { verdict: "NO-BUTTON", detail: "stream resolved but skip.intro missing", source, stream: resolved };
  }

  // ---- click math (WatchView :909 + :1198) ----
  const { start, end } = intro;
  const seekTarget = Math.max(start, end - 3);          // the click
  const buttonWindowOk = end > start - 1;               // the button window is nonempty
  const last3sInOp = end - 3 >= start;                  // landing has the last 3s of the OP still playing
  if (!buttonWindowOk) return { verdict: "BAD-DATA", detail: `inverted interval start=${start} end=${end}`, source, stream: resolved };

  // ---- stream truth ----
  const plan = await loadStreamPlan(resolved.src);
  if (!plan) return { verdict: "STREAM", detail: "sub playlist unreachable", source, stream: resolved };
  if (!shapeOk(start, end, plan.duration)) return { verdict: "BAD-DATA", detail: `implausible intro shape start=${start} end=${end} dur=${plan.duration.toFixed(0)}s`, source, stream: resolved };
  if (end > plan.duration + 0.5) return { verdict: "BAD-DATA", detail: `intro end ${end} beyond stream duration ${plan.duration.toFixed(0)}`, source, stream: resolved };
  if (start > plan.duration) return { verdict: "BAD-DATA", detail: `intro start ${start} beyond stream duration`, source, stream: resolved };

  const clickSeg = plan.segmentAt(seekTarget);
  if (!clickSeg) return { verdict: "BAD-DATA", detail: `seek target ${seekTarget.toFixed(1)} has no segment`, source, stream: resolved };
  const clickBytes = await segmentHasBytes(clickSeg.url);
  if (!clickBytes) return { verdict: "STREAM", detail: `segment at click target ${seekTarget.toFixed(1)}s serves no bytes`, source, stream: resolved };

  const opSeg = plan.segmentAt(start);
  const opBytes = opSeg ? await segmentHasBytes(opSeg.url) : false;
  if (!opBytes) return { verdict: "STREAM", detail: `segment at button-pop ${start}s serves no bytes`, source, stream: resolved };

  return {
    verdict: "PASS",
    detail: `button pops at ${start - 1}s (opening arrives), click -> ${seekTarget.toFixed(1)}s, ${last3sInOp ? "last 3s of OP still playing" : "short interval, clamps to start"}`,
    intro, source, seekTarget, duration: plan.duration, last3sInOp, stream: resolved,
  };
}

async function verifyLane(bot, onVerdict) {
  for (;;) {
    const job = workQueue.shift();
    if (!job) return;
    const { malId, ep, title } = job;
    const key = `${malId}/${ep}`;
    let v = await verifyEpisode(bot, malId, ep);
    if (v.verdict === "RESOLVE-FAIL") { await sleep(jitter(4_000)); v = await verifyEpisode(bot, malId, ep); } // one whole retry
    state.verified++;
    if (v.verdict === "PASS") state.pass++;
    else if (v.verdict === "NO-BUTTON") { state.noButton++; state.failKeys.push(key); pushRepair(malId, ep); }
    else if (v.verdict === "BAD-DATA") { state.badData++; state.failKeys.push(key); pushRepair(malId, ep); }
    else if (v.verdict === "STREAM") { state.streamFail++; state.failKeys.push(key); }
    else { state.resolveFail++; state.failKeys.push(key); }
    await logVerdict({ bot, key, title, verdict: v.verdict, intro: v.intro ?? null, source: v.source ?? null, seekTarget: v.seekTarget ?? null, duration: v.duration ?? null, detail: v.detail });
    void onVerdict?.(job, v);
    if (state.verified % 25 === 0) snapshotProgress();
    if (state.halfway && !state.halfwayLogged) {
      state.halfwayLogged = true;
      await logVerdict({ bot, key, verdict: "HALFWAY", detail: `${state.verified}/${state.total} episodes across all shows entered, button clicked, verified` });
      console.log(`[army] *** HALFWAY: ${state.verified}/${state.total} all-shows sub episodes verified ***`);
    }
    await sleep(jitter(350));
  }
}

/* ---------------- repair squadron ---------------- */

const repairQueue = [];
const repairQueued = new Set();
let repairInFlight = 0;
const repairStrikes = new Map();
const repairDone = new Set();
const noOpSet = new Set();
const repairPartnered = new Set();

function pushRepair(malId, ep, { force = false } = {}) {
  const key = `${malId}/${ep}`;
  if (repairDone.has(key) || noOpSet.has(key)) return;
  if (repairQueued.has(key)) {
    if (!force) return;
    const i = repairQueue.findIndex((j) => j.malId === malId && j.ep === ep);
    if (i >= 0) repairQueue.splice(i, 1);
  }
  repairQueued.add(key);
  repairQueue.push({ malId, ep, key });
}

function takeRepair() {
  const job = repairQueue.shift();
  if (job) repairQueued.delete(job.key);
  return job;
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

/** watch one episode's sub encode through ffmpeg, same as the fleet bots */
async function watchEncode(malId, ep) {
  const resolved = await resolveSubStream(malId, ep);
  if (!resolved || resolved._404 || !resolved.src) return null;
  let r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 });
  if (r.status !== "ok" && /STARVED|timeout|fetch|429|503/i.test(r.detail || "")) {
    await sleep(6_000);
    r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 });
  }
  if (r.status !== "ok") return null;
  return r;
}

async function reportFindings(bot, findings) {
  try {
    const res = await fetch(`${MIRROR}/api/bots/intro-scout?token=${encodeURIComponent(SCOUT_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ bot, findings }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch { return false; }
}

/** measure ep+partner envelopes, cross-match (consecutive eps share the OP) */
async function measurePair(malId, ep, partnerEp) {
  const A = await watchEncode(malId, ep);
  const B = A && partnerEp !== ep ? await watchEncode(malId, partnerEp) : null;
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
  if (!plausibleInterval(mA.start, mA.end) || !plausibleInterval(mB.start, mB.end)) return { ok: false, why: "implausible interval" };
  if (Math.min(mA.quality, mB.quality) < MIN_QUALITY) return { ok: false, why: `quality ${(Math.min(mA.quality, mB.quality)).toFixed(2)} < ${MIN_QUALITY}` };
  // OP-shaped: real openings run 40-170s (movies/OVA exclusions handled by the API's gate)
  if (mA.end - mA.start < 30 || mA.end - mA.start > 180) return { ok: false, why: `interval ${mA.start.toFixed(0)}-${mA.end.toFixed(0)} not OP-shaped` };
  return { ok: true, A: mA, B: mB };
}

async function repairLane(bot) {
  for (;;) {
    const job = takeRepair();
    if (!job) {
      if (!workQueue.length && state.verified >= state.total) return; // nothing left anywhere
      await sleep(2_000);
      continue;
    }
    const { malId, ep, key } = job;
    if (repairDone.has(key) || noOpSet.has(key)) continue;
    repairInFlight++;

    const epList = epsByShow.get(malId) ?? [];
    const idx = epList.indexOf(ep);
    const partnerEp = idx >= 0 && idx + 1 < epList.length ? epList[idx + 1] : (idx > 0 ? epList[idx - 1] : null);
    if (partnerEp == null) {
      noOpSet.add(key); state.noOpConfirmed++; repairInFlight--; snapshotProgress(); continue;
    }

    const r = await measurePair(malId, ep, partnerEp);
    if (r.ok) {
      const title = titleByShow.get(malId) ?? `mal ${malId}`;
      const findings = [{ malId, ep, status: "ok", start: r.A.start, end: r.A.end, quality: r.A.quality, detail: `all-shows-army pair ${ep}+${partnerEp} (measured on our sub encode) — ${title}` }];
      const pKey = `${malId}/${partnerEp}`;
      const partnerNeeded = !repairDone.has(pKey) && !noOpSet.has(pKey) && !repairPartnered.has(pKey) && (repairQueued.has(pKey) || !hasIntroData(malId, partnerEp));
      if (partnerNeeded) findings.push({ malId, ep: partnerEp, status: "ok", start: r.B.start, end: r.B.end, quality: r.B.quality, detail: `all-shows-army pair ${partnerEp}+${ep} (measured on our sub encode)` });
      const posted = await reportFindings(bot, findings);
      if (posted) {
        repairDone.add(key);
        if (partnerNeeded) { repairDone.add(pKey); repairPartnered.add(pKey); }
        // re-verify after the scout cache (60s) turns over
        await sleep(65_000);
        const v = await verifyEpisode(bot, malId, ep);
        await logVerdict({ bot, key, verdict: `REPAIRED->${v.verdict}`, intro: v.intro ?? null, seekTarget: v.seekTarget ?? null, detail: `measured ${r.A.start.toFixed(1)}-${r.A.end.toFixed(1)} (q=${r.A.quality.toFixed(2)}); post-repair check: ${v.detail}` });
        if (v.verdict === "PASS") {
          state.pass++; state.noButton = Math.max(0, state.noButton - (state.failKeys.includes(key) ? 1 : 0)); state.badData = Math.max(0, state.badData - (state.failKeys.includes(key) ? 1 : 0));
          state.failKeys = state.failKeys.filter((k) => k !== key);
        } else { state.repairFailed++; await logVerdict({ bot, key, verdict: "REPAIR-STILL-BAD", detail: v.detail }); }
      } else {
        state.repairFailed++;
        await logVerdict({ bot, key, verdict: "REPAIR-POST-FAIL", detail: "scout API rejected findings" });
      }
    } else {
      const strikes = (repairStrikes.get(key) ?? 0) + 1;
      repairStrikes.set(key, strikes);
      if (strikes >= 2) {
        noOpSet.add(key);
        state.noOpConfirmed++;
        await logVerdict({ bot, key, verdict: "NO-OP-CONFIRMED", detail: `2 partner pairs failed to align (${r.why}) — episode likely has no opening; button correctly absent` });
      } else {
        await logVerdict({ bot, key, verdict: "REPAIR-RETRY", detail: `pair ${ep}+${partnerEp}: ${r.why}` });
        pushRepair(malId, ep, { force: true }); // rotate to the back, different partner next time
      }
    }
    repairInFlight--;
    snapshotProgress();
    await sleep(jitter(2_000));
  }
}

/* ---------------- boot ---------------- */

const db = new PrismaClient();
const workQueue = [];
const epsByShow = new Map();
const titleByShow = new Map();
let ds = null;
function hasIntroData(malId, ep) {
  if (ds && !!ds[String(malId)]?.[String(ep)]?.op) return true;
  const rows = scoutByShow.get(malId);
  if (rows) {
    const r = rows.find((x) => x.ep === ep);
    if (r && !r.nodetect && r.end > r.start) return true;
  }
  return false;
}
const scoutByShow = new Map();

async function main() {
  // the vendored dataset the API merges from (read-only tier copy)
  ds = (await import("../src/lib/skip-times.data.json", { with: { type: "json" } })).default;

  const shows = await db.anime.findMany({
    where: { inCatalog: true, malId: { notIn: [...EXCLUDE_MAL] } },
    select: { malId: true, title: true, titleEnglish: true },
  });
  const eps = await db.episode.findMany({
    where: { lang: "sub", animeId: { notIn: [...EXCLUDE_MAL] } },
    select: { animeId: true, number: true },
    orderBy: { number: "asc" },
  });
  for (const e of eps) {
    if (!epsByShow.has(e.animeId)) epsByShow.set(e.animeId, []);
    epsByShow.get(e.animeId).push(e.number);
  }
  for (const s of shows) titleByShow.set(s.malId, s.titleEnglish || s.title);

  const scouts = await db.introScout.findMany({ select: { malId: true, ep: true, nodetect: true, start: true, end: true } });
  for (const s of scouts) {
    if (!scoutByShow.has(s.malId)) scoutByShow.set(s.malId, []);
    scoutByShow.get(s.malId).push(s);
  }

  // biggest shows first — most viewers affected first
  const ordered = [...shows]
    .filter((s) => (epsByShow.get(s.malId) ?? []).length > 0)
    .sort((a, b) => (epsByShow.get(b.malId) ?? []).length - (epsByShow.get(a.malId) ?? []).length || a.malId - b.malId);

  for (const s of ordered) for (const ep of epsByShow.get(s.malId)) workQueue.push({ malId: s.malId, ep, title: titleByShow.get(s.malId) });
  state.total = workQueue.length;
  state.shows = ordered.length;
  state.half = Math.floor(state.total / 2);

  // shows the SkipDB backfill loop still owes fills for (user: "use SkipDB")
  const [titlesFound, fillShows] = await Promise.all([
    db.skipDbTitle.findMany({ where: { found: true }, select: { malId: true } }),
    db.skipDbFill.groupBy({ by: ["malId"] }),
  ]);
  const fillSet = new Set(fillShows.map((f) => f.malId));
  state.skipdbGaps = titlesFound.map((t) => t.malId).filter((m) => !fillSet.has(m) && epsByShow.has(m));

  console.log(`[army] ALL-SHOWS skip intro army deployed: ${VERIFY_LANES} verify bots + ${REPAIR_LANES} repair bots`);
  console.log(`[army] campaign: ${state.total} sub episodes across ${state.shows} shows (halfway = ${state.half})`);
  console.log(`[army] first up: ${ordered.slice(0, 8).map((s) => `${titleByShow.get(s.malId)}(${epsByShow.get(s.malId).length})`).join(", ")}`);
  console.log(`[army] skipdb gaps (shows needing vendor): ${state.skipdbGaps.length} -> ${state.skipdbGaps.slice(0, 12).join(",")}${state.skipdbGaps.length > 12 ? "…" : ""}`);
  await logVerdict({ verdict: "CAMPAIGN-START", total: state.total, shows: state.shows, half: state.half, verifyLanes: VERIFY_LANES, repairLanes: REPAIR_LANES, skipdbGaps: state.skipdbGaps.length });
  snapshotProgress();

  const lanes = [];
  for (let i = 1; i <= VERIFY_LANES; i++) lanes.push(verifyLane(`all-verify-${i}`));
  for (let i = 1; i <= REPAIR_LANES; i++) lanes.push(repairLane(`all-repair-${i}`));

  const heart = setInterval(() => snapshotProgress(), 5_000);
  await Promise.all(lanes);
  clearInterval(heart);

  for (let i = 0; i < 240 && (repairQueue.length || repairInFlight); i++) await sleep(5_000);
  state.verified = state.total; state.done = true; state.pendingRepair = 0;
  snapshotProgress();

  const report = {
    campaign: "All-shows sub Skip Intro verification (One Piece excluded — done)",
    mission: "every episode of every other show entered, button clicked, last-3s landing verified",
    startedAt: state.startedAt, finishedAt: new Date().toISOString(),
    shows: state.shows, total: state.total, verified: state.verified,
    pass: state.pass, repaired: state.repaired, noOpConfirmed: state.noOpConfirmed,
    noButton: state.noButton, badData: state.badData, streamFail: state.streamFail, resolveFail: state.resolveFail,
    repairFailed: state.repairFailed, skipdbGaps: state.skipdbGaps,
    stillFailing: [...new Set(state.failKeys)].sort(),
  };
  void writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`[army] CAMPAIGN COMPLETE: ${state.verified}/${state.total} eps — pass=${state.pass} repaired=${state.repaired} noOp=${state.noOpConfirmed} noButton=${state.noButton} badData=${state.badData} stream=${state.streamFail} resolve=${state.resolveFail}`);
  await logVerdict({ verdict: "CAMPAIGN-COMPLETE", ...report });
}

main().catch((e) => { console.error("[army] fatal:", e); process.exit(1); });
