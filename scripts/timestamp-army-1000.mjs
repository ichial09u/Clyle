/**
 * TIMESTAMP SCOUT ARMY — the 1,000-bot skip-timestamp campaign.
 *
 * User: "look for other animes for their right skip timestamp just like you
 * did for one piece we might need 1000 bots or 500 for this job"
 *
 * One Piece got a dedicated measurement fleet (op-sub-intro-army); this army
 * gives EVERY other show the same treatment: bots watch each episode's sub
 * encode through the same envelope analyzer the One Piece bots used, measure
 * the real opening interval on OUR streams (not vendor guesses), and POST
 * findings to /api/bots/intro-scout (same storage the whole fleet shares).
 *
 * WORK QUEUE (priority order, all built from the DB at boot):
 *   P0 REPAIR   — episodes whose wave-1 verdict was NOT PASS (from
 *                 scripts/all-shows-skip-army.log) — wrong/missing buttons
 *   P1 GAP      — episodes with NO timestamp from ANY source
 *                 (IntroScout ∪ AniSkip static ∪ SkipDbFill)
 *   P2 WEAK     — IntroScout rows with quality < 0.72 or < 2 agreeing bots
 *                 (re-measure to confirm or replace)
 * Movies are excluded (no opening to find).
 *
 * FLEET SHAPE ("1000 bots"): roster tsa-0001..tsa-1000, each measured job is
 * assigned to the next bot in the roster (recorded in ScoutFinding.bot).
 * SIMULTANEOUS lanes are rate-governed 32..96 (providers 429/403 beyond
 * that) — the roster cycles through as jobs consume.
 *
 *   node scripts/timestamp-army-1000.mjs [--minutes 600] [--lanes 48]
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const db = new PrismaClient();
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const BASE = opt("base", "http://localhost:3000");
const SCOUT_TOKEN = opt("token", "clyle-scout-v1");
const MINUTES = parseInt(opt("minutes", "0"), 10) || 0;
const LANES_START = Math.max(8, parseInt(opt("lanes", "48"), 10) || 48);
const LANES_MIN = Math.max(4, parseInt(opt("lanes-min", "16"), 10) || 16);
const LANES_MAX = Math.max(LANES_START, parseInt(opt("lanes-max", "96"), 10) || 96);
const MIN_QUALITY = 0.72;
const ROSTER = Math.max(1, parseInt(opt("bots", "1000"), 10) || 1000);
const UA = "Mozilla/5.0 (ClyleTimestampArmy/1.0)";
const EXCLUDE_MAL = new Set([21]); // One Piece — done by its own dedicated army; user: "other animes"

const PROGRESS_FILE = new URL("./timestamp-army-progress.json", import.meta.url).pathname;
const REPORT_FILE = new URL("./timestamp-army-report.json", import.meta.url).pathname;
const LOG_FILE = new URL("./timestamp-army.log", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = MINUTES > 0 ? Date.now() + MINUTES * 60_000 : Infinity;

/* ---------------- state ---------------- */
const state = {
  startedAt: new Date().toISOString(), updatedAt: null,
  queue: { repair: 0, gap: 0, weak: 0 }, total: 0,
  done: 0, ok: 0, noop: 0, resolveFail: 0, fail: 0,
  repaired: 0, halfway: false, halfwayLogged: false,
  lanes: LANES_START, botsEmployed: 0, showsStruck: 0,
  recentResults: [], // rolling window for the governor: "ok" | "fail" | "rate"
};
function snapshotProgress() {
  state.updatedAt = new Date().toISOString();
  if (state.total > 0) state.halfway = state.done >= state.total / 2;
  void writeFile(PROGRESS_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}
async function logVerdict(row) {
  try { await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* never blocks */ }
}

/* ---------------- CDN headers (mirror the army + registry) ---------------- */
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

/* ---------------- stream + measurement (army recipe) ---------------- */
async function fetchJson(url, timeoutMs = 75_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, err: String(e).slice(0, 80) };
  }
}

