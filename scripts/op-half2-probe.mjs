#!/usr/bin/env node
/**
 * Deep-probe one episode's sub encode: print the envelope's loud regions
 * (relaxed threshold) + what the served intro is, to hand-calibrate.
 * Usage: node scripts/op-half2-probe.mjs 857
 */
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const ep = parseInt(process.argv[2] ?? "857", 10);
const BASE = "http://localhost:3000";
const UA = "Mozilla/5.0 (ClyleOPProbe/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdnHeadersFor = (rawUrl) => {
  let host = ""; try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return {}; }
  const megap = [".shiora.top", ".shiora.site", ".norami.top", ".akirax.buzz", ".mikora.top", ".kryntal.top", ".vaelith.top", ".imgnex.top"];
  if (megap.some((s) => host.endsWith(s))) return { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz" };
  if (host.endsWith(".hakunaymatata.com")) return {};
  return { Referer: "https://zokoanime.video/", Origin: "https://zokoanime.video", "User-Agent": UA };
};

const r = await fetch(`${BASE}/api/stream?malId=21&ep=${ep}&lang=sub&server=1`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(75_000) });
const s = await r.json();
console.log(`served skip: ${JSON.stringify(s.skip?.intro ?? null)} src=${s.skip?.source ?? "none"}`);

let an = null;
for (let a = 1; a <= 3 && !an; a++) {
  const res = await analyzePlaylist(s.src, { log: () => {}, maxSec: 330, minSec: 120 });
  if (res.status === "ok" && res.env.length * 0.5 >= 120) an = res;
  else { console.log(`attempt ${a}: ${res.detail} (${(res.env.length * 0.5).toFixed(0)}s audio)`); await sleep(5000 * a); }
}
if (!an) { console.log("encode unwatchable"); process.exit(1); }

const env = an.env;
console.log(`analyzed ${(env.length * 0.5).toFixed(0)}s, p95=${an.p95?.toFixed(2)}, strict wall=${an.wall ? `${an.wall.start.toFixed(1)}-${an.wall.end.toFixed(1)}` : "none"}`);

// loud regions at relaxed 0.35 + a coarse ASCII map
const LOUD = 0.35;
const regions = [];
let st = -1;
for (let i = 0; i <= env.length; i++) {
  const loud = i < env.length && env[i] >= LOUD;
  if (loud && st < 0) st = i;
  if (!loud && st >= 0) { if ((i - st) * 0.5 >= 12) regions.push({ start: st * 0.5, end: i * 0.5 }); st = -1; }
}
console.log("loud regions (>=12s, thr 0.35):", regions.map((r) => `${r.start.toFixed(0)}-${r.end.toFixed(0)}`).join("  ") || "none");

// coarse envelope map: one char per 3s bucket
let line = "";
for (let i = 0; i < Math.min(env.length, 660); i += 6) {
  const avg = (env[i] + env[i + 1] + env[i + 2] + env[i + 3] + env[i + 4] + env[i + 5]) / 6;
  line += avg >= 0.6 ? "#" : avg >= 0.35 ? "+" : avg >= 0.15 ? "-" : "_";
}
console.log(`env map (1 char = 3s, 0-330s): ${line}`);
