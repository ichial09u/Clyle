#!/usr/bin/env node
/**
 * OP-SUB INTRO AUDIT — wave 2 of the One Piece sub intro army.
 *
 * The verify sweep flagged 412 episodes whose served intro is a ~163-171s
 * block [0, ~171] (zoko payload). Ground truth on the encodes (ep300/301
 * probe): the sustained music wall really ends at ~171.5 — the served END is
 * correct and the click at end-3 lands with the opening's last seconds still
 * playing. The fleet's cross-match machinery can't express >150s blocks
 * (MAX_OP_SEC ceiling) — so this audit verifies DIRECTLY, per episode:
 *
 *   watch the sub encode (300s of audio through ffmpeg) and test the exact
 *   mission criterion: at the click target (end - 3), is the opening still
 *   playing (audio wall loud)?
 *     loud at click      -> GOOD  (data is right, leave it)
 *     not loud at click  -> the served END is wrong: post the scanner's
 *                           measured wall interval (scout exact outranks the
 *                           payload) and re-verify
 *   Queue B certifies a sample of the verify sweep's PASS eps the same way.
 *
 * Usage: node scripts/op-sub-intro-audit.mjs                 # full audit
 *        node scripts/op-sub-intro-audit.mjs --once-ep 300   # probe one ep
 */

import { appendFile, writeFile, readFile } from "node:fs/promises";
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const MAL = 21;
const TOTAL_EP = 1176;
const BASE = opt("base", "http://localhost:3000");
const MIRROR = opt("mirror", BASE);
const SCOUT_TOKEN = "clyle-scout-v1";
const LANES = Math.max(1, parseInt(opt("lanes", "6"), 10) || 6);
const LOUD_FRAC = 0.6;      // fraction of loud windows required around the click
const END_TOLERANCE = 12;   // measured-vs-served end agreement (s)
const UA = "Mozilla/5.0 (ClyleOPAudit/1.0)";

const PROGRESS_FILE = new URL("./op-sub-intro-audit-progress.json", import.meta.url).pathname;
const REPORT_FILE = new URL("./op-sub-intro-audit-report.json", import.meta.url).pathname;
const LOG_FILE = new URL("./op-sub-intro-audit.log", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

const state = {
  startedAt: new Date().toISOString(), updatedAt: null,
  audited: 0, good: 0, fixed: 0, fixFailed: 0, inconclusive: 0, certified: 0, certFailed: 0,
  totalA: 0, totalB: 0, done: false,
  fixedEps: [], failedEps: [],
};
let totalWork = 0;
async function snapshot() {
  state.updatedAt = new Date().toISOString();
  state.done = state.audited >= totalWork;
  await writeFile(PROGRESS_FILE, JSON.stringify(state, null, 2)).catch(() => {});
}
async function logRow(row) {
  try { await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* never blocks */ }
}

/* ---------------- helpers ---------------- */

async function resolveSubStream(ep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000) });
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

/** the mission criterion: is the opening still playing at the click (end-3)? */
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

/* ---------------- the audit per episode ---------------- */

async function auditEp(bot, ep, intro, fromB) {
  const { start, end } = intro;
  const enc = await watchEncode(ep);
  if (!enc) {
    state.inconclusive++;
    state.failedEps.push(ep);
    await logRow({ bot, ep, verdict: "INCONCLUSIVE", detail: "encode unwatchable (starve/CDN)" });
    return;
  }
  const c = clickLandsInOpening(enc.env, start, end);
  if (!c.decisive) {
    state.inconclusive++;
    state.failedEps.push(ep);
    await logRow({ bot, ep, verdict: "INCONCLUSIVE", detail: c.why });
    return;
  }
  if (c.ok) {
    if (fromB) {
      state.certified++;
      await logRow({ bot, ep, verdict: "CERTIFIED", detail: `PASS ep re-verified on the encode: ${c.why}` });
    } else {
      state.good++;
      await logRow({ bot, ep, verdict: "GOOD", detail: `${c.why} — served end ${end} is the real opening end (button pops at ${start - 1}s, click keeps last 3s playing)` });
    }
    return;
  }

  // click lands OUTSIDE the opening — the served end is wrong. Fix with the
  // scanner's measured wall (OP-shaped by construction).
  const wall = enc.wall;
  if (!wall || wall.end - wall.start < 45 || wall.end - wall.start > 170) {
    state.fixFailed++;
    state.failedEps.push(ep);
    await logRow({ bot, ep, verdict: "FIX-BLOCKED", detail: `click not loud (${c.why}) but wall unusable: ${JSON.stringify(wall)}` });
    return;
  }
  const posted = await reportFindings(bot, [{
    malId: MAL, ep, status: "ok", start: wall.start, end: wall.end, quality: enc.p95 ? 1 : 0.9,
    detail: `op-sub-audit fix: served end ${end} not loud at click; measured wall ${wall.start.toFixed(1)}-${wall.end.toFixed(1)}`,
  }]);
  if (!posted) { state.fixFailed++; state.failedEps.push(ep); await logRow({ bot, ep, verdict: "FIX-POST-FAIL", detail: "scout API rejected" }); return; }
  await sleep(65_000); // scout cache turnover
  try {
    const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000) });
    const s = await res.json();
    const now = s?.skip?.intro;
    const nowLoud = now ? clickLandsInOpening(enc.env, now.start, now.end) : { ok: false, why: "intro missing" };
    if (now && nowLoud.ok) {
      state.fixed++;
      state.fixedEps.push(ep);
      await logRow({ bot, ep, verdict: "FIXED", detail: `served ${start}-${end} -> ${now.start}-${now.end}; click -> ${(now.end - 3).toFixed(1)}s, ${nowLoud.why}` });
    } else {
      state.fixFailed++;
      state.failedEps.push(ep);
      await logRow({ bot, ep, verdict: "FIX-STILL-BAD", detail: `after fix: ${JSON.stringify(now)} (${nowLoud.why ?? ""})` });
    }
  } catch (e) {
    state.fixFailed++;
    state.failedEps.push(ep);
    await logRow({ bot, ep, verdict: "FIX-VERIFY-FAIL", detail: String(e).slice(0, 100) });
  }
}

