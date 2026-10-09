#!/usr/bin/env node
/**
 * Deep-measure ONE episode's caption-vs-audio lag across the WHOLE episode
 * (not just the first 4 min) — decides constant vs linear correction.
 * Usage: node scripts/sp-cc-sync-deep.mjs <malId> <ep>
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const intro = await import("./lib/intro-detect-sp.mjs");
const { downloadMp4, envelopeFromPcm } = intro;

const [malId, ep] = process.argv.slice(2).map(Number);
const capRow = await db.spCaption.findUnique({ where: { malId_ep: { malId, ep } } });
const epRow = await db.episode.findFirst({ where: { animeId: malId, number: ep, lang: "sub" }, select: { slug: true } });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function curl(url, hdrs = []) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__ST__%{http_code}", url, ...hdrs.flatMap((h) => ["-H", h])], { maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
        const m = String(out).match(/__ST__(\d+)\s*$/);
        res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
      });
    });
  });
}
async function resolveMp4(slug) {
  const page = await curl(`https://www.wcostream.tv/${slug}`);
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) throw new Error("no embed");
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  for (const fullhd of [false, true]) {
    const link = await curl(`https://embed.wcostream.com/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, ["X-Requested-With: XMLHttpRequest", "Referer: https://embed.wcostream.com/inc/embed/video-js.php"]);
    let j; try { j = JSON.parse(link.body); } catch { continue; }
    for (const q of ["enc", "hd", "fhd"]) {
      if (!j[q] || !j.server) continue;
      const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j[q])}&json`, ["Referer: https://embed.wcostream.com/"]);
      let url = fin.body.trim().replace(/\\\//g, "/").replace(/"/g, "");
      try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch {}
      if (/^https?:\/\/[^\./]/.test(url)) return url;
    }
  }
  throw new Error("no live quality");
}

function smoothEnv(env, k = 6) {
  return env.map((_, i) => { let s = 0, c = 0; for (let d = -k; d <= k; d++) { const j = i + d; if (j >= 0 && j < env.length) { s += env[j]; c++; } } return s / c; });
}
function cueEnvelope(vtt, maxSec) {
  const cues = [];
  for (const m of vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)) {
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    if (e > s) cues.push([s, e]);
  }
  const steps = Math.ceil(maxSec / 0.5);
  const act = new Array(steps).fill(0);
  for (const [s, e] of cues) { const a = Math.max(0, Math.floor(s / 0.5)), b = Math.min(steps - 1, Math.ceil(e / 0.5) - 1); for (let i = a; i <= b; i++) act[i] = 1; }
  return { act: smoothEnv(act), cues: cues.length };
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  let sab = 0, sa = 0, sb = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const a = x[i], b = y[i]; sab += a * b; sa += a; sb += b; saa += a * a; sbb += b * b; }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb) + 1e-12);
  return den > 0 ? num / den : 0;
}
function decodePcmFull(path, maxSec) {
  return new Promise((res) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-t", String(maxSec), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, encoding: "buffer" }, (e, stdout) => res(e ? null : stdout));
    });
  });
}

(async () => {
  const url = await resolveMp4(epRow.slug);
  console.log("resolved:", url.slice(0, 70));
  const tmp = join(mkdtempSync(join(tmpdir(), "sp-deep-")), "ep.mp4");
  const dl = await downloadMp4(url, tmp);
  console.log("download:", dl.out);
  // full episode: up to 1500 s
  const pcm = await decodePcmFull(tmp, 1500);
  try { rmSync(tmp, { force: true }); } catch {}
  const an = envelopeFromPcm(pcm);
  const analyzed = an.analyzedSec;
  console.log("analyzed sec:", analyzed.toFixed(0), "env steps:", an.envS.length);
  const cap = cueEnvelope(capRow.content, analyzed);
  console.log("cues:", cap.cues);

  // 60 s windows across the whole analyzed span
  const W = 120; // 60 s in 0.5 s steps
  const LAG = 40; // ±20 s
  const pts = [];
  for (let wStart = 0; wStart + W <= Math.min(cap.act.length, an.envS.length); wStart += W) {
    let best = null;
    for (let k = -LAG; k <= LAG; k++) {
      const x = [], y = [];
      for (let i = wStart; i < wStart + W; i++) { const j = i + k; if (j < 0 || j >= an.envS.length) continue; x.push(cap.act[i]); y.push(an.envS[j]); }
      if (x.length < W * 0.7) continue;
      const c = pearson(x, y);
      if (!best || c > best.corr) best = { k, corr: c };
    }
    if (best) pts.push({ t: (wStart + W / 2) * 0.5, lag: best.k * 0.5, corr: +best.corr.toFixed(2) });
  }
  console.log(JSON.stringify(pts.map((p) => [p.t.toFixed(0), p.lag.toFixed(1), p.corr])));
  await db.$disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
