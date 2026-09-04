/**
 * Verify megaplay buzz-page dub for one ep is REAL English audio:
 *   1. resolve via buzz data-id path (same as lib/megaplay buzzPageDubRaw)
 *   2. download a dialogue segment
 *   3. audio MD5 vs the zoko sub stream's same-index segment (identical => fake)
 *   4. extract 20s WAV for ASR
 * Usage: node scripts/mega-dub-audio.mjs <malId> <ep> [segIdx] [<subSrcUrl>]
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BUZZ = "https://megaplay.buzz";
const PROXY = "http://localhost:3000/api/stream/proxy?u=";
const px = (url) => `${PROXY}${encodeURIComponent(url)}`;

const [malId, epArg, segIdxArg, subSrc] = process.argv.slice(2);
const ep = parseInt(epArg || "1", 10);
const segIdx = parseInt(segIdxArg || "6", 10);

const page = await fetch(`${BUZZ}/stream/mal/${malId}/${ep}/dub`, {
  headers: { "User-Agent": UA, Referer: BUZZ, Accept: "text/html" }, signal: AbortSignal.timeout(20_000),
}).then((r) => r.text());
const m = page.match(/data-id="(\d+)"/);
if (!m) { console.log("no data-id on buzz page"); process.exit(1); }
const src = await fetch(`${BUZZ}/stream/getSources?id=${m[1]}&type=dub`, {
  headers: { "User-Agent": UA, Referer: BUZZ, Accept: "application/json" }, signal: AbortSignal.timeout(20_000),
}).then((r) => r.json());
const master = src?.sources?.file;
console.log("data-id:", m[1], "\nmaster:", master);
if (!master) { console.log("no master m3u8"); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), "mega-audio-"));
const mres = await fetch(master, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(20_000) });
const mtext = await mres.text();
const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
console.log("variants:", variants.length);
const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), master).href;
const vtext = await (await fetch(vurl, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(20_000) })).text();
const segs = vtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const segUrl = new URL(segs[Math.min(segIdx, segs.length - 1)].trim(), vurl).href;
const buf = Buffer.from(await (await fetch(segUrl, { headers: { "User-Agent": UA, Referer: BUZZ }, signal: AbortSignal.timeout(60_000) })).arrayBuffer());
const f = join(dir, "mega-dub.ts");
writeFileSync(f, buf);
const audioMd5 = execSync(`ffmpeg -v error -i "${f}" -map 0:a -f md5 -`, { encoding: "utf8" }).trim();
const wav = join(dir, "mega-dub.wav");
execSync(`ffmpeg -v error -y -i "${f}" -ss 3 -t 20 -vn -ac 1 -ar 16000 "${wav}"`, { encoding: "utf8" });
console.log("seg bytes:", buf.length, "| audioMd5:", audioMd5);
console.log("WAV:", wav);

if (subSrc) {
  const sres = await fetch(px(new URL(segs[Math.min(segIdx, segs.length - 1)].trim(), new URL(variants[0].trim(), master).href).href));
  // fetch same-index sub segment via app proxy for MD5 compare
  const smaster = await (await fetch(px(subSrc), { signal: AbortSignal.timeout(30_000) })).text();
  const svars = smaster.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const svurl = decodeURIComponent(svars[Math.min(1, svars.length - 1)].split("u=")[1]);
  const svtext = await (await fetch(px(svurl), { signal: AbortSignal.timeout(30_000) })).text();
  const ssegs = svtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const ssegUrl = decodeURIComponent(ssegs[Math.min(segIdx, ssegs.length - 1)].split("u=")[1]);
  const sbuf = Buffer.from(await (await fetch(px(ssegUrl), { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  const sf = join(dir, "sub.ts");
  writeFileSync(sf, sbuf);
  const smd5 = execSync(`ffmpeg -v error -i "${sf}" -map 0:a -f md5 -`, { encoding: "utf8" }).trim();
  console.log("sub audioMd5:", smd5);
  console.log("mega-dub SAME audio as sub?", audioMd5 === smd5 ? "YES — STILL FAKE" : "no — different audio, promising");
}
