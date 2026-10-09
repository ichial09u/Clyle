#!/usr/bin/env node
/**
 * Global lag estimation experiment: full-span cross-correlation (coarse) +
 * median cue-onset alignment to audio RMS peaks (fine). Compares against the
 * per-window argmax mess. Usage: node scripts/sp-cc-sync-deep2.mjs <malId> <ep>
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4, envelopeFromPcm } = await import("./lib/intro-detect-sp.mjs");

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
function smoothEnv(env, k = 4) {
  return env.map((_, i) => { let s = 0, c = 0; for (let d = -k; d <= k; d++) { const j = i + d; if (j >= 0 && j < env.length) { s += env[j]; c++; } } return s / c; });
}
function parseCues(vtt) {
  const cues = [];
  for (const m of vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)) {
    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    if (e > s && s < 1500) cues.push([s, e]);
  }
  return cues;
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
  const tmp = join(mkdtempSync(join(tmpdir(), "sp-deep2-")), "ep.mp4");
  const dl = await downloadMp4(url, tmp);
  const pcm = await decodePcmFull(tmp, 1500);
  try { rmSync(tmp, { force: true }); } catch {}
  const an = envelopeFromPcm(pcm);
  const aud = an.envS; // 0.5s RMS, smoothed
  const cues = parseCues(capRow.content);
  const N = Math.min(Math.ceil(1500 / 0.5), aud.length);
  const act = new Array(N).fill(0);
  for (const [s, e] of cues) { const a = Math.max(0, Math.floor(s / 0.5)), b = Math.min(N - 1, Math.ceil(e / 0.5) - 1); for (let i = a; i <= b; i++) act[i] = 1; }
  const actS = smoothEnv(act);

  // 1) GLOBAL coarse scan
  const LAG = 30; // ±15 s
  const curve = [];
  for (let k = -LAG; k <= LAG; k++) {
    const x = [], y = [];
    for (let i = LAG; i < N - LAG; i++) { x.push(actS[i]); y.push(aud[i + k]); }
    curve.push({ k, corr: pearson(x, y) });
  }
  curve.sort((a, b) => b.corr - a.corr);
  const top = curve[0];
  const atZero = curve.find((c) => c.k === 0).corr;
  console.log("global top lags:", curve.slice(0, 5).map((c) => `${c.k * 0.5}s/${c.corr.toFixed(3)}`).join("  "), `| corr@0=${atZero.toFixed(3)}`);

  // 2) fine: median onset alignment around the coarse lag
  const coarse = top.k * 0.5;
  const offs = [];
  for (const [s] of cues) {
    const center = s + coarse;
    const a = Math.floor((center - 1.5) / 0.5), b = Math.ceil((center + 1.5) / 0.5);
    if (a < 0 || b >= aud.length) continue;
    let bi = a;
    for (let j = a; j <= b; j++) if (aud[j] > aud[bi]) bi = j;
    const peak = bi * 0.5;
    // only count onsets that sit near actual audio energy (speech onset)
    if (aud[bi] > 0.25) offs.push(peak - s);
  }
  offs.sort((a, b) => a - b);
  const median = offs.length ? offs[Math.floor(offs.length / 2)] : NaN;
  const q1 = offs[Math.floor(offs.length * 0.25)], q3 = offs[Math.floor(offs.length * 0.75)];
  console.log(`onset alignments: n=${offs.length} median=${median?.toFixed(2)}s IQR=[${q1?.toFixed(2)},${q3?.toFixed(2)}]`);

  // drift check: median offset in the first vs second half
  const half = 700; // 350 s
  const o1 = offs.filter((_, i) => i < offs.length / 2), o2 = offs.filter((_, i) => i >= offs.length / 2);
  // onsets are time-ordered; split by cue time instead
  const firstHalf = [], secondHalf = [];
  for (const [s] of cues) {
    const center = s + coarse;
    const a = Math.floor((center - 1.5) / 0.5), b = Math.ceil((center + 1.5) / 0.5);
    if (a < 0 || b >= aud.length) continue;
    let bi = a; for (let j = a; j <= b; j++) if (aud[j] > aud[bi]) bi = j;
    if (aud[bi] > 0.25) (s < 300 ? firstHalf : secondHalf).push(bi * 0.5 - s);
  }
  const med = (arr) => arr.length ? arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] : NaN;
  console.log(`first 5min median=${med([...firstHalf])?.toFixed(2)}s | later median=${med([...secondHalf])?.toFixed(2)}s`);
  await db.$disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
