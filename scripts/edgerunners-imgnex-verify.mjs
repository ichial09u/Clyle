/** Verify the decrypted imgnex master.m3u8s: master -> variant -> real segments -> segment bytes. */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const URLS = {
  "buzz-ep8": "https://cdn.imgnex.top/anime/ba28c7f62e092b90383052c29844fcf8/95062bb210d350e1db5c304cd489ac97/master.m3u8",
  "buzz-ep1": "https://cdn.imgnex.top/anime/ba28c7f62e092b90383052c29844fcf8/b8660c68d8a73f1f49e02c0b6d9d5ca2/master.m3u8",
  "koto-ep8": "https://cdn.imgnex.top/anime/8deb8d1dd92840f975b6931ab3a3c61e/61f79b81608d6164c77cfdc27d3048d2/master.m3u8",
};

function curl(url, extra = [], out = null) {
  const args = ["-sS", "--max-time", "25", "-L", "-A", UA, "-w", "%{http_code}", ...extra, url];
  if (out) args.splice(2, 0, "-o", out, "-r", "0..400000");
  return new Promise((resolve) => {
    execFile("curl", args, { maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ status: 0, body: "" });
      const m = String(stdout).match(/(\d+)\s*$/);
      resolve({ status: m ? parseInt(m[1], 10) : 0, body: out ? "" : String(stdout).replace(/(\d+)\s*$/, "") });
    });
  });
}

async function verify(name, url) {
  const tag = url.includes("8deb8d1d") ? "koto" : url.includes("95062bb2") ? "stub8" : "stub1";
  const first = await curl(url, ["-H", "Referer: https://megaplay.buzz/"]);
  if (first.status !== 200) return console.log(`${name}: master HTTP ${first.status}`);
  let playlist = first.body, playlistUrl = url;
  const lines = first.body.split("\n").map((s) => s.trim());
  const variant = lines.find((l) => l && !l.startsWith("#") && l.endsWith(".m3u8"));
  if (variant) {
    playlistUrl = new URL(variant, url).href;
    const v = await curl(playlistUrl, ["-H", "Referer: https://megaplay.buzz/"]);
    if (v.status !== 200) return console.log(`${name}: variant HTTP ${v.status}`);
    playlist = v.body;
  }
  // structure info
  const resos = [...playlist.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1]);
  const audioTracks = [...playlist.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map((m) => m[0].slice(0, 120));
  const segLines = playlist.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#") && !/tiktokcdn|adimage|advert/i.test(s));
  const durs = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const totalDur = Math.round(durs.reduce((a, b) => a + b, 0));
  console.log(`${name}: variant=${variant ? "yes" : "direct"} resos=[${resos.join(",")}] audioTracks=${audioTracks.length} segs=${segLines.length} dur=${totalDur}s`);
  if (audioTracks.length) console.log(`   audio: ${audioTracks[0].slice(0, 150)}`);
  if (!segLines.length) { console.log(`   -> 0 real segments (ad-stub) playlist head: ${playlist.split("\n").filter(l=>l.trim()&&!l.startsWith("#")).slice(0,3).join(" | ").slice(0,200)}`); return; }
  // sample middle segment bytes
  const mid = segLines[Math.floor(segLines.length / 2)];
  const surl = new URL(mid, playlistUrl).href;
  console.log(`   sample seg: ${surl.slice(0, 140)}`);
  const sres = await curl(surl, ["-o", `/tmp/edg-seg-${tag}.bin`, "-H", "Referer: https://megaplay.buzz/"]);
  let bytes = 0;
  try { bytes = statSync(`/tmp/edg-seg-${tag}.bin`).size; } catch { /* */ }
  console.log(`   seg fetch: HTTP ${sres.status}, ${bytes}B -> ${bytes > 50000 ? "REAL VIDEO ✔" : "NOT REAL ✘"}`);
}

(async () => { for (const [n, u] of Object.entries(URLS)) { await verify(n, u); console.log(); } })();