/* resolve semaphore — protects zoko from our own lane count; segment
   analysis hits the CDN directly and stays wide, only /api/stream funnels */
const RESOLVE_MAX = 6;
let resolveLive = 0;
const resolveWaiters = [];
async function withResolveSlot(fn) {
  if (resolveLive >= RESOLVE_MAX) {
    await new Promise((res) => resolveWaiters.push(res));
  }
  resolveLive++;
  try {
    return await fn();
  } finally {
    resolveLive--;
    const w = resolveWaiters.shift();
    if (w) w();
  }
}

async function resolveSubStream(malId, ep) {
  return withResolveSlot(async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await fetchJson(`${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=sub&server=1`);
      if (r.status === 200 && r.json?.src) return r.json;
      if (r.status === 404) return { _404: true };
      if (attempt < 2) await sleep(3_000);
    }
    return null; // transient (rate/timeout) — NOT a definitive no-stream
  });
}

const encodeCache = new Map();
async function watchEncode(malId, ep) {
  const k = `${malId}/${ep}`;
  const hit = encodeCache.get(k);
  if (hit) return hit;
  const resolved = await resolveSubStream(malId, ep);
  if (!resolved || resolved._404 || !resolved.src) return null;
  let r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 });
  if (r.status !== "ok" && /STARVED|timeout|fetch|429|503/i.test(r.detail || "")) {
    await sleep(6_000);
    r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 });
  }
  if (r.status !== "ok") return null;
  encodeCache.set(k, r);
  if (encodeCache.size > 240) encodeCache.delete(encodeCache.keys().next().value);
  return r;
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
  if (!mA || !mB) return { ok: false, why: "no cross-alignment (pair)", partial: A };
  if (!plausibleInterval(mA.start, mA.end) || !plausibleInterval(mB.start, mB.end)) return { ok: false, why: "implausible interval" };
  if (Math.min(mA.quality, mB.quality) < MIN_QUALITY) return { ok: false, why: `quality ${Math.min(mA.quality, mB.quality).toFixed(2)} < ${MIN_QUALITY}` };
  if (mA.end - mA.start < 30 || mA.end - mA.start > 180) return { ok: false, why: `interval ${mA.start.toFixed(0)}-${mA.end.toFixed(0)} not OP-shaped` };
  return { ok: true, A: mA, B: mB };
}

/* ---------------- work queue ---------------- */
const workQueue = [];
const queued = new Set();
let queueCursor = 0;

function pushJob(malId, ep, title, pri, partnerEp) {
  const key = `${malId}/${ep}`;
  if (queued.has(key)) return;
  queued.add(key);
  workQueue.push({ malId, ep, title, pri, partnerEp });
}

