#!/usr/bin/env node
/** Stage-by-stage probe: find which fetch aborts in the fleet. */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };
const MAL = parseInt(process.argv[2] || "3588", 10);
const EP = parseInt(process.argv[3] || "1", 10);
const t = (s) => ((performance.now() - T0) / 1000).toFixed(1);
const T0 = performance.now();
function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }

async function stage(name, fn) {
  try {
    const r = await fn();
    console.log(`[${t()}s] ${name}: OK`);
    return r;
  } catch (e) {
    console.log(`[${t()}s] ${name}: FAIL ${String(e.message || e).slice(0, 110)}`);
    throw e;
  }
}

(async () => {
  const html = await stage("zoko page", () => fetch(`${ORIGIN}/stream/mal/${MAL}/${EP}/dub`, { headers: { ...H, Accept: "text/html" }, signal: AbortSignal.timeout(25_000) }).then((r) => r.text()));
  const m = html.match(/window\.__P="([^"]+)"/);
  const json = JSON.parse(decodeURIComponent(escape(xor(atob(m[1])))));
  console.log(`  src host: ${new URL(json.src).hostname}, subs: ${json.subtitles?.length ?? 0}`);
  const track = json.subtitles.find((x) => x.label?.toLowerCase() === "english") ?? json.subtitles?.[0];
  if (track) console.log(`  cc host: ${new URL(track.src).hostname} label=${track.label}`);
  const mtext = await stage("master m3u8", () => fetch(json.src, { headers: H, signal: AbortSignal.timeout(20_000) }).then((r) => r.text()));
  const variants = mtext.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const vurl = new URL(variants[Math.min(1, variants.length - 1)].trim(), json.src).href;
  const vtext = await stage("variant m3u8", () => fetch(vurl, { headers: H, signal: AbortSignal.timeout(20_000) }).then((r) => r.text()));
  const segUrls = vtext.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3);
  const buf = await stage("3 segments", () => Promise.all(segUrls.map((u) => fetch(new URL(u, vurl).href, { headers: H, signal: AbortSignal.timeout(60_000) }).then((r) => r.arrayBuffer()))));
  console.log(`  seg bytes: ${buf.map((b) => b.byteLength).join(",")}`);
  if (track) {
    const vtt = await stage("vtt", () => fetch(track.src, { headers: H, signal: AbortSignal.timeout(25_000) }).then((r) => r.text()));
    console.log(`  vtt bytes: ${vtt.length}`);
  }
  console.log("ALL STAGES OK");
})().catch(() => process.exit(1));
