#!/usr/bin/env node
/** Diagnostic: dump cue text + per-bin ASR transcripts for one episode. */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

process.env.DATABASE_URL ||= "file:/home/z/my-project/src/db/custom.db";
const execFile = promisify(_execFile);
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
const WORK = mkdtempSync(join(tmpdir(), "ccdiag-"));

const MAL = parseInt(process.argv[2] || "3588", 10);
const EP = parseInt(process.argv[3] || "25", 10);

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decodeBlob(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

const STOP = new Set(("the and you that this with for are was but not have has had they them their what when how why who " +
  "yeah gonna wanna just like right now here there your from would could should about get got one all can will " +
  "don didn isn aren wasn weren out him her she his hers its it's i'm we're he's that's let okay ok yes").split(" "));
function tokens(text) {
  return text.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|[♪♫…"'’‘“”]/g, " ").replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

async function main() {
  const url = `${ORIGIN}/stream/mal/${MAL}/${EP}/dub`;
  const html = await (await fetch(url, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) })).text();
  const m = html.match(/window\.__P="([^"]+)"/);
  const json = decodeBlob(m[1]);
  const track = json.subtitles.find((t) => t.label?.toLowerCase() === "english") ?? json.subtitles[0];
  const vtt = await (await fetch(track.src, { headers: H, signal: AbortSignal.timeout(25_000) })).text();
  const cues = [];
  for (const block of vtt.replace(/^X-TIMESTAMP-MAP=.*$/gm, "").replace(/^WEBVTT[^\n]*$/gm, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const toS = (s) => { const p = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/); if (!p) return NaN; const ms = p[4].length === 1 ? p[4] * 100 : p[4].length === 2 ? p[4] * 10 : +p[4]; return (+(p[1] || 0)) * 3600 + (+p[2]) * 60 + (+p[3]) + ms / 1000; };
    const txt = lines.filter((l) => l !== tl && !/^\d+$/.test(l)).join(" ").replace(/<[^>]+>/g, "").trim();
    if (txt) cues.push({ start: toS(a), end: toS(b), text: txt });
  }
  // m3u8 timeline
  const mtext = await (await fetch(json.src, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), json.src).href;
  const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const segs = []; let t = 0;
  const vl = vtext.split("\n");
  for (let i = 0; i < vl.length; i++) {
    const mm = vl[i].match(/^#EXTINF:([\d.]+)/);
    if (mm) { const dur = parseFloat(mm[1]); const u = (vl[i + 1] ?? "").trim(); if (u && !u.startsWith("#")) { segs.push({ url: new URL(u, vurl).href, start: t, dur }); t += dur; } }
  }
  const total = t;
  console.log(`total=${total.toFixed(0)}s cues=${cues.length}`);

  const zoneA = Math.max(60, total * 0.2), zoneB = total * 0.78;
  const cands = cues.filter((c) => c.start >= zoneA && c.start <= zoneB && tokens(c.text).length >= 3);
  const picks = [0.25, 0.5, 0.75].map((f) => {
    const target = zoneA + f * (zoneB - zoneA);
    return cands.sort((x, y) => Math.abs(x.start - target) - Math.abs(y.start - target))[0];
  });

  for (let qi = 0; qi < picks.length; qi++) {
    const cue = picks[qi];
    const strong = [...new Set(tokens(cue.text).slice(0, 6))];
    console.log(`\n=== cue ${qi}: t=${cue.start.toFixed(1)} "${cue.text.slice(0, 70)}"`);
    console.log(`    strong: ${strong.join(", ")}`);
    const t0 = Math.max(0, cue.start - 7), W = 18;
    const covering = segs.filter((s) => s.start + s.dur > t0 && s.start < t0 + W);
    const bufs = await Promise.all(covering.map(async (s) => Buffer.from(await (await fetch(s.url, { headers: H, signal: AbortSignal.timeout(60_000) })).arrayBuffer())));
    const ts = join(WORK, `q${qi}.ts`);
    writeFileSync(ts, Buffer.concat(bufs));
    const wav = join(WORK, `q${qi}.wav`);
    await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", ts, "-ss", (t0 - covering[0].start).toFixed(2), "-t", String(W), "-vn", "-ac", "1", "-ar", "16000", wav]);
    for (let k = 0; k < 9; k++) {
      const off = k * 2;
      if (off >= W) break;
      const bw = join(WORK, `q${qi}-b${k}.wav`);
      await execFile("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", wav, "-ss", String(off), "-t", "2", "-vn", "-ac", "1", "-ar", "16000", bw]);
      const b64 = readFileSync(bw).toString("base64");
      const out = join(WORK, `q${qi}-b${k}.json`);
      let text = "";
      try {
        const { stdout } = await execFile("z-ai", ["asr", "--base64", b64, "-o", out], { timeout: 90_000 });
        const f = stdout.match(/File saved to: (\S+)/)?.[1] ?? out;
        text = (JSON.parse(readFileSync(f, "utf8")).text ?? "").trim();
      } catch (e) { text = `<asr-err ${String(e.message).slice(0, 40)}>`; }
      const bt = new Set(tokens(text));
      const score = strong.filter((w) => bt.has(w)).length;
      console.log(`  bin@+${off}s (abs ${cue.start - 7 + off | 0}): score=${score} "${text.slice(0, 72)}"`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
