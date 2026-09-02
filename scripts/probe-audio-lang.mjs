/**
 * Download the 3rd media segment of sub vs dub for one anime episode and
 * ffprobe the audio track (language tag, channels, codec). Compares the two
 * so we can tell whether Zoko's "dub" video really carries different audio.
 */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const { execSync } = await import("node:child_process");
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }

async function payload(malId, ep, lang) {
  const url = `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  return m ? decode(m[1]) : null;
}

async function probeSegment(malId, ep, lang, dir) {
  const p = await payload(malId, ep, lang);
  if (!p) return `no payload`;
  const mres = await fetch(p.src, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } });
  const mtext = await mres.text();
  const firstVar = mtext.split("\n").filter((l) => l && !l.startsWith("#"))[0];
  const vurl = new URL(firstVar, p.src).href;
  const vres = await fetch(vurl, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } });
  const vtext = await vres.text();
  const segs = vtext.split("\n").filter((l) => l && !l.startsWith("#"));
  const seg = segs[Math.min(4, segs.length - 1)]; // 5th segment (skip intro theme)
  const segUrl = new URL(seg, vurl).href;
  const sres = await fetch(segUrl, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } });
  const buf = Buffer.from(await sres.arrayBuffer());
  const f = join(dir, `${malId}-${ep}-${lang}.ts`);
  writeFileSync(f, buf);
  let out = "";
  try {
    out = execSync(
      `ffprobe -v error -show_entries stream=index,codec_name,codec_type,channels:stream_tags=language -of json "${f}"`,
      { encoding: "utf8" },
    );
    const j = JSON.parse(out);
    const lines = (j.streams ?? []).map((s) => `${s.codec_type}:${s.codec_name}${s.channels ? ` ch=${s.channels}` : ""}${s.language ? ` lang=${s.language}` : ""}`);
    return `${p.video_id} seg=${Math.round(buf.length / 1024)}KB -> ${lines.join(" | ")}`;
  } catch (e) {
    return `ffprobe failed: ${String(e.message).slice(0, 100)}`;
  }
}

const [malId, ep] = [parseInt(process.argv[2]), parseInt(process.argv[3] || "1")];
const dir = mkdtempSync(join(tmpdir(), "dubcheck-"));
console.log(`malId ${malId} ep ${ep}:`);
console.log("  sub:", await probeSegment(malId, ep, "sub", dir));
console.log("  dub:", await probeSegment(malId, ep, "dub", dir));