async function buildQueue() {
  console.log("[tsa] building work queue from DB …");
  const animes = await db.anime.findMany({
    where: { inCatalog: true, NOT: { type: "Movie" } },
    select: { malId: true, title: true, popularity: true, totalEpisodes: true },
    orderBy: { popularity: "desc" },
  });
  const animeById = new Map(animes.map((a) => [a.malId, a]));
  const eps = await db.episode.findMany({ select: { animeId: true, number: true }, orderBy: { number: "asc" } });
  const epsByShow = new Map();
  for (const e of eps) {
    if (EXCLUDE_MAL.has(e.animeId)) continue;
    if (!epsByShow.has(e.animeId)) epsByShow.set(e.animeId, []);
    epsByShow.get(e.animeId).push(e.number);
  }

  // coverage union
  const covered = new Set();
  const noopConfirmed = new Set();
  const scouts = await db.introScout.findMany({ select: { malId: true, ep: true, nodetect: true, quality: true, bots: true } });
  for (const s of scouts) {
    covered.add(`${s.malId}/${s.ep}`);
    if (s.nodetect) noopConfirmed.add(`${s.malId}/${s.ep}`);
  }
  const fills = await db.skipDbFill.findMany({ select: { malId: true, ep: true } });
  for (const f of fills) covered.add(`${f.malId}/${f.ep}`);
  let staticCovered = 0;
  try {
    const raw = JSON.parse(await readFile(new URL("../src/lib/skip-times.data.json", import.meta.url), "utf8"));
    for (const [malId, perEp] of Object.entries(raw)) {
      for (const ep of Object.keys(perEp)) {
        covered.add(`${Number(malId)}/${Number(ep)}`);
        staticCovered++;
      }
    }
  } catch { /* static dataset missing — scout covers */ }

  // P0 — wave-1 non-PASS verdicts
  let p0 = 0;
  try {
    const raw = await readFile(new URL("./all-shows-skip-army.log", import.meta.url), "utf8");
    const latest = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (!j.verdict || j.malId == null || j.ep == null) continue;
        latest.set(`${j.malId}/${j.ep}`, { verdict: j.verdict, malId: j.malId, ep: j.ep });
      } catch { /* partial line */ }
    }
    for (const [key, v] of latest) {
      if (v.verdict === "PASS") continue;
      if (covered.has(key)) continue; // repaired since wave-1
      const a = animeById.get(v.malId);
      if (!a) continue;
      const list = epsByShow.get(v.malId) ?? [];
      const idx = list.indexOf(v.ep);
      const partner = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : idx > 0 ? list[idx - 1] : null;
      if (partner == null) continue;
      pushJob(v.malId, v.ep, a.title, 0, partner);
      p0++;
    }
  } catch { /* no wave-1 log */ }

  // P1 — gap episodes (no source covers them); partner = neighbor
  let p1 = 0;
  for (const [malId, list] of epsByShow) {
    const a = animeById.get(malId);
    if (!a) continue;
    for (let i = 0; i < list.length; i++) {
      const ep = list[i];
      const key = `${malId}/${ep}`;
      if (covered.has(key) || noopConfirmed.has(key)) continue;
      const partner = i + 1 < list.length ? list[i + 1] : i > 0 ? list[i - 1] : null;
      if (partner == null) continue;
      pushJob(malId, ep, a.title, 1, partner);
      p1++;
    }
  }

  // P2 — weak scout rows (low quality / single-bot agreement)
  let p2 = 0;
  for (const s of scouts) {
    if (s.nodetect) continue;
    if (EXCLUDE_MAL.has(s.malId)) continue;
    if ((s.quality ?? 1) >= MIN_QUALITY && (s.bots ?? 1) >= 2) continue;
    const a = animeById.get(s.malId);
    if (!a) continue;
    const list = epsByShow.get(s.malId) ?? [];
    const idx = list.indexOf(s.ep);
    const partner = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : idx > 0 ? list[idx - 1] : null;
    if (partner == null) continue;
    pushJob(s.malId, s.ep, a.title, 2, partner);
    p2++;
  }

  state.queue = { repair: p0, gap: p1, weak: p2 };
  state.total = workQueue.length;
  // remaining-queue count per show — the strike rule spares big shows
  for (const j of workQueue) showQueued.set(j.malId, (showQueued.get(j.malId) ?? 0) + 1);
  console.log(`[tsa] queue: P0 repair=${p0}  P1 gap=${p1}  P2 weak=${p2}  (total ${workQueue.length}; staticCovered=${staticCovered}, scoutRows=${scouts.length}, fillRows=${fills.length})`);
}

/* ---------------- 1,000-bot roster ---------------- */
let rosterCursor = 0;
function nextBot() {
  const n = (rosterCursor % ROSTER) + 1;
  rosterCursor++;
  state.botsEmployed = Math.max(state.botsEmployed, rosterCursor);
  return `tsa-${String(n).padStart(4, "0")}`;
}

