// Inspect decrypted variant playlists + test a segment
import { execFileSync } from "node:child_process";

const pkHex = process.argv[2];
const pk = Buffer.from(pkHex, "hex");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const xor = (buf) => { const o = Buffer.from(buf); for (let i = 0; i < o.length; i++) o[i] ^= pk[i % pk.length]; return o; };
const get = (url) => execFileSync("curl", ["-sS","-m","30","-L","-A",UA,"-H","accept: */*","-H","referer: https://flixcloud.cc/",url], { maxBuffer: 50*1024*1024 });

for (const url of process.argv.slice(3)) {
  const raw = get(url);
  if (raw.slice(0, 7).toString() === "#EXTM3U") { console.log("PLAINTEXT:", url); console.log(raw.toString().slice(0, 600)); continue; }
  const dec = xor(raw).toString("utf8");
  console.log("=== " + url + " → " + (dec.includes("#EXTM3U") ? "DECRYPTED OK" : "FAILED") + " ===");
  const lines = dec.split("\n");
  console.log("lines:", lines.length);
  // print key tags and first/last segments
  for (const l of lines) {
    if (l.startsWith("#EXT-X-KEY") || l.startsWith("#EXT-X-MAP") || l.startsWith("#EXT-X-ENDLIST") || l.startsWith("#EXT-X-TARGETDURATION")) console.log("  TAG:", l.slice(0, 160));
  }
  const segs = lines.filter((l) => l && !l.startsWith("#"));
  console.log("  segments:", segs.length);
  console.log("  first:", segs[0]);
  console.log("  last:", segs[segs.length - 1]);
  if (segs.length) {
    const segUrl = new URL(segs[0], url).toString();
    console.log("  testing segment:", segUrl.slice(0, 120));
    const seg = get(segUrl);
    const head = seg.slice(0, 4).toString("hex");
    console.log("  segment bytes:", seg.length, "head:", head, seg.slice(4, 12).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
  }
}
