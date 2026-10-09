#!/usr/bin/env node
/**
 * Scorer A/B test: threshold-onset match (current) vs DERIVATIVE elevation
 * (laugh-track robust). Episode audio = cue onsets should coincide with
 * envelope RISES at the true lag; unsynced laughter rises form a flat
 * background. Usage: node scripts/sp-cc-scorer-test.mjs <malId>/<ep> ...
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4 } = await import("./lib/intro-detect-sp.mjs");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://www.wcostream.tv";
const EMBED = "https://embed.wcostream.com";
function curl(url, hdrs = []) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url];
    for (const h of hdrs) a.push("-H", h);
    execFile("curl", a, { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
      const m = String(out).match(/__ST__(\d+)\s*$/);
      res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
    });
  });
}
async function resolveMp4(slug) {
  const page = await curl(`${SITE}/${slug}`);
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) throw new Error("no embed");
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  for (const fullhd of [false, true]) {
    const link = await curl(`${EMBED}/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, ["X-Requested-With: XMLHttpRequest", `Referer: ${EMBED}/inc/embed/video-js.php`]);
    let j; try { j = JSON.parse(link.body); } catch { continue; }
    for (const q of ["enc", "hd", "fhd"]) {
      if (!j[q] || !j.server) continue;
      const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j[q])}&json`, [`Referer: ${EMBED}/`]);
      let url = fin.body.trim().replace(/\\\//g, "/").replace(/"/g, "");
      try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch {}
      if (/^https?:\/\/[^\./]/.test(url)) return url;
    }
  }
  throw new Error("no live quality");
}
function pcmOf(path, sec) {
  return new Promise((res) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-t", String(sec), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, encoding: "buffer" }, (e, stdout) => res(e ? null : stdout));
  });
}

async function measure(job) {
  const cap = await db.spCaption.findUnique({ where: { malId_ep: { malId: job.malId, ep: job.ep } }, select: { content: true } });
  const epRow = await db.episode.findFirst({ where: { animeId: job.malId, number: job.ep, lang: "sub" }, select: { slug: true } });
  const starts = [...cap.content.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000).filter((s) => s < 590);
  const url = await resolveMp4(epRow.slug);
  const tmp = join(mkdtempSync(join(tmpdir(), "sp-score-")), "ep.mp4");
  const dl = await downloadMp4(url, tmp);
  const pcm = await pcmOf(tmp, 600);
  try { rmSync(tmp, { force: true }); } catch {}
  const win = 2000;
  const raw = [];
  for (let off = 0; off + win * 2 <= pcm.length; off += win * 2) {
    let s = 0;
    for (let i = 0; i < win; i++) s += pcm.readInt16LE(off + i * 2) ** 2;
    raw.push(Math.sqrt(s / win));
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const env = smooth1(raw.map((v) => v / p95));
  const N = env.length;
  const cueOn = new Array(N).fill(0);
  for (const s of starts) { const i = Math.round(s * 4); if (i >= 0 && i < N) cueOn[i] = 1; }
  const cueIdx = [];
  for (let i = 0; i < N; i++) if (cueOn[i]) cueIdx.push(i);

  // scorer A: threshold-crossing onset match
  const audOn = env.map((v, i) => (i > 0 && v >= 0.28 && env[i - 1] < 0.28 ? 1 : 0));
  const aRows = [];
  for (let k = -32; k <= 32; k++) {
    let both = 0, rare = 0;
    for (const i of cueIdx) { const j = i + k; if (j < 0 || j >= N) continue; if (audOn[j]) both++; }
    rare = cueIdx.length;
    aRows.push({ k, score: both / rare });
  }
  aRows.sort((x, y) => y.score - x.score);

  // scorer B: derivative elevation — mean max-rise in [i+k, i+k+3] at cue onsets
  const dP = env.map((v, i) => (i > 0 ? Math.max(0, v - env[i - 1]) : 0));
  const dMean = dP.reduce((a, b) => a + b, 0) / N;
  const bRows = [];
  for (let k = -32; k <= 32; k++) {
    let sum = 0, cnt = 0;
    for (const i of cueIdx) {
      let mx = 0;
      for (let d = 0; d <= 3; d++) { const j = i + k + d; if (j >= 0 && j < N) mx = Math.max(mx, dP[j]); }
      sum += mx; cnt++;
    }
    bRows.push({ k, score: sum / cnt / (dMean || 1e-9) });
  }
  bRows.sort((x, y) => y.score - x.score);

  console.log(`${job.malId}/${job.ep}:`);
  console.log("  A(onset):", aRows.slice(0, 3).map((r) => `${(r.k * 0.25).toFixed(2)}s/${r.score.toFixed(2)}`).join("  "));
  console.log("  B(deriv):", bRows.slice(0, 3).map((r) => `${(r.k * 0.25).toFixed(2)}s/${r.score.toFixed(2)}`).join("  "));

  // B second check: elevation profile at the B-peak vs neighbors (sharpness)
  const peak = bRows[0].k;
  const at = (kk) => { let sum = 0, cnt = 0; for (const i of cueIdx) { let mx = 0; for (let d = 0; d <= 3; d++) { const j = i + kk + d; if (j >= 0 && j < N) mx = Math.max(mx, dP[j]); } sum += mx; cnt++; } return sum / cnt / (dMean || 1e-9); };
  console.log(`  B profile @peak±4: ${[-4, -2, 0, 2, 4].map((d) => at(peak + d).toFixed(2)).join(" ")}`);
}
function smooth1(env) {
  return env.map((_, i) => { let s = 0, c = 0; for (let d = -1; d <= 1; d++) { const j = i + d; if (j >= 0 && j < env.length) { s += env[j]; c++; } } return s / c; });
}

const jobs = process.argv.slice(2).map((s) => { const [a, b] = s.split("/").map(Number); return { malId: a, ep: b }; });
for (const j of jobs) {
  try { await measure(j); } catch (e) { console.log(`${j.malId}/${j.ep}: ERR ${e.message}`); }
}
await db.$disconnect();
