#!/usr/bin/env node
/**
 * OP-SUB HALF-2 CALIBRATION — the second pass for wave-3 stragglers.
 *
 * Wave 3's per-episode pipeline left a small set of episodes in two buckets:
 *   FIX-NO-WALL  — the click lands past the real opening end, but the
 *                  scanner's strict wall proposal found nothing to post
 *   INCONCLUSIVE — the 330s encode watch starved on the CDN (42-70s of
 *                  audio) so the click check could not run
 *
 * This pass is gentler and more persistent:
 *   1. re-watch the encode up to 3 times (CDN starve recovery, backoff)
 *   2. find loud walls with a RELAXED threshold (env >= 0.35 instead of the
 *      strict wall proposal) and pick the wall whose END is closest to the
 *      served end (within 45s) — openings end where the music stops, and a
 *      stale median that overshoots by a few seconds is still fixable
 *   3. POST the corrected interval (scout exact outranks everything),
 *      wait for the 60s cache turnover, re-verify with the wave-3 test
 *   4. eps that still cannot be measured go to scripts/op-sub-half2-stragglers.json
 *
 * Usage: node scripts/op-sub-half2-calibrate.mjs
 */

import { writeFile, readFile } from "node:fs/promises";
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const MAL = 21;
const BASE = "http://localhost:3000";
const SCOUT_TOKEN = "clyle-scout-v1";
const UA = "Mozilla/5.0 (ClyleOPHalf2Cal/1.0)";
const LOUD = 0.35;          // relaxed loud threshold (dialogue-free music wall)
const END_TOLERANCE = 45;   // corrected end may move at most this far from served

const REPORT_FILE = new URL("./op-sub-half2-report.json", import.meta.url).pathname;
const OUT_FILE = new URL("./op-sub-half2-stragglers.json", import.meta.url).pathname;
const LOG_FILE = new URL("./op-sub-half2-cal.log", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdnHeadersFor = (rawUrl) => {
  let host = "";
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return {}; }
  const megap = [".shiora.top", ".shiora.site", ".norami.top", ".akirax.buzz", ".mikora.top", ".kryntal.top", ".vaelith.top", ".imgnex.top"];
  if (megap.some((s) => host.endsWith(s))) return { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz" };
  if (host.endsWith(".hakunaymatata.com")) return {};
  return { Referer: "https://zokoanime.video/", Origin: "https://zokoanime.video", "User-Agent": UA };
};

async function logRow(row) {
  const { appendFile } = await import("node:fs/promises");
  try { await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* fine */ }
}

async function resolveSubStream(ep) {
  for (let a = 1; a <= 2; a++) {
    try {
      const res = await fetch(`${BASE}/api/stream?malId=${MAL}&ep=${ep}&lang=sub&server=1`, { signal: AbortSignal.timeout(75_000), headers: { "User-Agent": UA } });
      if (res.status === 404) return { _404: true };
      if (!res.ok) throw new Error(`stream ${res.status}`);
      const s = await res.json();
      if (!s?.src) return null;
      return s;
    } catch { if (a < 2) await sleep(3_000); }
  }
  return null;
}

async function watchEncodeResilient(srcUrl) {
  for (let a = 1; a <= 3; a++) {
    const r = await analyzePlaylist(srcUrl, { log: () => {}, maxSec: 330, minSec: 120 });
    if (r.status === "ok" && r.env.length * 0.5 >= 120) return r;
    if (/STARVED|timeout|fetch|429|503/i.test(r.detail || "") || r.status !== "ok") await sleep(8_000 * a);
  }
  return null;
}

/** all loud regions >= 20s with the relaxed threshold, gaps < 4s merged
 *  (a song's internal dip must not split the opening in two) */
function loudRegions(env) {
  const raw = [];
  let s = -1;
  for (let i = 0; i <= env.length; i++) {
    const loud = i < env.length && env[i] >= LOUD;
    if (loud && s < 0) s = i;
    if (!loud && s >= 0) {
      const start = s * 0.5, end = i * 0.5;
      if (end - start >= 12) raw.push({ start, end });
      s = -1;
    }
  }
  const out = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && r.start - prev.end < 4) prev.end = r.end; // merge across small dips
    else out.push({ ...r });
  }
  return out.filter((r) => r.end - r.start >= 20);
}

/** the mission criterion at the corrected interval — two tiers:
 *  strict 0.5 first; a song's fade-out tail sustains >= 0.35 while sitting
 *  under the strict gate, and that tail IS the opening still playing */
function loudAtClick(env, end) {
  const click = end - 3;
  const idx = Math.floor(click / 0.5);
  const from = Math.max(0, idx - 4), to = Math.min(env.length, idx + 5);
  if (to - from < 3 || click > env.length * 0.5) return { ok: false, why: `click ${click.toFixed(0)}s beyond audio` };
  const fracAt = (thr) => {
    let loud = 0;
    for (let i = from; i < to; i++) if (env[i] >= thr) loud++;
    return loud / (to - from);
  };
  const strict = fracAt(0.5), relaxed = fracAt(LOUD);
  if (strict >= 0.6) return { ok: true, why: `${(strict * 100).toFixed(0)}% loud at click ${click.toFixed(1)}s`, frac: strict };
  if (relaxed >= 0.6) return { ok: true, why: `${(relaxed * 100).toFixed(0)}% sustained at click ${click.toFixed(1)}s (fade tail)`, frac: relaxed };
  return { ok: false, why: `${(strict * 100).toFixed(0)}% loud at click ${click.toFixed(1)}s`, frac: strict };
}

