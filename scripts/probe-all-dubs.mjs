/**
 * Batch-probe hasDub for EVERY in-catalog anime using the same fake-dub
 * detection as src/lib/zoko-stream.ts (sub vs dub segment digest compare):
 *   - no dub page            -> hasDub = false
 *   - dub page, same content -> hasDub = false (fake dub: Japanese audio)
 *   - dub page, differs      -> hasDub = true  (real dub)
 * Writes Anime.hasDub so the episode sheet can hide DUB buttons correctly.
 */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const { createHash } = await import("node:crypto");
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(b) { return JSON.parse(decodeURIComponent(escape(xor(atob(b))))); }
const HEADERS = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

async function payload(malId, lang) {
  try {
    const res = await fetch(`${ORIGIN}/stream/mal/${malId}/1/${lang}`, {
      headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(20_000), redirect: "follow",
    });
    if (!res.ok) return null;
    const m = (await res.text()).match(/window\.__P="([^"]+)"/);
    return m ? decode(m[1]) : null;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }
}

async function verifyDub(malId) {
  const [sub, dub] = await Promise.all([payload(malId, "sub"), payload(malId, "dub")]);
  if (!dub) return false;                    // no dub page at all
  if (!sub) return null;                     // can't compare
  if (sub.src === dub.src) return false;     // literally same stream
  const [a, b] = await Promise.all([firstSegmentDigest(sub.src), firstSegmentDigest(dub.src)]);
  if (a == null || b == null) return null;   // undecidable
  return a !== b;                            // differ -> real dub
}

const animes = await db.anime.findMany({
  // hasDub != null means a previous pass of THIS script already stored a
  // segment-verified verdict — only fresh/naive-probed rows are re-checked
  where: { inCatalog: true, hasDub: null },
  select: { malId: true, title: true, hasDub: true },
  orderBy: { popularity: "asc" },
});
console.log(`probing ${animes.length} animes...`);

let t = 0, f = 0, unknown = 0, fixed = 0;
const WORKERS = 6;
async function probeOne(a) {
  const v = await verifyDub(a.malId);
  if (v === null) { unknown++; return; }
  if (v !== a.hasDub) fixed++;
  await db.anime.update({ where: { malId: a.malId }, data: { hasDub: v } }).catch(() => undefined);
  v ? t++ : f++;
  if ((t + f + unknown) % 100 === 0) {
    console.log(`  ${t + f + unknown}/${animes.length} -> real ${t}, fake/none ${f}, unknown ${unknown}`);
  }
}
for (let i = 0; i < animes.length; i += WORKERS) {
  await Promise.all(animes.slice(i, i + WORKERS).map((a) => probeOne(a).catch(() => { unknown++; })));
  await sleep(80);
}

console.log(`\nDONE: real dub ${t}, fake/none ${f}, unknown ${unknown}, corrected ${fixed}`);
// spot-check known cases
for (const id of [21, 57181, 235]) {
  const row = await db.anime.findUnique({ where: { malId: id }, select: { title: true, hasDub: true } });
  console.log(`check ${id}:`, JSON.stringify(row));
}
await db.$disconnect();
