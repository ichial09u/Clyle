/**
 * Probe all candidate DUB sources for one anime/ep and verdict the AUDIO
 * language: download a dialogue segment, audio-MD5-compare vs the sub stream,
 * and ASR-transcribe. Prints a table.
 * Usage: node scripts/dub-audit.mjs <malId> <ep>
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BUZZ = "https://megaplay.buzz";
const PROXY = "http://localhost:3000/api/stream/proxy?u=";
const px = (u) => `${PROXY}${encodeURIComponent(u)}`;
const [malId, epArg] = process.argv.slice(2);
const ep = parseInt(epArg || "1", 10);
const dir = mkdtempSync(join(tmpdir(), "dubaudit-"));

async function audioMd5Of(buf, name) {
  const f = join(dir, name);
  writeFileSync(f, buf);
  return execSync(`ffmpeg -v error -i "${f}" -map 0:a -f md5 -`, { encoding: "utf8" }).trim();
}

async function segAudioMd5(masterUrl, referer, name, segIdx) {
  const H = { "User-Agent": UA, Referer: referer };
  const master = await (await fetch(masterUrl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const variants = master.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const vurl = new URL(variants[0].trim(), masterUrl).href; // top variant = highest quality usually first
  const vtext = await (await fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) })).text();
  const segs = vtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const segUrl = new URL(segs[Math.min(segIdx, segs.length - 1)].trim(), vurl).href;
  const res = await fetch(segUrl, { headers: H, signal: AbortSignal.timeout(60_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100_000 || buf[0] !== 0x47) return { error: `seg ${res.status}, ${buf.length}B, not TS` };
  const md5 = await audioMd5Of(buf, name);
  const wav = join(dir, `${name}.wav`);
  try { execSync(`ffmpeg -v error -y -i "${f(buf, name)}" -ss 1 -t 18 -vn -ac 1 -ar 16000 "${wav}"`); } catch { return { md5, wav: null }; }
  return { md5, wav, segCount: segs.length };
}
const f = (p, n) => join(dir, n);

// 1. sub reference via app API
const sub = await fetch(`http://localhost:3000/api/stream?malId=${malId}&ep=${ep}&lang=sub&server=zoko`).then((r) => r.json());
const subRef = await segAudioMd5(sub.src, "https://zokoanime.video/", "subref.ts", 8).catch((e) => ({ error: e.message }));
console.log("SUB ref:", JSON.stringify(subRef));

// 2. buzz mal-page path
let buzz = null;
try {
  const page = await (await fetch(`${BUZZ}/stream/mal/${malId}/${ep}/dub`, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(20_000) })).text();
  const m = page.match(/data-id="(\d+)"/);
  if (m) {
    const src = await (await fetch(`${BUZZ}/stream/getSources?id=${m[1]}&type=dub`, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(20_000) })).json();
    const master = src?.sources?.file;
    if (master) {
      buzz = { dataId: m[1], master };
      const r = await segAudioMd5(master, "https://megaplay.buzz/", "buzz.ts", 8).catch((e) => ({ error: e.message }));
      buzz = { ...buzz, ...r };
    }
  }
} catch (e) { buzz = { error: e.message }; }
console.log("BUZZ page:", JSON.stringify(buzz));

// 3. anikoto embed path
let koto = null;
try {
  const seriesId = 4; // Dandadan
  const eps = await fetch(`https://anikotoapi.site/series/${seriesId}`, { headers: { "User-Agent": UA, Referer: "https://anikototv.to/" }, signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const embedId = (eps?.data?.episodes ?? []).find((e) => Number(e.number ?? e.episode) === ep)?.episode_embed_id;
  if (embedId) {
    const src = await (await fetch(`https://megaplay.buzz/stream/getSources?id=${embedId}&type=dub`, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(20_000) })).json();
    const master = src?.sources?.file;
    koto = { embedId: Number(embedId), master };
    if (master) {
      const r = await segAudioMd5(master, "https://megaplay.buzz/", "koto.ts", 8).catch((e) => ({ error: e.message }));
      koto = { ...koto, ...r };
    }
  } else koto = { error: `no embedId for ep ${ep}` };
} catch (e) { koto = { error: e.message }; }
console.log("ANIKOTO embed:", JSON.stringify(koto));

const same = (a, b) => a && b && a === b;
console.log("\n--- verdicts (seg idx 8) ---");
console.log("buzz audio == sub audio?", same(buzz?.md5, subRef?.md5) ? "YES FAKE" : "no (different)");
console.log("koto audio == sub audio?", same(koto?.md5, subRef?.md5) ? "YES FAKE" : "no (different)");
for (const [n, r] of [["buzz", buzz], ["koto", koto]]) if (r?.wav) console.log(`${n} WAV:`, r.wav);
