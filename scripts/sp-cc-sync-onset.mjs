#!/usr/bin/env node
/**
 * Onset-train correlation: cue START times vs audio RMS onset times
 * (derivative of the envelope, thresholded). Onset trains align far sharper
 * than raw envelopes for sparse, talky content.
 * Usage: node scripts/sp-cc-sync-onset.mjs <malId> <ep>
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4 } = await import("./lib/intro-detect-sp.mjs");

const [malId, ep] = process.argv.slice(2).map(Number);
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

(async () => {
  const STEP = 250; // ms — 0.25 s resolution
  const capRow = await db.spCaption.findUnique({ where: { malId_ep: { malId, ep } } });
  const epRow = await db.episode.findFirst({ where: { animeId: malId, number: ep, lang: "sub" }, select: { slug: true } });
  const url = await resolveMp4(epRow.slug);
  const tmp = join(mkdtempSync(join(tmpdir(), "sp-onset-")), "ep.mp4");
  const dl = await downloadMp4(url, tmp);
  const pcm = await pcmOf(tmp, 600);
  try { rmSync(tmp, { force: true }); } catch {}

  // audio envelope 0.25 s
  const win = 2000;
  const raw = [];
  for (let off = 0; off + win * 2 <= pcm.length; off += win * 2) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += pcm.readInt16LE(off + i * 2) ** 2;
    raw.push(Math.sqrt(sum / win));
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const env = raw.map((v) => v / p95);
  // smooth k=1 (light — keep onsets sharp)
  const envS = env.map((_, i) => { let s = 0, c = 0; for (let d = -1; d <= 1; d++) { const j = i + d; if (j >= 0 && j < env.length) { s += env[j]; c++; } } return s / c; });

  // audio ONSET train: envelope rises through 0.28 (speech starts)
  const audOn = envS.map((v, i) => (i > 0 && v >= 0.28 && envS[i - 1] < 0.28 ? 1 : 0));

  // cue ONSET train at 0.25 s
  const cues = [];
  for (const m of capRow.content.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->/g)) {
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    if (s < 590) cues.push(s);
  }
  const N = envS.length;
  const cueOn = new Array(N).fill(0);
  for (const s of cues) { const i = Math.round(s * 1000 / STEP); if (i >= 0 && i < N) cueOn[i] = 1; }

  // correlate onset trains over ±8 s (counts-based: corr of sparse binaries ~ jaccard-ish)
  const LAG = 32;
  const rows = [];
  for (let k = -LAG; k <= LAG; k++) {
    let both = 0, ca = 0, cb = 0;
    for (let i = 2; i < N; i++) {
      const j = i + k;
      if (j < 0 || j >= N) continue;
      ca += cueOn[i]; cb += audOn[j];
      if (cueOn[i] && audOn[j]) both++;
    }
    const score = both / Math.max(1, Math.min(ca, cb)); // fraction of rarer onsets matched
    rows.push({ k, score, both, ca, cb });
  }
  rows.sort((a, b) => b.score - a.score);
  console.log("top onset-matches (lag s / matched / rareCount):");
  for (const r of rows.slice(0, 8)) console.log(`  ${(r.k * STEP / 1000).toFixed(2)}s  ${r.both}/${Math.min(r.ca, r.cb)} = ${r.score.toFixed(3)}`);
  const r0 = rows.find((r) => r.k === 0);
  console.log(`corr@0: ${r0.score.toFixed(3)} (${r0.both}/${Math.min(r0.ca, r0.cb)})  | cue onsets total=${cues.length}`);
  await db.$disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
