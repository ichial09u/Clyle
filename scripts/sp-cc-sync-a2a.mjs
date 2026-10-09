#!/usr/bin/env node
/**
 * A2A (audio-to-audio) alignment: the vendored captions are timed on LM2's
 * encodes; the player serves WCO's. Instead of the mushy caption-vs-audio
 * signal, correlate the TWO AUDIO TRACKS of the same episode directly —
 * same content, broadband, razor-sharp peak.
 *
 *   shift s: content at LM2-time t appears at WCO-time t + s
 *   -> cue timed at LM2 c must move to c + s  ->  offsetMs = -s*1000
 *      (subs EARLY = s > 0 = negative offset = player shifts cues later)
 *
 * Usage: node scripts/sp-cc-sync-a2a.mjs <malId> <ep> [--span 420]
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "file:/home/z/my-project/src/db/custom.db";
const { PrismaClient } = await import("/home/z/my-project/src/node_modules/@prisma/client/index.js").then((m) => ({ PrismaClient: m.PrismaClient }));
const db = new PrismaClient();
const { downloadMp4 } = await import("./lib/intro-detect-sp.mjs");

const [malId, ep] = process.argv.slice(2).map(Number);
const spanArg = process.argv.indexOf("--span");
const SPAN_SEC = spanArg >= 0 ? +process.argv[spanArg + 1] : 420;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE = "https://www.lookmovie2.to";
const SHOW_PLAY = `${SITE}/shows/play/1689878855-south-park-1997`;
const LM2_MAP = JSON.parse(readFileSync(new URL("./lm2-sp-map.json", import.meta.url), "utf8"));

function curl(url, hdrs = [], binary = false) {
  return new Promise((res) => {
    const a = ["-sS", "--max-time", "25", "-A", UA, "-w", "\n__ST__%{http_code}", url];
    for (const h of hdrs) a.push("-H", h);
    execFile("curl", a, { maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" }, (e, out) => {
      if (binary) {
        const idx = out.lastIndexOf("__ST__");
        const status = idx >= 0 ? parseInt(out.subarray(idx + 6, idx + 12).toString("latin1"), 10) : 0;
        res({ status: Number.isFinite(status) ? status : 0, body: idx >= 0 ? out.subarray(0, idx) : out });
      } else {
        const m = String(out).match(/__ST__(\d+)\s*$/);
        res({ status: m ? +m[1] : 0, body: String(out).replace(/__ST__\d+\s*$/, "") });
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let session = null;
async function getSession() {
  if (session && Date.now() < session.freshUntil) return session;
  const page = await curl(SHOW_PLAY);
  const hash = page.body?.match(/hash:\s*'([^']+)'/)?.[1];
  const expires = page.body?.match(/expires:\s*(\d+)/)?.[1];
  if (!hash || !expires) return null;
  session = { hash, expires, freshUntil: Date.now() + 45 * 60_000 };
  return session;
}
async function accessEpisode(id) {
  const s = await getSession();
  if (!s) return null;
  const r = await curl(`${SITE}/api/v1/security/episode-access?id_episode=${id}&hash=${s.hash}&expires=${s.expires}`, ["Referer: " + SHOW_PLAY, "X-Requested-With: XMLHttpRequest"]);
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

function pcmOf(path, sec) {
  return new Promise((res) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-t", String(sec), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, encoding: "buffer" }, (e, stdout) => res(e ? null : stdout));
  });
}
function pcmOfConcat(files, sec) {
  return new Promise((res) => {
    const list = files.map((f) => `file '${f}'`).join("\n");
    const lst = join(tmpdir(), `lst-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(lst, list);
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-t", String(sec), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 240_000, encoding: "buffer" }, (e, stdout) => { try { rmSync(lst); } catch {} res(e ? null : stdout); });
  });
}

function envelope(pcm, stepMs) {
  const win = Math.round((8000 * stepMs) / 1000); // samples per step
  const raw = [];
  for (let off = 0; off + win * 2 <= pcm.length; off += win * 2) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += pcm.readInt16LE(off + i * 2) ** 2;
    raw.push(Math.sqrt(sum / win));
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return raw.map((v) => v / p95);
}
function smooth(env, k = 2) {
  return env.map((_, i) => { let s = 0, c = 0; for (let d = -k; d <= k; d++) { const j = i + d; if (j >= 0 && j < env.length) { s += env[j]; c++; } } return s / c; });
}
function pearsonAt(a, b, k) {
  const n = Math.min(a.length, b.length - Math.abs(k));
  if (n < 200) return 0;
  let sab = 0, sa = 0, sb = 0, saa = 0, sbb = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + k;
    if (j < 0 || j >= b.length) continue;
    const x = a[i], y = b[j];
    sab += x * y; sa += x; sb += y; saa += x * x; sbb += y * y; cnt++;
  }
  if (cnt < 200) return 0;
  const num = cnt * sab - sa * sb;
  const den = Math.sqrt((cnt * saa - sa * sa) * (cnt * sbb - sb * sb) + 1e-12);
  return den > 0 ? num / den : 0;
}

(async () => {
  const STEP = 250; // 0.25 s
  const dir = mkdtempSync(join(tmpdir(), "sp-a2a-"));

  // ---- WCO audio ----
  const epRow = await db.episode.findFirst({ where: { animeId: malId, number: ep, lang: "sub" }, select: { slug: true } });
  if (!epRow?.slug) return console.log("no WCO slug");
  const page = await curl(`https://www.wcostream.tv/${epRow.slug}`);
  const m = page.body.match(/embed\.wcostream\.com\/inc\/embed\/index\.php\?file=([^"&]+)&[^"]*?pid=(\d+)/);
  if (!m) return console.log("no embed");
  const v = `neptun/${decodeURIComponent(m[1]).replace(/\.flv$/i, ".mp4")}`;
  let wcoUrl = null;
  for (const fullhd of [false, true]) {
    const link = await curl(`https://embed.wcostream.com/inc/embed/getvidlink.php?v=${encodeURIComponent(v)}&embed=neptun${fullhd ? "&fullhd=1" : ""}`, ["X-Requested-With: XMLHttpRequest", "Referer: https://embed.wcostream.com/inc/embed/video-js.php"]);
    let j; try { j = JSON.parse(link.body); } catch { continue; }
    for (const q of ["enc", "hd", "fhd"]) {
      if (!j[q] || !j.server) continue;
      const fin = await curl(`${j.server}/getvid?evid=${encodeURIComponent(j[q])}&json`, ["Referer: https://embed.wcostream.com/"]);
      let url = fin.body.trim().replace(/\\\//g, "/").replace(/"/g, "");
      try { const p = JSON.parse(url); if (typeof p === "string") url = p; } catch {}
      if (/^https?:\/\/[^\./]/.test(url)) { wcoUrl = url; break; }
    }
    if (wcoUrl) break;
  }
  if (!wcoUrl) return console.log("no WCO quality");
  const wcoFile = join(dir, "wco.mp4");
  const dl = await downloadMp4(wcoUrl, wcoFile);
  console.log("wco download:", dl.out);
  const wcoPcm = await pcmOf(wcoFile, SPAN_SEC);
  try { rmSync(wcoFile, { force: true }); } catch {}
  if (!wcoPcm || wcoPcm.length < 8000 * 2 * 120) return console.log("wco decode short");
  const wcoEnv = smooth(envelope(wcoPcm, STEP));
  console.log("wco env steps:", wcoEnv.length, `(${(wcoEnv.length * STEP / 1000).toFixed(0)}s)`);

  // ---- LM2 audio ----
  const season = malId - 999900;
  const mapEps = LM2_MAP.episodes ?? {};
  const idEp = mapEps[String(season)]?.[String(ep)] ?? mapEps[season]?.[ep];
  if (!idEp) return console.log("no LM2 id");
  const payload = await accessEpisode(idEp);
  if (!payload?.streams) return console.log("no LM2 access");
  const byQ = Object.entries(payload.streams).map(([k, v]) => [k.replace(/\D/g, ""), v]).filter(([q, v]) => v && ["480", "360", "720"].includes(q)).sort((a, b) => +b[0] - +a[0]);
  let pls = null;
  let plsUrl = null;
  // LM2's storage pool answers ~1-in-3 with a 200 "WRONG HASH!" body —
  // retry the ladder (fresh access tokens each round) until a real #EXTM lands
  for (let att = 0; att < 10 && !pls; att++) {
    const fresh = await accessEpisode(idEp).catch(() => null);
    for (const [, url] of byQ) {
      const r = await curl(url);
      if (r.status === 200 && String(r.body).trimStart().startsWith("#EXTM")) { pls = String(r.body); plsUrl = url; console.log(`lm2 playlist OK (attempt ${att + 1})`); break; }
      await sleep(300);
    }
    await sleep(400);
  }
  if (!pls) return console.log("no live LM2 playlist");
  const segs = pls.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // collect ~SPAN_SEC of segments. LM2's pool: the playlist host may serve
  // playlists but 12-byte error bodies for segments — when a segment dies,
  // re-run the whole access (new node assignment) and retry the batch.
  // NOTE: segments MUST be fetched WITHOUT a Referer (any Referer -> error body).
  const need = Math.ceil(SPAN_SEC / 4) + 8;
  const files = [];
  for (let round = 0; round < 5 && files.length < Math.min(need, segs.length); round++) {
    let pls2 = pls, plsUrl2 = plsUrl, segs2 = segs;
    if (round > 0) {
      const fresh = await accessEpisode(idEp).catch(() => null);
      if (!fresh?.streams) { await sleep(1_200); continue; }
      const byQ2 = Object.entries(fresh.streams).map(([k, v]) => [k.replace(/\D/g, ""), v]).filter(([q, v]) => v && ["720", "480", "360", "1080"].includes(q)).sort((a, b) => +b[0] - +a[0]);
      for (const [, url] of byQ2) {
        const r = await curl(url);
        if (r.status === 200 && String(r.body).trimStart().startsWith("#EXTM")) { pls2 = String(r.body); plsUrl2 = url; break; }
        await sleep(300);
      }
      if (!plsUrl2) { await sleep(1_200); continue; }
      segs2 = pls2.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    }
    for (let i = files.length; i < Math.min(need, segs2.length); i++) {
      const abs = new URL(segs2[i], plsUrl2).toString();
      const f = join(dir, `s${i}.ts`);
      let ok = false;
      for (let att = 0; att < 3 && !ok; att++) {
        const r = await curl(abs, [], true);
        if (i === 0 && att === 0) console.log(`seg0 probe: status=${r.status} bytes=${r.body?.length ?? 0} head=${r.body && r.body.length > 12 ? r.body.subarray(0, 12).toString("latin1").replace(/[^\x20-\x7e]/g, ".") : "?"} url=${abs.slice(0, 90)}`);
        if (r.status === 200 && r.body && r.body.length > 40_000) { writeFileSync(f, r.body); ok = true; }
        else await sleep(600 * (att + 1));
      }
      if (!ok) break; // this node is broken — outer round re-runs access
      files.push(f);
    }
  }
  if (files.length < 10) return console.log("too few LM2 segments");
  const lm2Pcm = await pcmOfConcat(files, SPAN_SEC);
  try { for (const f of files) rmSync(f, { force: true }); } catch {}
  if (!lm2Pcm || lm2Pcm.length < 8000 * 2 * 120) return console.log("lm2 decode short");
  const lm2Env = smooth(envelope(lm2Pcm, STEP));
  console.log("lm2 env steps:", lm2Env.length, `(${(lm2Env.length * STEP / 1000).toFixed(0)}s)`);

  // ---- cross-correlate: WCO[k] vs LM2[0..]  (k in ±45 s) ----
  const LAG = Math.floor(45_000 / STEP);
  let best = null;
  const curve = [];
  for (let k = -LAG; k <= LAG; k++) {
    const c = pearsonAt(lm2Env, wcoEnv, k);
    curve.push({ k, c });
    if (!best || c > best.c) best = { k, c };
  }
  curve.sort((a, b) => b.c - a.c);
  const c0 = curve.find((x) => x.k === 0)?.c ?? 0;
  console.log("top lags (s):", curve.slice(0, 6).map((x) => `${(x.k * STEP / 1000).toFixed(2)}/${x.c.toFixed(3)}`).join("  "), `| corr@0=${c0.toFixed(3)}`);
  const shift = best.k * STEP / 1000; // WCO time = LM2 time + shift
  console.log(`\nSHIFT = ${shift.toFixed(2)}s  (corr ${best.c.toFixed(3)} vs 0-lag ${c0.toFixed(3)})`);
  console.log(`=> offsetMs for CaptionSync = ${Math.round(-shift * 1000)}`);
  await db.$disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
