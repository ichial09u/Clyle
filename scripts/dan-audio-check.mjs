/**
 * Dandadan dub audio verification — download dialogue segments from the dub
 * (kiwi) and sub (zoko) streams via the local proxy, then:
 *   1. ffprobe language tags / channels
 *   2. decoded-audio MD5 compare (identical => "dub" is the Japanese audio)
 *   3. extract 20s WAV clips for ASR language identification
 *
 * Usage: node scripts/dan-audio-check.mjs <dubSrcUrl> <subSrcUrl> [segIndex]
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROXY = "http://localhost:3000/api/stream/proxy?u=";
const px = (url) => `${PROXY}${encodeURIComponent(url)}`;

async function fetchText(url) {
  const res = await fetch(px(url), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

async function analyze(label, masterUrl, segIndex, dir) {
  const master = await fetchText(masterUrl);
  // pick the 720p variant (2nd line) — deterministic bandwidth
  const variants = master.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const vurl0 = variants[Math.min(1, variants.length - 1)];
  const vurl = vurl0.includes("/api/stream/proxy?")
    ? decodeURIComponent(vurl0.split("u=")[1])
    : new URL(vurl0, masterUrl).href;
  const vtext = await fetchText(vurl);
  const lines = vtext.split("\n");
  const segs = lines.filter((l) => l.trim() && !l.startsWith("#"));
  const idx = Math.min(segIndex, segs.length - 1);
  const seg0 = segs[idx];
  const segUrl = seg0.includes("/api/stream/proxy?") ? decodeURIComponent(seg0.split("u=")[1]) : new URL(seg0, vurl).href;
  const res = await fetch(px(segUrl), { signal: AbortSignal.timeout(60_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const f = join(dir, `${label}.ts`);
  writeFileSync(f, buf);
  const probe = execSync(
    `ffprobe -v error -show_entries stream=index,codec_name,codec_type,channels:stream_tags=language -of json "${f}"`,
    { encoding: "utf8" },
  );
  const j = JSON.parse(probe);
  const audioMd5 = execSync(`ffmpeg -v error -i "${f}" -map 0:a -f md5 -`, { encoding: "utf8" }).trim();
  // 20s clip starting 3s in, mono 16k WAV for ASR
  const wav = join(dir, `${label}.wav`);
  execSync(`ffmpeg -v error -y -i "${f}" -ss 3 -t 20 -vn -ac 1 -ar 16000 "${wav}"`, { encoding: "utf8" });
  const streams = (j.streams ?? []).map((s) => `${s.codec_type}:${s.codec_name}${s.channels ? ` ch=${s.channels}` : ""}${s.language ? ` lang=${s.language}` : ""}`);
  return { label, segIdx: idx, bytes: buf.length, streams, audioMd5, wav };
}

const [dubSrc, subSrc, segIdxArg] = process.argv.slice(2);
const segIdx = parseInt(segIdxArg || "6", 10);
const dir = mkdtempSync(join(tmpdir(), "dan-audio-"));
const d = await analyze("dub", dubSrc, segIdx, dir);
const s = await analyze("sub", subSrc, segIdx, dir);
console.log("dub:", JSON.stringify({ ...d, wav: undefined }));
console.log("sub:", JSON.stringify({ ...s, wav: undefined }));
console.log("SAME audio?", d.audioMd5 === s.audioMd5 ? "YES — DUB IS FAKE (Japanese audio)" : "no — different audio (could be real dub OR different Japanese transcode)");
console.log("WAV clips:", d.wav, "|", s.wav);
