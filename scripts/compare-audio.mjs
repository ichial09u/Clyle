/** Compare sub vs dub: total playlist duration + decoded-audio MD5 of segment 5. */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const { execSync } = await import("node:child_process");
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
function xor(str) { let o=""; for (let i=0;i<str.length;i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(b) { return JSON.parse(decodeURIComponent(escape(xor(atob(b))))); }
async function payload(malId, ep, lang) {
  const res = await fetch(`${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20000) });
  const m = (await res.text()).match(/window\.__P="([^"]+)"/);
  return m ? decode(m[1]) : null;
}
async function analyze(malId, ep, lang, dir) {
  const p = await payload(malId, ep, lang);
  if (!p) return null;
  const mtext = await (await fetch(p.src, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } })).text();
  const firstVar = mtext.split("\n").filter((l) => l && !l.startsWith("#"))[0];
  const vurl = new URL(firstVar, p.src).href;
  const vtext = await (await fetch(vurl, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } })).text();
  const lines = vtext.split("\n");
  let dur = 0;
  for (const l of lines) { const m = l.match(/^#EXTINF:([\d.]+)/); if (m) dur += parseFloat(m[1]); }
  const segs = lines.filter((l) => l && !l.startsWith("#"));
  const seg = segs[4];
  const buf = Buffer.from(await (await fetch(new URL(seg, vurl).href, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` } })).arrayBuffer());
  const f = join(dir, `${lang}.ts`); writeFileSync(f, buf);
  const audioMd5 = execSync(`ffmpeg -v error -i "${f}" -map 0:a -f md5 -`, { encoding: "utf8" }).trim();
  const videoMd5 = execSync(`ffmpeg -v error -i "${f}" -map 0:v -f md5 -`, { encoding: "utf8" }).trim();
  return { videoId: p.video_id, totalDur: Math.round(dur), segBytes: buf.length, audioMd5, videoMd5 };
}
const [malId, ep] = [parseInt(process.argv[2]), parseInt(process.argv[3] || "1")];
const dir = mkdtempSync(join(tmpdir(), "cmpaud-"));
const s = await analyze(malId, ep, "sub", dir);
const d = await analyze(malId, ep, "dub", dir);
console.log(`malId ${malId} ep ${ep}`);
console.log(" sub:", JSON.stringify(s));
console.log(" dub:", JSON.stringify(d));
if (s && d) {
  console.log(" SAME video file?", s.videoMd5 === d.videoMd5 ? "YES (mislabeled)" : "no");
  console.log(" SAME audio?", s.audioMd5 === d.audioMd5 ? "YES (Japanese audio under DUB label!)" : "no — different audio track (likely real dub)");
}