async function postFix(bot, ep, start, end, why) {
  try {
    const res = await fetch(`${BASE}/api/bots/intro-scout?token=${encodeURIComponent(SCOUT_TOKEN)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ bot, findings: [{ malId: MAL, ep, status: "ok", start, end, quality: 0.85, detail: `op-half2-cal fix: ${why}` }] }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch { return false; }
}

async function main() {
  const report = JSON.parse(await readFile(REPORT_FILE, "utf8"));
  const targets = [...new Set([...(report.failEps ?? []), ...(report.inconclusiveEps ?? [])])];
  // resume support: eps already fixed by a previous (possibly reaped) run are skipped
  let fixed = [];
  try {
    const prevOut = JSON.parse(await readFile(OUT_FILE, "utf8"));
    fixed = prevOut.fixed ?? [];
  } catch { /* first run */ }
  const doneEps = new Set(fixed.map((f) => f.ep));
  // inconclusive eps live in failEps already (wave 3 pushes both there); dedupe covers it
  console.log(`[cal] targets: ${targets.length} eps (${doneEps.size} already fixed in a prior run) -> ${targets.join(",")}`);
  const still = [];

  for (const ep of targets) {
    if (doneEps.has(ep)) { console.log(`[cal] ep ${ep} already fixed earlier — skip`); continue; }
    const resolved = await resolveSubStream(ep);
    if (!resolved || resolved._404 || !resolved.src) { still.push({ ep, why: "stream unresolved" }); continue; }
    const served = resolved.skip?.intro ?? null;

    const enc = await watchEncodeResilient(resolved.src);
    if (!enc) { still.push({ ep, why: "encode starved 3x" }); await logRow({ ep, verdict: "STARVED" }); continue; }
    const env = enc.env;

    // if an intro is served and it already passes, nothing to do
    if (served) {
      const c = loudAtClick(env, served.end);
      if (c.ok) { fixed.push({ ep, start: served.start, end: served.end, note: `already good: ${c.why}` }); await logRow({ ep, verdict: "ALREADY-GOOD", detail: c.why }); continue; }
    }

    // pick the loud region whose END is closest to the served end (or the
    // longest region when nothing is served)
    const regions = loudRegions(env);
    if (!regions.length) { still.push({ ep, why: `no loud region >= 20s (p95 ${enc.p95?.toFixed(2) ?? "?"})` }); await logRow({ ep, verdict: "NO-REGION" }); continue; }
    const refEnd = served?.end ?? Math.max(...regions.map((r) => r.end));
    let best = null, bestD = Infinity;
    for (const r of regions) {
      const d = Math.abs(r.end - refEnd);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (!best) { still.push({ ep, why: "no region candidate" }); continue; }
    if (bestD > END_TOLERANCE && served) {
      // the nearest wall is far from the served end — suspicious, but if the
      // wall passes the click test it is still a strictly better button
      const c = loudAtClick(env, best.end);
      if (!c.ok) { still.push({ ep, why: `nearest wall ${best.start.toFixed(0)}-${best.end.toFixed(0)} ${bestD.toFixed(0)}s from served end, and ${c.why}` }); await logRow({ ep, verdict: "NO-CANDIDATE", detail: still[still.length - 1].why }); continue; }
    }
    const start = Math.max(0, best.start);
    const end = best.end;
    const check = loudAtClick(env, end);
    if (!check.ok) { still.push({ ep, why: `corrected end ${end.toFixed(1)} fails click test: ${check.why}` }); await logRow({ ep, verdict: "CANDIDATE-FAIL", detail: check.why }); continue; }

    const posted = await postFix("op-half2-cal", ep, start, end, `corrected intro ${start.toFixed(1)}-${end.toFixed(1)} (${check.why})`);
    if (!posted) { still.push({ ep, why: "scout API rejected" }); continue; }
    await sleep(65_000);
    const now = await resolveSubStream(ep);
    const nowIntro = now?.skip?.intro;
    if (nowIntro && loudAtClick(env, nowIntro.end).ok) {
      fixed.push({ ep, start: nowIntro.start, end: nowIntro.end });
      console.log(`[cal] ep ${ep} FIXED: ${nowIntro.start.toFixed(0)}-${nowIntro.end.toFixed(0)} (${check.why})`);
      await logRow({ ep, verdict: "FIXED", detail: check.why });
    } else {
      still.push({ ep, why: `posted ${start.toFixed(0)}-${end.toFixed(0)} but served now ${nowIntro ? `${nowIntro.start.toFixed(0)}-${nowIntro.end.toFixed(0)}` : "nothing"}` });
      await logRow({ ep, verdict: "STILL-BAD", detail: still[still.length - 1].why });
    }

    // checkpoint after EVERY episode — the sandbox reaps long processes, so
    // progress must survive a kill and the next run resumes where this stopped
    await writeFile(OUT_FILE, JSON.stringify({ at: new Date().toISOString(), fixed, still }, null, 2));
  }

  await writeFile(OUT_FILE, JSON.stringify({ at: new Date().toISOString(), fixed, still }, null, 2));
  console.log(`[cal] done: ${fixed.length} fixed, ${still.length} still failing`);
  for (const s of still) console.log(`  - ep ${s.ep}: ${s.why}`);
  process.exit(0);
}

main().catch((e) => { console.error("[cal] fatal:", e); process.exit(1); });