/* ---------------- governor ---------------- */
function noteResult(kind) {
  state.recentResults.push(kind);
  if (state.recentResults.length > 120) state.recentResults.shift();
}
function governorTick() {
  const w = state.recentResults;
  if (w.length < 30) return;
  const rate = w.filter((r) => r === "rate").length / w.length;
  const fail = w.filter((r) => r === "fail").length / w.length;
  let lanes = state.lanes;
  if (rate > 0.2 || fail > 0.35) lanes = Math.max(LANES_MIN, Math.floor(lanes * 0.75));
  else if (rate < 0.03 && fail < 0.12) lanes = Math.min(LANES_MAX, lanes + 4);
  if (lanes !== state.lanes) {
    state.lanes = lanes;
    console.log(`[tsa] governor: lanes -> ${lanes} (rate ${(rate * 100).toFixed(0)}%, fail ${(fail * 100).toFixed(0)}%)`);
  }
}

/* ---------------- lanes ---------------- */
const strikes = new Map(); // malId -> consecutive pair-fails
const struckShows = new Set();
const showQueued = new Map(); // malId -> jobs queued for this show (set in buildQueue)

async function workLane(laneId) {
  await sleep(laneId * 1_500); // staggered start — no thundering herd at boot
  for (;;) {
    if (Date.now() > DEADLINE) return;
    if (queueCursor >= workQueue.length) return;
    const liveLanes = state.lanes;
    if (laneId > liveLanes) { await sleep(15_000); continue; } // governor shrank the fleet — this bot idles
    const job = workQueue[queueCursor++];
    if (!job) return;
    const key = `${job.malId}/${job.ep}`;
    if (struckShows.has(job.malId)) { state.noop++; state.done++; continue; }
    const bot = nextBot();

    const r = await measurePair(job.malId, job.ep, job.partnerEp);
    if (!r.ok && /analyze failed/.test(r.why || "")) {
      // classify: definitive provider-404 (nothing to measure, not strike-worthy)
      // vs transient resolution trouble (job retries later — never burned)
      const probe = await resolveSubStream(job.malId, job.ep);
      if (probe && probe._404) {
        state.resolveFail++;
        state.done++;
        noteResult("fail");
        logVerdict({ verdict: "RESOLVE-FAIL", bot, malId: job.malId, ep: job.ep, why: "no stream (provider 404)", title: job.title }).then();
        continue;
      }
      if (!probe) {
        // transient (rate/timeout) — defer up to TWICE (outage windows happen),
        // then log and move on (a later campaign re-run re-queues unmeasured eps)
        const tries = (job._retried ?? 0) + 1;
        if (tries <= 2) {
          job._retried = tries;
          workQueue.push(job);
          state.total++;
          noteResult("rate");
          logVerdict({ verdict: "DEFERRED", bot, malId: job.malId, ep: job.ep, why: `transient resolve trouble (defer ${tries}) — requeued`, title: job.title }).then();
          continue;
        }
        state.fail++;
        state.done++;
        noteResult("rate");
        logVerdict({ verdict: "RESOLVE-UNSURE", bot, malId: job.malId, ep: job.ep, why: "still transient after 2 defers", title: job.title }).then();
        continue;
      }
      // probe resolved fine — reachable encode the analyzer starved on: strike-worthy
    }
    if (r.ok) {
      const findings = [
        { malId: job.malId, ep: job.ep, status: "ok", start: r.A.start, end: r.A.end, quality: r.A.quality, detail: `tsa pair ${job.ep}+${job.partnerEp} (measured on our sub encode) — ${job.title}` },
        { malId: job.malId, ep: job.partnerEp, status: "ok", start: r.B.start, end: r.B.end, quality: r.B.quality, detail: `tsa pair partner of ${job.ep} — ${job.title}` },
      ];
      const okPost = await reportFindings(bot, findings);
      strikes.set(job.malId, 0);
      state.ok += okPost ? 2 : 0;
      state.done += 1;
      noteResult("ok");
      logVerdict({ verdict: "PASS", bot, malId: job.malId, ep: job.ep, start: +r.A.start.toFixed(1), end: +r.A.end.toFixed(1), quality: +r.A.quality.toFixed(2), title: job.title }).then();
    } else {
      if (/429|503|STARVED|timeout|fetch/i.test(r.why || "")) noteResult("rate");
      else noteResult("fail");
      // resolve-less episodes: partner stream also missing → provider 404 territory
      const s = (strikes.get(job.malId) ?? 0) + 1;
      strikes.set(job.malId, s);
      state.fail++;
      state.done++;
      logVerdict({ verdict: "PAIR-FAIL", bot, malId: job.malId, ep: job.ep, why: r.why, title: job.title }).then();
      if (s >= 3) {
        // 3 consecutive fails on this show — likely a genuinely OP-less encode.
        // Small shows: wipe the remaining queue (stop burning lanes). Big shows
        // (>60 queued): keep trying — one bad arc shouldn't wipe 1000 eps.
        const remaining = showQueued.get(job.malId) ?? 0;
        if (remaining <= 60) {
          struckShows.add(job.malId);
          state.showsStruck++;
        } else {
          strikes.set(job.malId, 2); // sticky near-threshold, keeps measuring
        }
      }
    }
    if (state.done % 25 === 0) {
      snapshotProgress();
      const rate = state.done ? ((state.ok / state.done) * 100).toFixed(1) : "0";
      console.log(`[tsa] ${state.done}/${state.total} (${rate}% ok) lanes=${state.lanes} ok=${state.ok} fail=${state.fail} struck=${state.showsStruck} shows`);
    }
    if (state.halfway && !state.halfwayLogged) {
      state.halfwayLogged = true;
      snapshotProgress();
      console.log(`[tsa] *** HALFWAY *** ${state.done}/${state.total} — ok=${state.ok} fail=${state.fail} struck=${state.showsStruck} shows`);
      await logVerdict({ verdict: "HALFWAY", done: state.done, total: state.total, ok: state.ok });
    }
    await sleep(150); // pacing between jobs per lane
  }
}

