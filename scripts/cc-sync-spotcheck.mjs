#!/usr/bin/env node
/** Spot-check a CaptionSync verdict with ASR on ONE cue: when are the cue's
 *  first words actually spoken? (quota-friendly: ~6 calls) */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://zokoanime.video", KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
const WORK = mkdtempSync(join(tmpdir(), "ccspot-"));
const execFile = promisify(_execFile);
const MAL = parseInt(process.argv[2] || "3588", 10);
const EP = parseInt(process.argv[3] || "14", 10);
const EXPECT = parseFloat(process.argv[4] || "7.0"); // claimed offset (+ = captions late)

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function vttSec(s) { const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/); if (!m) return NaN; const ms = m[4].length === 1 ? m[4] * 100 : m[4].length === 2 ? m[4] * 10 : +m[4]; return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + ms / 1000; }
const STOP = new Set("the and you that this with for are was but not have has had they them their what when how why who yeah gonna wanna just like right now here there your from would could should about get got one all can will".split(" "));
function tokens(t) { return t.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|[♪♫…"'’‘“”]/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)); }
function tokEq(a, b) { if (a === b) return true; return a.length >= 5 && b.length >= 5 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))); }

async function asrText(wav) {
  for (let a = 0; a < 3; a++) {
    try {
      const out = join(WORK, `asr-${Date.now()}-${Math.random()}.json`);
      const { stdout } = await execFile("z-ai", ["asr", "--base64", readFileSync(wav).toString("base64"), "-o", out], { timeout: 90_000 });
      const f = stdout.match(/File saved to: (\S+)/)?.[1] ?? out;
      return (JSON.parse(readFileSync(f, "utf8")).text ?? "").trim();
    } catch (e) { if (/429|Too many/i.test(String(e.message))) { await new Promise((r) => setTimeout(r, 8000)); continue; } return ""; }
  }
  return "";
}

(async () => {
  const html = await (await fetch(`${ORIGIN}/stream/mal/${MAL}/${EP}/dub`, { headers: { ...H, Accept: "text/html" } })).text();
  const json = JSON.parse(decodeURIComponent(escape(xor(atob(html.match(/window\.__P="([^"]+)"/)[1])))));
  const track = json.subtitles.find((t) => t.label?.toLowerCase() === "english") ?? json.subtitles[0];
  const vtt = await (await fetch(track.src, { headers: H })).text();
  const cues = [];
  for (const block of vtt.replace(/^X-TIMESTAMP-MAP=.*$/gm, "").replace(/^WEBVTT[^\n]*$/gm, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const txt = lines.filter((l) => l !== tl && !/^\d+$/.test(l)).join(" ").replace(/<[^>]+>/g, "").trim();
    if (txt) cues.push({ start: vttSec(a), end: vttSec(b), text: txt });
  }
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
  // pick a dialogue cue near 50% with strong tokens
  const cands = cues.filter((c) => c.start > t * 0.4 && c.start < t * 0.6).map((c) => ({ ...c, strong: [...new Set(tokens(c.text).slice(0, 6))] })).filter((c) => c.strong.length >= 3);
  const cue = cands[Math.floor(cands.length / 2)];
  console.log(`cue @${cue.start.toFixed(1)}s: "${cue.text.slice(0, 60)}"`);
  console.log(`expect speech ~${(cue.start - EXPECT).toFixed(1)}s if offset +${EXPECT}s is real`);
  // window around expected speech position per the verdict
  const center = cue.start - EXPECT;
  const w0 = Math.max(0, center - 8), W = 20;
  const covering = segs.filter((s) => s.start + s.dur > w0 && s.start < w0 + W);
  const bufs = await Promise.all(covering.map(async (s) => Buffer.from(await (await fetch(s.url, { headers: H })).arrayBuffer())));
  const ts = join(WORK, "w.ts");
  writeFileSync(ts, Buffer.concat(bufs));
  const { stdout: pcm } = await execFile("ffmpeg", ["-hide_banner", "-nostats", "-i", ts, "-ss", (w0 - covering[0].start).toFixed(2), "-t", String(W), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  // 2.5s bins
  for (let off = 0; off + 2.5 <= W; off += 2.5) {
    const bin = join(WORK, `b${off}.wav`);
    const b0 = Math.floor(off * 16000) * 2, b1 = Math.floor((off + 2.5) * 16000) * 2;
    writeFileSync(bin, pcm.subarray(b0, b1));
    const text = await asrText(bin);
    const bt = tokens(text);
    const score = cue.strong.filter((w) => bt.some((x) => tokEq(x, w))).length;
    const abs = w0 + off;
    console.log(`  bin @${abs.toFixed(1)}s (cue${(abs - cue.start >= 0 ? "+" : "")}${(abs - cue.start).toFixed(1)}): score=${score} "${text.slice(0, 60)}"`);
  }
})().catch((e) => { console.error("FATAL", e.message || e); process.exit(1); });
