/**
 * ASR-verify one (malId, ep, server) DUB stream is English: extract three
 * dialogue windows across the episode, transcribe each, print.
 * Usage: node scripts/asr-verify-ep.mjs <malId> <ep> <server>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
const [malId, ep, server] = process.argv.slice(2);

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

const url = server === "kiwi" ? `${ORIGIN}/stream/mal/${malId}/${ep}/dub?server=kiwi` : `${ORIGIN}/stream/mal/${malId}/${ep}/dub`;
const html = await (await fetch(url, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) })).text();
const payload = decode(html.match(/window\.__P="([^"]+)"/)[1]);

const mtext = await (await fetch(payload.src, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), payload.src).href;
const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
const lines = vtext.split("\n");
const segs = []; let t = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^#EXTINF:([\d.]+)/);
  if (m) { const dur = parseFloat(m[1]); const u = (lines[i + 1] ?? "").trim(); if (u && !u.startsWith("#")) { segs.push({ url: new URL(u, vurl).href, start: t, dur }); t += dur; } }
}
console.log(`malId ${malId} ep ${ep} ${server}: ${segs.length} segs, ${Math.round(t)}s`);

const dir = mkdtempSync(join(tmpdir(), "asrverify-"));
for (const frac of [0.3, 0.5, 0.7]) {
  const T = t * frac;
  const seg = segs.find((s) => T >= s.start && T < s.start + s.dur);
  if (!seg) continue;
  const buf = Buffer.from(await (await fetch(seg.url, { headers: H, signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  const f = join(dir, `d${frac}.ts`); writeFileSync(f, buf);
  const wav = join(dir, `d${frac}.wav`);
  try { execFileSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-ss", (T - seg.start).toFixed(2), "-t", "25", "-vn", "-ac", "1", "-ar", "16000", wav]); } catch (e) { console.log(`frac ${frac}: ffmpeg fail`); continue; }
  try {
    const out = execFileSync("z-ai", ["asr", "--file", wav, "-o", join(dir, `d${frac}.json`)], { encoding: "utf8", timeout: 180_000 });
    const of = out.match(/File saved to: (\S+)/)?.[1];
    const text = of ? (JSON.parse(readFileSync(of, "utf8")).text ?? "") : "";
    const jp = /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    console.log(`t=${Math.round(T)}s [${jp ? "JAPANESE" : "english?"}]: "${text.slice(0, 110)}"`);
  } catch (e) { console.log(`frac ${frac}: asr fail`); }
}
