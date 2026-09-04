/**
 * ASR-listen to a megaplay/yenime DUB HLS stream — does it speak English or Japanese?
 * Usage: node scripts/probe-mega-asr.mjs <masterM3u8Url> [label]
 * Referer megaplay.buzz is injected automatically (CDN requirement).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Referer: "https://megaplay.buzz/", Accept: "*/*" };
const [masterUrl, label = "mega"] = process.argv.slice(2);

async function playlist(master) {
  const mtext = await (await fetch(master, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), master).href;
  const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const lines = vtext.split("\n");
  const segs = []; let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:([\d.]+)/);
    if (m) { const dur = parseFloat(m[1]); const u = (lines[i + 1] ?? "").trim(); if (u && !u.startsWith("#")) { segs.push({ url: new URL(u, vurl).href, start: t, dur }); t += dur; } }
  }
  return { segs, total: t };
}

const { segs, total } = await playlist(masterUrl);
console.log(`[${label}] ${segs.length} segs, ${Math.round(total)}s`);
const dir = mkdtempSync(join(tmpdir(), "megaasr-"));
for (const frac of [0.3, 0.5, 0.7]) {
  const T = total * frac;
  const seg = segs.find((s) => T >= s.start && T < s.start + s.dur);
  if (!seg) continue;
  try {
    const buf = Buffer.from(await (await fetch(seg.url, { headers: H, signal: AbortSignal.timeout(60_000) })).arrayBuffer());
    const f = join(dir, `d${frac}.ts`); writeFileSync(f, buf);
    const wav = join(dir, `d${frac}.wav`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", f, "-ss", (T - seg.start).toFixed(2), "-t", "25", "-vn", "-ac", "1", "-ar", "16000", wav]);
    const out = execFileSync("z-ai", ["asr", "--file", wav, "-o", join(dir, `d${frac}.json`)], { encoding: "utf8", timeout: 180_000 });
    const of = out.match(/File saved to: (\S+)/)?.[1];
    const text = of ? (JSON.parse(readFileSync(of, "utf8")).text ?? "") : "";
    const jp = /[\u3040-\u30ff]/.test(text);
    const cjk = /[\u4e00-\u9fff]/.test(text);
    console.log(`t=${Math.round(T)}s [${jp || cjk ? "JAPANESE" : "latin?"}]: "${text.slice(0, 130)}"`);
  } catch (e) {
    console.log(`t=${Math.round(T)}s: ${e.message?.slice(0, 80) || "fail"}`);
  }
}
