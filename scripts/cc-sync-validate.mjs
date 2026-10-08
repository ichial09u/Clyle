#!/usr/bin/env node
/** Method validation: shift the VTT by a known delta, correlator must recover it. */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
const WORK = mkdtempSync(join(tmpdir(), "ccval-"));
const execFile = promisify(_execFile);
const BIN = 0.25, LAG_MIN = -8, LAG_MAX = 8, WIN_LEN = 60;

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function vttSeconds(s) { const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/); if (!m) return NaN; const ms = m[4].length === 1 ? m[4] * 100 : m[4].length === 2 ? m[4] * 10 : +m[4]; return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + ms / 1000; }
function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/^X-TIMESTAMP-MAP=.*$/gm, "").replace(/^WEBVTT[^\n]*$/gm, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const start = vttSeconds(a), end = vttSeconds(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    const txt = lines.filter((l) => l !== tl && !/^\d+$/.test(l)).join(" ").replace(/<[^>]+>/g, "").trim();
    if (txt) cues.push({ start, end });
  }
  return cues;
}
function captionSeries(intervals, W) {
  const n = Math.ceil(W / BIN), s = new Uint8Array(n);
  for (const [a, b] of intervals) for (let k = Math.max(0, Math.floor(a / BIN)); k < Math.min(n, Math.ceil(b / BIN)); k++) s[k] = 1;
  return s;
}
function correlateEnv(cap, env) {
  const n = Math.min(cap.length, env.length);
  let capSum = 0, envSum = 0;
  for (let k = 0; k < n; k++) { capSum += cap[k]; envSum += env[k]; }
  const cBar = capSum / n, eBar = envSum / n;
  let capVar = 0, envVar = 0;
  for (let k = 0; k < n; k++) { const dc = cap[k] - cBar, de = env[k] - eBar; capVar += dc * dc; envVar += de * de; }
  const denom = Math.sqrt(capVar * envVar) || 1e-9;
  let best = { d: null, score: -Infinity };
  const scores = [];
  for (let lag = LAG_MIN / BIN; lag <= LAG_MAX / BIN; lag++) {
    let cov = 0;
    for (let k = 0; k < n; k++) { const j = k - lag; if (j < 0 || j >= n) continue; cov += (cap[k] - cBar) * (env[j] - eBar); }
    const r = cov / denom;
    scores.push(r);
    if (r > best.score) best = { d: lag * BIN, score: r };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  return { d: best.d, score: +best.score.toFixed(3), prom: +(best.score - sorted[Math.floor(sorted.length / 2)]).toFixed(3) };
}
async function envelope(tsFile, w0, W, off) {
  const { stdout } = await execFile("ffmpeg", ["-hide_banner", "-nostats", "-i", tsFile, "-ss", Math.max(0, off).toFixed(2), "-t", W.toFixed(2), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-af", "highpass=f=250,lowpass=f=3400", "-f", "s16le", "pipe:1"], { timeout: 150_000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" });
  const n = Math.ceil(W / BIN), env = new Float32Array(n), per = 8000 * BIN;
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    const s0 = k * per, s1 = Math.min(stdout.length / 2, (k + 1) * per);
    for (let i = s0; i < s1; i++) { const v = stdout.readInt16LE(i * 2) / 32768; sum += v * v; cnt++; }
    env[k] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) sm[k] = (env[Math.max(0, k - 1)] + env[k] + env[Math.min(n - 1, k + 1)]) / 3;
  return sm;
}

const MAL = 3588, EP = 25, DELTA = 2.0;
const html = await (await fetch(`${ORIGIN}/stream/mal/${MAL}/${EP}/dub`, { headers: { ...H, Accept: "text/html" } })).text();
const json = JSON.parse(decodeURIComponent(escape(xor(atob(html.match(/window\.__P="([^"]+)"/)[1])))));
const track = json.subtitles.find((t) => t.label?.toLowerCase() === "english") ?? json.subtitles[0];
const vtt = await (await fetch(track.src, { headers: H })).text();
const cues = parseVtt(vtt);
const shifted = cues.map((c) => ({ start: c.start + DELTA, end: c.end + DELTA }));

const mtext = await (await fetch(json.src, { headers: H })).text();
const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), json.src).href;
const vtext = await (await fetch(vurl, { headers: H })).text();
const segs = []; let t = 0;
const vl = vtext.split("\n");
for (let i = 0; i < vl.length; i++) {
  const m = vl[i].match(/^#EXTINF:([\d.]+)/);
  if (m) { const dur = parseFloat(m[1]); const u = (vl[i + 1] ?? "").trim(); if (u && !u.startsWith("#")) { segs.push({ url: new URL(u, vurl).href, start: t, dur }); t += dur; } }
}

for (const w0 of [435, 879]) {
  const covering = segs.filter((s) => s.start + s.dur > w0 && s.start < w0 + WIN_LEN);
  const bufs = await Promise.all(covering.map(async (s) => Buffer.from(await (await fetch(s.url, { headers: H })).arrayBuffer())));
  const ts = join(WORK, `w${w0}.ts`);
  writeFileSync(ts, Buffer.concat(bufs));
  const off = w0 - covering[0].start;
  const env = await envelope(ts, w0, WIN_LEN, off);
  const A0 = captionSeries(cues.filter((c) => c.start < w0 + WIN_LEN && c.end > w0).map((c) => [Math.max(0, c.start - w0), Math.min(WIN_LEN, c.end - w0)]), WIN_LEN);
  const A1 = captionSeries(shifted.filter((c) => c.start < w0 + WIN_LEN && c.end > w0).map((c) => [Math.max(0, c.start - w0), Math.min(WIN_LEN, c.end - w0)]), WIN_LEN);
  const r0 = correlateEnv(A0, env);
  const r1 = correlateEnv(A1, env);
  console.log(`w0=${w0}: original d=${r0.d} (r=${r0.score}, prom=${r0.prom})  shifted d=${r1.d} (r=${r1.score}, prom=${r1.prom})  recovered delta=${r1.d != null && r0.d != null ? (r1.d - r0.d).toFixed(2) : "?"} (expect +${DELTA})`);
}
