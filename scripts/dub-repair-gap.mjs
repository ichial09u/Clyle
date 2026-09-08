#!/usr/bin/env node
/**
 * One-off DUB repair: measure openings for the 289 dub eps that resolve but
 * have NO intro coverage anywhere (surfaced by the re-verify after the
 * dev-server outage). Uses the army's own pair-measurement machinery
 * (intro-detect.mjs) on the DUB encode and posts findings to the scout API.
 * Same guards as the army: plausible shape, quality >= 0.72, 2-strike rule
 * (2 failed partner pairs = no-OP, never force-written).
 */
import { PrismaClient } from "@prisma/client";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "./lib/intro-detect.mjs";

const BASE = "http://localhost:3000";
const TOKEN = "clyle-scout-v1";
const UA = "Mozilla/5.0 (ClyleAllShowsArmy/1.0)";
const MIN_QUALITY = 0.72;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);
const db = new PrismaClient();

async function resolveDub(malId, ep) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=dub&server=1`, { signal: AbortSignal.timeout(50_000) });
      if (res.status === 404) return { _404: true };
      if (res.status === 200) { const j = await res.json(); if (j.src) return j; }
    } catch { /* retry */ }
    if (attempt < 2) await sleep(3_000);
  }
  return null;
}

const cache = new Map();
async function watchEncode(malId, ep) {
  const k = `${malId}/${ep}`;
  if (cache.has(k)) return cache.get(k);
  const resolved = await resolveDub(malId, ep);
  if (!resolved || resolved._404 || !resolved.src) return null;
  let r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 });
  if (r.status !== "ok" && /STARVED|timeout|fetch|429|503/i.test(r.detail || "")) { await sleep(6_000); r = await analyzePlaylist(resolved.src, { log: () => {}, maxSec: 400, minSec: 240 }); }
  if (r.status !== "ok") return null;
  cache.set(k, r);
  return r;
}

function loudestSpan(env, spanSec = 70) {
  const span = Math.floor(spanSec / 0.5);
  if (env.length <= span) return env.length ? { start: 0, end: env.length * 0.5 } : null;
  let bestI = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < env.length; i++) { sum += env[i]; if (i >= span) sum -= env[i - span]; if (i >= span - 1 && sum > bestSum) { bestSum = sum; bestI = i - span + 1; } }
  return { start: bestI * 0.5, end: (bestI + span) * 0.5 };
}

async function measurePair(malId, ep, partnerEp) {
  const A = await watchEncode(malId, ep);
  const B = A && partnerEp !== ep ? await watchEncode(malId, partnerEp) : null;
  if (!A || !B) return { ok: false, why: "analyze failed (stream/starve)" };
  const anchorsA = [...(A.wall ? [A.wall] : []), loudestSpan(A.env)].filter(Boolean);
  const anchorsB = [...(B.wall ? [B.wall] : []), loudestSpan(B.env)].filter(Boolean);
  let mA = null, mB = null;
  for (const a of anchorsA) { const t = matchEnvelope(B.env, A.env, a); if (t) { mB = t; mA = matchEnvelope(A.env, B.env, t); if (mA) break; mB = null; } }
  if (!mA || !mB) { for (const b of anchorsB) { const t = matchEnvelope(A.env, B.env, b); if (t) { mA = t; mB = matchEnvelope(B.env, A.env, t); if (mB) break; mA = null; } } }
  if (!mA || !mB) return { ok: false, why: "no cross-alignment (pair)" };
  if (!plausibleInterval(mA.start, mA.end) || !plausibleInterval(mB.start, mB.end)) return { ok: false, why: "implausible interval" };
  if (Math.min(mA.quality, mB.quality) < MIN_QUALITY) return { ok: false, why: `quality ${(Math.min(mA.quality, mB.quality)).toFixed(2)} < ${MIN_QUALITY}` };
  if (mA.end - mA.start < 30 || mA.end - mA.start > 180) return { ok: false, why: `interval ${mA.start.toFixed(0)}-${mA.end.toFixed(0)} not OP-shaped` };
  return { ok: true, A: mA, B: mB };
}

async function reportFindings(bot, findings) {
  try {
    const res = await fetch(`${BASE}/api/bots/intro-scout?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ bot, findings }), signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch { return false; }
}

/* ---- build the target list: dub eps that resolve but carry no button ---- */
const raw = await (await import("node:fs/promises")).readFile("/home/z/my-project/scripts/all-shows-skip-army-dub.log", "utf8");
const latest = new Map();
for (const l of raw.split("\n")) {
  if (!l.trim()) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (!j.key || !j.verdict) continue;
  latest.set(j.key, j.verdict);
}
// eps whose LATEST verdict is RESOLVE-FAIL were re-verified by
// dub-reverify-fails.mjs — recheck live: resolve ok + no button = target
const candidates = [...latest.keys()];
console.log(`[dub-repair] checking ${candidates.length} candidate keys for buttonless dub eps...`);
const targets = [];
for (const key of candidates) {
  const slash = key.indexOf("/");
  const malId = parseInt(key.slice(0, slash), 10), ep = parseInt(key.slice(slash + 1), 10);
  if (!Number.isFinite(malId) || !Number.isFinite(ep)) continue;
  const j = await resolveDub(malId, ep).catch(() => null);
  if (!j || j._404 || !j.src) continue;
  if (j.skip?.intro) continue; // has a button now
  targets.push({ malId, ep });
  await sleep(jitter(200));
}
console.log(`[dub-repair] ${targets.length} buttonless dub eps to measure`);

/* ---- group by show, measure with partner pairs ---- */
const byShow = new Map();
for (const t of targets) { if (!byShow.has(t.malId)) byShow.set(t.malId, []); byShow.get(t.malId).push(t.ep); }
let posted = 0, noOp = 0, failed = 0;
for (const [malId, epList] of byShow) {
  // partner list = the show's full sub episode order (same video timeline)
  const eps = (await db.episode.findMany({ where: { animeId: malId, lang: "sub" }, select: { number: true }, orderBy: { number: "asc" } })).map((e) => e.number);
  for (const ep of epList) {
    const idx = eps.indexOf(ep);
    const partnerEp = idx >= 0 && idx + 1 < eps.length ? eps[idx + 1] : idx > 0 ? eps[idx - 1] : null;
    if (partnerEp == null) { noOp++; continue; }
    const r = await measurePair(malId, ep, partnerEp);
    if (r.ok) {
      const okPost = await reportFindings("dub-repair-1", [{ malId, ep, status: "ok", start: r.A.start, end: r.A.end, quality: r.A.quality, detail: `all-shows-army-dub repair ${ep}+${partnerEp} (measured on our dub encode)` }]);
      if (okPost) posted++; else failed++;
    } else {
      const r2 = await measurePair(malId, ep, partnerEp);
      if (r2.ok) {
        const okPost = await reportFindings("dub-repair-1", [{ malId, ep, status: "ok", start: r2.A.start, end: r2.A.end, quality: r2.A.quality, detail: `all-shows-army-dub repair ${ep}+${partnerEp} (measured on our dub encode, retry)` }]);
        if (okPost) posted++; else failed++;
      } else noOp++; // 2 strikes — likely no opening on this dub
    }
    await sleep(jitter(1_500));
  }
}
console.log(`[dub-repair] FINAL: posted=${posted} noOp=${noOp} failed=${failed} across ${byShow.size} shows`);
await db.$disconnect();
