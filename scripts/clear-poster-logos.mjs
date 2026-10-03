/**
 * One-off: clear every Anime.logoUrl — the fanart.tv / image-search / wiki
 * wordmark overlays are retired; cards now show pure AniList cover art with a
 * hero-style text title rendered by PosterCard. Column stays in the schema.
 * Idempotent — safe to re-run.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const had = await db.anime.count({ where: { logoUrl: { not: null } } });
  const res = await db.anime.updateMany({ data: { logoUrl: null } });
  console.log(`cleared logoUrl on ${res.count} rows (had ${had} set)`);

  // sanity: catalog images should be AniList art (One Piece keeps its pinned override)
  const breakdown = {};
  const rows = await db.anime.findMany({ where: { inCatalog: true }, select: { image: true } });
  for (const r of rows) {
    const u = r.image ?? "";
    const k = !u ? "null" : u.includes("anilist") ? "anilist" : u.includes("myanimelist") ? "mal" : u.includes("z-cdn") ? "pinned/override" : "other";
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  console.log("catalog image CDN breakdown:", breakdown, `(${rows.length} rows)`);
}

main().finally(() => db.$disconnect());
