#!/usr/bin/env node
/**
 * Final certification of the wave-3 stragglers with the SAME criterion as
 * the main wave: button pops when the opening arrives, click (end-3) keeps
 * the opening playing (strict 0.5 gate, fade-tail 0.35 fallback).
 */
import { appendFile } from "node:fs/promises";
import { analyzePlaylist } from "./lib/intro-detect.mjs";

const BASE = "http://localhost:3000";
const UA = "Mozilla/5.0 (ClyleOPHalf2Cert/1.0)";
const EPS = [825, 827, 846, 847, 848, 849, 850, 855, 857, 858, 860, 867, 1126, 1128, 1129, 1161];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdnHeadersFor = (rawUrl) => {
  let host = ""; try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return {}; }
  const megap = [".shiora.top", ".shiora.site", ".norami.top", ".akirax.buzz", ".mikora.top", ".kryntal.top", ".vaelith.top", ".imgnex.top"];
  if (megap.some((s) => host.endsWith(s))) return { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz" };
  if (host.endsWith(".hakunaymatata.com")) return {};
  return { Referer: "https://zokoanime.video/", Origin: "https://zokoanime.video", "User-Agent": UA };
};

function loudAtClick(env, end) {
  const click = end - 3;
  const idx = Math.floor(click / 0.5);
  const from = Math.max(0, idx - 4), to = Math.min(env.length, idx + 5);
  if (to - from < 3 || click > env.length * 0.5) return { ok: false, why: `click ${click.toFixed(0)}s beyond audio` };
  const fracAt = (thr) => { let l = 0; for (let i = from; i < to; i++) if (env[i] >= thr) l++; return l / (to - from); };
  const strict = fracAt(0.5), relaxed = fracAt(0.35);
  if (strict >= 0.6) return { ok: true, why: `${(strict * 100).toFixed(0)}% loud at click ${click.toFixed(1)}s` };
  if (relaxed >= 0.6) return { ok: true, why: `${(relaxed * 100).toFixed(0)}% sustained at click ${click.toFixed(1)}s (fade tail)` };
  return { ok: false, why: `${(strict * 100).toFixed(0)}% loud at click ${click.toFixed(1)}s` };
}

for (const ep of EPS) {
  const s = await fetch(`${BASE}/api/stream?malId=21&ep=${ep}&lang=sub&server=1`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(75_000) }).then((r) => r.json()).catch(() => null);
  const intro = s?.skip?.intro;
  if (!intro) { console.log(`ep ${ep}: FAIL — no intro served`); await appendFile("scripts/op-sub-half2-cert.log", JSON.stringify({ ep, verdict: "FAIL", why: "no intro" }) + "\n"); continue; }
  let enc = null;
  for (let a = 1; a <= 3 && !enc; a++) {
    const r = await analyzePlaylist(s.src, { log: () => {}, maxSec: 330, minSec: 120 }).catch(() => null);
    if (r && r.status === "ok" && r.env.length * 0.5 >= 120) enc = r; else await sleep(6_000 * a);
  }
  if (!enc) { console.log(`ep ${ep}: INCONCLUSIVE — encode starved 3x (served ${intro.start}-${intro.end})`); await appendFile("scripts/op-sub-half2-cert.log", JSON.stringify({ ep, verdict: "INCONCLUSIVE", intro }) + "\n"); continue; }
  const c = loudAtClick(enc.env, intro.end);
  const pop = intro.start - 1;
  console.log(`ep ${ep}: ${c.ok ? "CERTIFIED" : "FAIL"} — button pops ${pop}s, click ${Math.max(intro.start, intro.end - 3).toFixed(1)}s, ${c.why} (served ${intro.start}-${intro.end} src=${s.skip?.source})`);
  await appendFile("scripts/op-sub-half2-cert.log", JSON.stringify({ ep, verdict: c.ok ? "CERTIFIED" : "FAIL", intro, why: c.why }) + "\n");
  await sleep(1_500);
}
console.log("cert sweep done");
