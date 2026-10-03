/**
 * Verify the flikhub dub m3u8s for Edgerunners (42310) — key is `m3u8`.
 * Real-segment rule from megaplay.ts: seg-N- lines, no tiktokcdn, then pull
 * a middle segment and count bytes.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";

const MALID = 42310;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function curl(url, extra = [], out = null, timeout = 25) {
  const args = ["-sS", "--max-time", String(timeout), "-L", "-A", UA, "-w", "%{http_code}", ...extra, url];
  if (out) args.splice(2, 0, "-o", out, "-r", "0..300000");
  return new Promise((resolve) => {
    execFile("curl", args, { maxBuffer: 64 * 1024 * 1024, timeout: (timeout + 5) * 1000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ status: 0, body: "" });
      const m = String(stdout).match(/(\d+)\s*$/);
      resolve({ status: m ? parseInt(m[1], 10) : 0, body: out ? "" : String(stdout).replace(/(\d+)\s*$/, "") });
    });
  });
}
const hdr = (h) => ["-H", h];

async function verify(m3u8Url) {
  const first = await curl(m3u8Url, hdr("Referer: https://megaplay.buzz/"));
  if (first.status !== 200) return { ok: false, why: `master HTTP ${first.status}` };
  let playlist = first.body;
  let playlistUrl = m3u8Url;
  const variant = first.body.split("\n").map((s) => s.trim()).find((l) => l && !l.startsWith("#"));
  if (variant && !/\.m3u8/.test(m3u8Url.split("/").pop() || "")) {
    // master likely lists variant playlists
  }
  if (variant) {
    playlistUrl = new URL(variant, m3u8Url).href;
    const v = await curl(playlistUrl, hdr("Referer: https://megaplay.buzz/"));
    if (v.status !== 200) return { ok: false, why: `variant HTTP ${v.status}` };
    playlist = v.body;
  }
  const segLines = playlist.split("\n").filter((l) => {
    const s = l.trim();
    return s && !s.startsWith("#") && !/tiktokcdn\.com|adimage|advert/i.test(s);
  });
  const total = segLines.length;
  const durMatch = playlist.match(/#EXTINF:([\d.]+)/g);
  const totalDur = (durMatch || []).reduce((a, d) => a + parseFloat(d.replace("#EXTINF:", "")), 0);
  if (total < 3) return { ok: false, why: `only ${total} segments (ad-stub)`, total };
  const mid = segLines[Math.floor(total / 2)].split("?")[0] ? segLines[Math.floor(total / 2)] : segLines[0];
  const surl = new URL(mid.trim(), playlistUrl).href;
  const sres = await curl(surl, ["-o", "/tmp/edg-seg.bin", "-r", "0..300000", hdr("Referer: https://megaplay.buzz/")]);
  let bytes = 0;
  try { bytes = statSync("/tmp/edg-seg.bin").size; } catch { /* missing */ }
  // audio stream check: count EXT-X-MEDIA / audio entries
  const hasAudio = /EXT-X-MEDIA:.*AUDIO|audio-only|_A\d|audio_/.test(playlist) || /CODECS.*mp4a|aac/i.test(playlist);
  return { ok: sres.status === 206 || sres.status === 200, why: `seg HTTP ${sres.status}, ${bytes}B`, total, totalDur: Math.round(totalDur), hasAudio };
}

async function main() {
  for (const ep of [8, 1]) {
    const r = await curl(`https://api.flikhub.net/megaplay?mal=${MALID}&ep=${ep}&type=dub`, hdr("Referer: https://megaplay.buzz/"));
    let m3u8 = null;
    try { m3u8 = JSON.parse(r.body).m3u8 || null; } catch { /* */ }
    if (!m3u8) { console.log(`ep${ep}: no m3u8 (HTTP ${r.status}) ${r.body.slice(0, 120)}`); continue; }
    const host = new URL(m3u8).host;
    const v = await verify(m3u8);
    console.log(`ep${ep} DUB: ${v.ok ? "REAL ✔" : "MISS ✘"}  host=${host}  segs=${v.total ?? "?"}  dur=${v.totalDur ?? "?"}s  audio=${v.hasAudio ? "yes" : "?"}  (${v.why})`);
    await new Promise((res) => setTimeout(res, 700));
  }
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
