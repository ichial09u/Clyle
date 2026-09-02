/**
 * Probe dub availability on BOTH Zoko servers ("zoko" = default, "kiwi" = ?server=kiwi)
 * for key titles the user called out + a small catalog sample.
 *
 *   - no dub page            -> "none"
 *   - dub page, same content -> "fake"  (Japanese audio re-upload)
 *   - dub page, differs      -> "real"
 */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const { createHash } = await import("node:crypto");
const HEADERS = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(b) { return JSON.parse(decodeURIComponent(escape(xor(atob(b))))); }

async function payload(malId, lang, server) {
  const url = server === "kiwi"
    ? `${ORIGIN}/stream/mal/${malId}/1/${lang}?server=kiwi`
    : `${ORIGIN}/stream/mal/${malId}/1/${lang}`;
  try {
    const res = await fetch(url, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!res.ok) return null;
    const m = (await res.text()).match(/window\.__P="([^"]+)"/);
    return m ? decode(m[1]) : null;
  } catch { return null; }
}

async function firstSegmentDigest(masterUrl) {
  try {
    const mres = await fetch(masterUrl, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!mres.ok) return null;
    const variant = (await mres.text()).split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!variant) return null;
    const vurl = new URL(variant.trim(), masterUrl).href;
    const vres = await fetch(vurl, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!vres.ok) return null;
    const segs = (await vres.text()).split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    if (segs.length < 2) return null;
    const sres = await fetch(new URL(segs[1].trim(), vurl).href, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!sres.ok) return null;
    return createHash("sha1").update(Buffer.from(await sres.arrayBuffer())).digest("hex");
  } catch { return null; }
}

async function verifyDub(malId, server) {
  const [sub, dub] = await Promise.all([payload(malId, "sub", server), payload(malId, "dub", server)]);
  if (!dub) return { verdict: "none", note: "no dub page" };
  if (!sub) return { verdict: "unknown", note: "no sub to compare" };
  if (sub.src === dub.src) return { verdict: "fake", note: `same src ${dub.src}` };
  const [a, b] = await Promise.all([firstSegmentDigest(sub.src), firstSegmentDigest(dub.src)]);
  if (a == null || b == null) return { verdict: "unknown", note: "segment fetch failed" };
  return a !== b
    ? { verdict: "real", note: `sub=${sub.src.slice(-40)} dub=${dub.src.slice(-40)}` }
    : { verdict: "fake", note: "segments identical" };
}

const TITLES = [
  [57181, "Blue Box"],
  [21, "One Piece"],
  [5114, "FMA Brotherhood"],
  [16498, "AoT"],
  [52991, "Sousou no Frieren"],
  [40748, "Jujutsu Kaisen"],
  [117193, "Solo Leveling"],
  [52034, "Oshi no Ko S2"],
];

for (const [id, name] of TITLES) {
  for (const server of ["zoko", "kiwi"]) {
    const r = await verifyDub(id, server);
    console.log(`${name} (${id}) [${server}]: ${r.verdict} — ${r.note}`);
  }
}