/* ---------------- main ---------------- */
async function main() {
  await buildQueue();
  snapshotProgress();
  console.log(`[tsa] TIMESTAMP ARMY deployed: roster ${ROSTER} bots, lanes ${LANES_START} (gov ${LANES_MIN}..${LANES_MAX}), queue ${state.total}`);
  await logVerdict({ verdict: "CAMPAIGN-START", total: state.total, repair: state.queue.repair, gap: state.queue.gap, weak: state.queue.weak, lanes: LANES_START, roster: ROSTER });

  const governor = setInterval(() => { governorTick(); snapshotProgress(); }, 20_000);
  const lanes = Array.from({ length: LANES_MAX }, (_, i) => workLane(i + 1));
  await Promise.all(lanes);
  clearInterval(governor);

  state.doneAt = new Date().toISOString();
  snapshotProgress();
  const report = {
    campaign: "timestamp-army-1000",
    startedAt: state.startedAt, finishedAt: state.doneAt,
    queue: state.queue, total: state.total, done: state.done,
    ok: state.ok, noop: state.noop, resolveFail: state.resolveFail, fail: state.fail,
    showsStruck: state.showsStruck, botsEmployed: state.botsEmployed,
    okRate: state.done ? +(state.ok / state.done * 100).toFixed(1) : 0,
  };
  void writeFile(REPORT_FILE, JSON.stringify(report, null, 2)).catch(() => {});
  console.log(`[tsa] CAMPAIGN COMPLETE: ${JSON.stringify(report)}`);
  await logVerdict({ verdict: "CAMPAIGN-COMPLETE", ...report });
  await db.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[tsa] fatal:", e);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