/* ---------------- boot ---------------- */

async function main() {
  const onceEp = opt("once-ep");
  if (onceEp) {
    const ep = parseInt(onceEp, 10);
    const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000) });
    const served = await res.json();
    console.log("served:", JSON.stringify(served.skip));
    const enc = await watchEncode(ep);
    if (!enc) { console.log("encode unwatchable"); process.exit(0); }
    console.log(`wall: ${JSON.stringify(enc.wall)} analyzed ${(enc.analyzedSec).toFixed(0)}s`);
    const c = clickLandsInOpening(enc.env, served.skip.intro.start, served.skip.intro.end);
    console.log(`click test: ${c.why} -> ${c.ok ? "GOOD (opening still playing at click)" : "click lands OUTSIDE the opening"}`);
    process.exit(0);
  }

  // Queue A: the verify sweep's BAD-DATA eps (army log)
  const badEps = new Set();
  const passEps = new Set();
  try {
    const log = await readFile(new URL("./op-sub-intro-army.log", import.meta.url), "utf8");
    for (const line of log.split("\n")) {
      let j = null;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j?.ep) continue;
      if (j.verdict === "BAD-DATA") badEps.add(j.ep);
      if (j.verdict === "PASS") passEps.add(j.ep);
    }
  } catch { /* no log yet */ }
  const queueA = [];
  const queueB = [];
  for (const ep of [...badEps].sort((a, b) => a - b)) queueA.push(ep);
  for (const ep of [...passEps].filter((ep) => ep % 25 === 0)) queueB.push(ep);
  totalWork = queueA.length + queueB.length;
  state.totalA = queueA.length; state.totalB = queueB.length;

  console.log(`[audit] wave 2 deployed: ${LANES} audit bots | queue A (fix-capable): ${queueA.length} eps | queue B (certify): ${queueB.length} eps`);
  await logRow({ verdict: "AUDIT-START", queueA: queueA.length, queueB: queueB.length });
  await snapshot();

  // lane-local queues (shared work via closure)
  const sharedA = queueA, sharedB = queueB;
  const laneBodies = [];
  for (let i = 1; i <= LANES; i++) {
    laneBodies.push((async () => {
      const bot = `op-audit-${i}`;
      for (;;) {
        let ep = sharedA.shift(), fromB = false;
        if (ep == null) { ep = sharedB.shift(); fromB = ep != null; }
        if (ep == null) { if (state.audited >= totalWork) return; await sleep(3_000); continue; }
        let served = null;
        try {
          const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000) });
          served = await res.json();
        } catch { served = null; }
        const intro = served?.skip?.intro;
        if (!intro) {
          state.audited++;
          await logRow({ bot, ep, verdict: "SKIP-NO-INTRO", detail: "no served intro (repair army's domain)" });
          continue;
        }
        await auditEp(bot, ep, intro, fromB);
        state.audited++;
        if (state.audited % 5 === 0) await snapshot();
        await sleep(jitter(1_500));
      }
    })());
  }
  const heart = setInterval(() => snapshot(), 5_000);
  await Promise.all(laneBodies);
  clearInterval(heart);
  await snapshot();

  const report = {
    campaign: "One Piece sub intro audit (wave 2)",
    criterion: "at the click target (end-3), the opening must still be playing",
    startedAt: state.startedAt, finishedAt: new Date().toISOString(),
    good: state.good, fixed: state.fixed, fixFailed: state.fixFailed, inconclusive: state.inconclusive,
    certified: state.certified, certFailed: state.certFailed,
    fixedEps: state.fixedEps, inconclusiveEps: [...new Set(state.failedEps)].sort((a, b) => a - b),
  };
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log("[audit] AUDIT COMPLETE");
  console.log(JSON.stringify(report, null, 1));
  await logRow({ verdict: "AUDIT-COMPLETE", ...report });
  process.exit(0);
}

main().catch((e) => { console.error("[audit] fatal:", e); process.exit(1); });
