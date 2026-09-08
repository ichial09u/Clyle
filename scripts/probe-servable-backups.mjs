/**
 * One-shot probe: find (anime, provider, ep) triples where a backup provider
 * ACTUALLY SERVES a dub right now — used to validate the fleet verdict chain
 * end-to-end. Walks popular chain-dub-less anime, checks anivexa summaries,
 * tries watch, probes playlist + first segment bytes.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const db = new PrismaClient();
const BASE = "https://anivexa-api.vercel.app";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROVIDERS = ["anineko", "animegg", "hianime", "allmanga", "reanime"];

const AL_MAP = join(process.cwd(), "db", "al-map.json");
let alMap = {};
try { alMap = JSON.parse(readFileSync(AL_MAP, "utf8")); } catch {}
const AL_CACHE_DIR = join(process.cwd(), "db", "anilist-cache");
function alIdFromDiskCache(id) {
  const key = `MediaByMal:${JSON.stringify({ idMal: id })}`;
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 24);
  try {
    const entry = JSON.parse(readFileSync(join(AL_CACHE_DIR, `${hash}.json`), "utf8"));
    return entry?.data?.Media?.id ?? null;
  } catch { return null; }
}

function titlesRoughlyMatch(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
  let inter = 0;
  for (const t of tx) if (ty.has(t)) inter++;
  return inter / (Math.min(tx.size, ty.size) || 1) >= 0.6;
}

const hdrs = (ref) => (ref ? { "User-Agent": UA, Accept: "*/*", Referer: ref } : { "User-Agent": UA, Accept: "*/*" });

// popular anime whose MAIN chain is proven dub-less or unprobed, sub-capable
const cands = await db.anime.findMany({
  where: { inCatalog: true, totalEpisodes: { gte: 1 } },
  orderBy: { popularity: "asc" },
  take: 400,
  select: { malId: true, title: true, titleEnglish: true, totalEpisodes: true, hasDub: true, hasDubKiwi: true, hasDubMega: true, dubThruS1: true, dubThruS2: true },
});
const needDub = cands.filter((a) => a.hasDub === false && a.hasDubKiwi === false && a.hasDubMega === false);
console.log(`popular-without-any-chain-dub: ${needDub.length} of ${cands.length} scanned`);

let tested = 0, servable = 0;
for (const a of needDub) {
  if (tested >= 8 || servable >= 2) break;
  const title = a.titleEnglish?.trim() || a.title;
  let alId = alMap[a.malId] ?? alIdFromDiskCache(a.malId);
  if (!alId) { console.log(`[${title}] no alId (cache miss + anilist down) — skip`); continue; }
  let eps;
  try {
    const res = await fetch(`${BASE}/episodes/${alId}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) continue;
    eps = await res.json();
  } catch { continue; }
  if (!eps || typeof eps !== "object") continue;
  for (const p of PROVIDERS) {
    const pv = eps[p];
    if (!pv || pv.error) continue;
    const metaTitle = pv.meta?.title?.trim();
    if (metaTitle && !titlesRoughlyMatch(title, metaTitle)) { console.log(`[${title}] ${p}: WRONG-SHOW "${metaTitle}"`); continue; }
    const dub = (pv.episodes?.dub ?? []).map((e) => Math.floor(e.number)).filter(Number.isFinite);
    if (!dub.length) continue;
    const ep = dub[0]; // first dub-covered episode
    try {
      const w = await fetch(`${BASE}/watch/${p}/${alId}/dub/${p}-${ep}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      const j = await w.json().catch(() => null);
      const streams = (j?.streams ?? []).filter((s) => /\.m3u8(\?|$)/i.test(s?.url ?? ""));
      if (!streams.length) { console.log(`[${title}] ${p} ep${ep}: declared but watch=${j?.error ? "err" : "no-hls"}`); continue; }
      const s = streams[0];
      const mres = await fetch(s.url, { headers: hdrs(s.referer), redirect: "follow", signal: AbortSignal.timeout(12_000) });
      const mtext = mres.ok ? await mres.text() : "";
      if (!mtext.includes("#EXTM3U")) { console.log(`[${title}] ${p} ep${ep}: master dead`); continue; }
      const variants = mtext.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      let vurl = variants.length && mtext.includes("#EXT-X-STREAM-INF") ? new URL(variants[variants.length - 1], s.url).href : s.url;
      const vres = await fetch(vurl, { headers: hdrs(s.referer), redirect: "follow", signal: AbortSignal.timeout(12_000) });
      const vtext = vres.ok ? await vres.text() : "";
      const segs = vtext.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#") && !l.includes("#EXTINF"));
      const seg = segs.find((x) => !/\.(jpg|jpeg|png|gif|webp|svg|html?)(\?|$)/i.test(x.trim()));
      if (!seg) { console.log(`[${title}] ${p} ep${ep}: ad-wall playlist`); continue; }
      const segRes = await fetch(new URL(seg.trim(), vurl).href, { headers: hdrs(s.referer), redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const buf = segRes.ok ? Buffer.from(await segRes.arrayBuffer()) : Buffer.alloc(0);
      const magic = buf.length && (buf[0] === 0x47 || buf.slice(0, 640).toString("latin1").includes("ftyp") || buf.slice(0, 3).toString("latin1") === "ID3");
      console.log(`[${title}] ${p} ep${ep}: SERVABLE=${!!magic} (${segRes.status}, ${buf.length}B, ${new URL(s.url).host})`);
      if (magic) servable++;
    } catch (e) {
      console.log(`[${title}] ${p} ep${ep}: probe err ${String(e.message).slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  tested++;
}
console.log(`probe done: tested=${tested} servable=${servable}`);
await db.$disconnect();
