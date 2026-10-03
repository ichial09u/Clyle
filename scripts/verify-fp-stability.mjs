/**
 * Stability check: fingerprint FMA:B (5114) ep1 sub & dub at EVERY variant,
 * twice, and dump full details — validates that byte-compare verdicts are
 * stable across runs (CDN token rotation must not change segment content).
 *
 * Usage: node scripts/verify-fp-stability.mjs [malId=5114]
 */
const { createHash } = await import("node:crypto");
const OBF_KEY = "otaku-embed-v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEAD = 192 * 1024;

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  return out;
}
const H = () => ({ "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" });

async function src(malId, lang) {
  const res = await fetch(`https://zokoanime.video/stream/mal/${malId}/1/${lang}`, { headers: H(), cache: "no-store", redirect: "follow" });
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  const json = JSON.parse(Buffer.from(xor(atob(m[1].trim())), "latin1").toString("utf8"));
  return json.src;
}

async function variants(masterUrl) {
  const master = await (await fetch(masterUrl, { headers: H(), cache: "no-store" })).text();
  const lines = master.split("\n").map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const res = /RESOLUTION=([^,]+)/.exec(lines[i])?.[1] ?? "?";
      out.push({ res, url: new URL(lines[i + 1], masterUrl).href });
    }
  }
  return out;
}

async function fp(variantUrl) {
  const pl = await (await fetch(variantUrl, { headers: H(), cache: "no-store" })).text();
  const seg = pl.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const segRes = await fetch(new URL(seg, variantUrl).href, { headers: { ...H(), Range: `bytes=0-${HEAD - 1}` }, cache: "no-store" });
  const buf = Buffer.from(await segRes.arrayBuffer());
  const cr = segRes.headers.get("content-range") ?? "";
  return { sha1: createHash("sha1").update(buf).digest("hex").slice(0, 12), bytes: buf.length, total: cr.split("/")[1] ?? "?", seg };
}

const malId = parseInt(process.argv[2] ?? "5114", 10);
for (let run = 1; run <= 2; run++) {
  console.log(`\n===== RUN ${run} (malId ${malId}) =====`);
  for (const lang of ["sub", "dub"]) {
    const master = await src(malId, lang);
    console.log(`${lang.toUpperCase()} master: ${master}`);
    for (const v of await variants(master)) {
      const f = await fp(v.url);
      console.log(`  ${v.res}: seg=${f.seg} sha1=${f.sha1} total=${f.total}`);
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}
