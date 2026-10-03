/**
 * ASR-verify the KIWI DUB stream for Cyberpunk: Edgerunners is real English.
 * Same flow as edgerunners-zoko-asr.mjs but server=kiwi.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ep = parseInt(process.argv[2] || "1", 10);
const segNo = parseInt(process.argv[3] || "22", 10);

const route = JSON.parse(
  (await pexec("curl", ["-s", "-m", "60", `http://localhost:3000/api/stream?malId=42310&ep=${ep}&lang=dub&server=kiwi`], { timeout: 70_000 })).stdout,
);
console.log("provider:", route.provider, "| resolvedFrom:", (route.resolvedFrom || "").slice(0, 80));
const src = route.src;
console.log("src:", src.slice(0, 90));
if (route.error) { console.log("unavailable"); process.exit(0); }

const H = ["-A", UA, "-H", "Referer: https://kiwianimefile.ru/"];
const master = (await pexec("curl", ["-s", "-m", "20", ...H, src], { timeout: 30_000 })).stdout;
const variants = master.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
console.log("variants:", variants.length);
const mbase = src.substring(0, src.lastIndexOf("/") + 1);
let vtext = null;
let vurl = null;
for (const v of variants) {
  vurl = new URL(v, mbase).href;
  const t = (await pexec("curl", ["-s", "-m", "20", ...H, vurl], { timeout: 30_000 })).stdout;
  if (t.includes("#EXTINF")) { vtext = t; break; }
}
if (!vtext) throw new Error("no variant playlist with segments");
const vbase = vurl.substring(0, vurl.lastIndexOf("/") + 1);
const segs = vtext.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const pick = segs[Math.min(segNo, segs.length - 1)];
const segUrl = new URL(pick, vbase).href;
console.log(`segments: ${segs.length} | picking #${segNo}`);

await pexec("curl", ["-s", "-m", "40", ...H, segUrl, "-o", "/tmp/edg-kseg.ts"], { timeout: 50_000 });
const ff = (args) => pexec("ffmpeg", ["-hide_banner", "-v", "error", ...args], { timeout: 60_000 });
await ff(["-y", "-i", "/tmp/edg-kseg.ts", "-ss", "1", "-t", "16", "-vn", "-ac", "1", "-ar", "16000", "/tmp/edg-kseg.wav"]);
console.log("segment + wav ready");

await pexec("z-ai", ["asr", "--file", "/tmp/edg-kseg.wav", "-o", "/tmp/edg-kseg-asr.json"], { timeout: 90_000 });
const asr = JSON.parse(await import("node:fs").then((m) => m.readFileSync("/tmp/edg-kseg-asr.json", "utf8")));
console.log("ASR transcript:", asr.text);
