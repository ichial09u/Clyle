#!/usr/bin/env node
/**
 * Probe ONE South Park dub stream end-to-end, the way the user's browser does:
 *   1. /api/stream (production) -> direct MP4 src
 *   2. Range-GET the src with the app's origin as Referer (what <video> sends)
 *   3. Range-GET with no referer (diagnostic)
 * Usage: node scripts/sp-probe-one.mjs [malId] [ep] [lang]
 */
const BASE = process.env.BASE || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const malId = process.argv[2] || "999901";
const ep = process.argv[3] || "1";
const lang = process.argv[4] || "dub";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const r = await fetch(`${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=${lang}`);
const body = await r.json().catch(() => ({}));
console.log(`stream api: http=${r.status} provider=${body.provider} direct=${body.direct} server=${body.server}`);
if (!body.src) {
  console.log("NO SRC:", JSON.stringify(body).slice(0, 200));
  process.exit(1);
}
console.log(`src: ${body.src.slice(0, 90)}...`);

async function probe(label, headers) {
  try {
    const res = await fetch(body.src, { headers: { "User-Agent": UA, Range: "bytes=0-1023", ...headers } });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type");
    const magic = Buffer.from(buf.slice(0, 12)).toString("hex");
    const looksMp4 = magic.includes("66747970") || magic.includes("0000"); // ftyp box or size prefix
    console.log(`${label}: http=${res.status} ct=${ct} bytes=${buf.byteLength} magic=${magic.slice(0, 16)} mp4ish=${looksMp4}`);
    return res.ok && buf.byteLength > 0;
  } catch (e) {
    console.log(`${label}: FETCH FAIL ${e.message}`);
    return false;
  }
}

const appRef = await probe("with OUR referer ", { Referer: "https://temporary-spry-granite-1f0h7ae.vercel.app/" });
const noRef = await probe("with NO referer   ", {});
const wcoRef = await probe("with WCO referer  ", { Referer: "https://www.wcostream.tv/" });
console.log(`VERDICT app-ref=${appRef ? "OK" : "FAIL"} no-ref=${noRef ? "OK" : "FAIL"} wco-ref=${wcoRef ? "OK" : "FAIL"}`);
