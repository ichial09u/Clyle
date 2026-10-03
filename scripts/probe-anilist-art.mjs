/**
 * Probe: current card-image sourcing vs. what the AniList API offers.
 * Read-only — reports CDN breakdown, banner coverage, and any catalog rows
 * still off the AniList CDN (excluding the pinned One Piece art override).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const GRAPHQL = "https://graphql.anilist.co";

async function anilistArt(malIds) {
  const out = new Map();
  for (let i = 0; i < malIds.length; i += 50) {
    const chunk = malIds.slice(i, i + 50);
    const query = `
      query ($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(idMal_in: $ids, type: ANIME) {
            idMal
            bannerImage
            coverImage { extraLarge large }
          }
        }
      }`;
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { ids: chunk } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0]?.message);
    for (const m of json.data?.Page?.media ?? []) if (m?.idMal) out.set(m.idMal, m);
    await new Promise((r) => setTimeout(r, 1200)); // rate limit
  }
  return out;
}

const cdnOf = (url) =>
  !url ? "null" : url.includes("anilistcdn") ? "anilist" : url.includes("s4.anilist") ? "anilist" : url.includes("cdn.myanimelist") ? "mal" : url.includes("z-cdn.chatglm") ? "image-search" : "other";

async function main() {
  const rows = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, image: true, banner: true, logoUrl: true },
    orderBy: { popularity: "asc" },
  });
  console.log(`catalog rows: ${rows.length}`);

  const breakdown = {};
  for (const r of rows) breakdown[cdnOf(r.image)] = (breakdown[cdnOf(r.image)] ?? 0) + 1;
  console.log("image CDN breakdown:", breakdown);

  const withLogo = rows.filter((r) => r.logoUrl);
  console.log(`logoUrl set: ${withLogo.length}  (local: ${withLogo.filter((r) => r.logoUrl.startsWith("/")).length}, remote: ${withLogo.length - withLogo.filter((r) => r.logoUrl.startsWith("/")).length})`);

  const ids = rows.map((r) => r.malId);
  const art = await anilistArt(ids);
  console.log(`anilist answers: ${art.size}/${ids.length}`);

  let offCdn = 0, noBanner = 0, stalePoster = 0;
  for (const r of rows) {
    const m = art.get(r.malId);
    if (!m) { console.log(`  ? no anilist match: ${r.malId} ${r.title}`); continue; }
    const best = m.coverImage?.extraLarge ?? m.coverImage?.large ?? null;
    if (best && r.image !== best && cdnOf(r.image) !== "anilist") {
      stalePoster++;
      console.log(`  ~ off-anilist poster: ${r.malId} ${r.title.slice(0, 32)} | now: ${String(r.image).slice(0, 60)}`);
    }
    if (!m.bannerImage) noBanner++;
  }
  const bannerRows = rows.filter((r) => r.banner).length;
  console.log(`rows with stored banner: ${bannerRows}/${rows.length}; anilist bannerless: ${noBanner}; posters to backfill: ${stalePoster}`);

  // sample: does AniList extraLarge differ from what we store for anilist-cdn rows?
  let sample = 0;
  for (const r of rows) {
    const m = art.get(r.malId);
    if (!m || sample >= 5) continue;
    const best = m.coverImage?.extraLarge ?? null;
    if (best && r.image && r.image !== best && cdnOf(r.image) === "anilist") {
      sample++;
      console.log(`  diff-within-anilist: ${r.malId} | db: ${r.image.slice(0, 70)} | al: ${best.slice(0, 70)}`);
    }
  }
}

main().finally(() => db.$disconnect());
