/**
 * Compare sub vs dub HLS content for the same episode:
 *  - variant playlist segment lists
 *  - first video segment byte size + hash
 * Also probes Zoko's fallback behavior on late episodes / no-dub shows.
 *
 * Usage: node scripts/probe-dub-segments.mjs
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OBF_KEY = "otaku-embed-v1";

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  return out;
}
const { createHash } = await import("node:crypto");

async function fetchPage(malId, ep, lang) {
  const url = `https://zokoanime.video/stream/mal/${malId}/${ep}/${lang}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) return { __http: res.status };
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) return { __noPayload: true };
  const raw = Buffer.from(xor(atob(m[1].trim())), "latin1").toString("utf8");
  const json = JSON.parse(raw);
  return { src: json.src, video_id: json.video_id };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return res.text();
}

async function segmentSummary(masterUrl, tag) {
  const master = await fetchText(masterUrl);
  if (!master) return console.log(`${tag}: master unreachable`);
  // pick the 720p variant (2nd STREAM-INF)
  const lines = master.split("\n");
  let variant = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("EXT-X-STREAM-INF") && lines[i].includes("1280x720")) {
      variant = lines[i + 1]?.trim();
      break;
    }
  }
  if (!variant) variant = lines.find((l) => l && !l.startsWith("#"));
  if (!variant) return console.log(`${tag}: no variant found`);
  const variantUrl = new URL(variant, masterUrl).href;
  const pl = await fetchText(variantUrl);
  if (!pl) return console.log(`${tag}: variant unreachable`);
  const segs = pl.split("\n").filter((l) => l && !l.startsWith("#"));
  const first = segs[0] ? new URL(segs[0], variantUrl).href : null;
  const last = segs.length ? new URL(segs[segs.length - 1], variantUrl).href : null;
  console.log(`${tag}: variant=${variantUrl}`);
  console.log(`${tag}: segments=${segs.length} first=${segs[0] ?? "-"} last=${segs[segs.length - 1] ?? "-"}`);
  if (!first) return;
  // head of first segment (range download to keep it light)
  const res = await fetch(first, {
    headers: { "User-Agent": UA, Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/", Range: "bytes=0-262143" },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${tag}: firstSeg http=${res.status} bytes=${buf.length} sha1=${createHash("sha1").update(buf).digest("hex").slice(0, 16)} contentRange=${res.headers.get("content-range")}`);
  return { segCount: segs.length, firstBuf: buf, firstSegUrl: first, lastSegUrl: last };
}

async function compare(malId, title, ep) {
  console.log(`\n===== ${title} (malId ${malId}) ep${ep} =====`);
  const sub = await fetchPage(malId, ep, "sub");
  await new Promise((r) => setTimeout(r, 500));
  const dub = await fetchPage(malId, ep, "dub");
  console.log(`SUB src=${sub.src ?? JSON.stringify(sub)} video_id=${sub.video_id}`);
  console.log(`DUB src=${dub.src ?? JSON.stringify(dub)} video_id=${dub.video_id}`);
  if (sub.src && dub.src) {
    console.log(`SRC ${sub.src === dub.src ? "IDENTICAL -> silent sub fallback, NO real dub" : "differ -> distinct dub entry"}`);
  }
  if (sub.src && dub.src && sub.src !== dub.src) {
    const a = await segmentSummary(sub.src, "  SUB");
    await new Promise((r) => setTimeout(r, 500));
    const b = await segmentSummary(dub.src, "  DUB");
    if (a && b) {
      const same = a.firstBuf.equals(b.firstBuf);
      console.log(`  FIRST-SEGMENT ${same ? "IDENTICAL bytes (same content!)" : "differs (distinct encodes)"}`);
    }
  }
}

const cases = [
  [57181, "Blue Box", 1],
  [57181, "Blue Box", 25],
  [5114, "FMA Brotherhood", 1],
];
for (const [id, t, ep] of cases) {
  await compare(id, t, ep);
  await new Promise((r) => setTimeout(r, 800));
}
