/**
 * Pin One Piece (malId 21) to the Elbaph arc key visual — poster + hero banner.
 * sync.ts's ART_OVERRIDES keeps it across future syncs; this applies it to the
 * current row right away. Re-runnable.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const ELBAPH = "https://z-cdn.chatglm.cn/image-search-mcp/images-ppt/014548118c75.jpg";

const a = await db.anime.update({
  where: { malId: 21 },
  data: { image: ELBAPH, banner: ELBAPH },
  select: { malId: true, title: true, image: true },
});
console.log("updated:", JSON.stringify(a));

// also refresh the stale snapshot copies the watchtime/events tables carry so
// the new art shows everywhere immediately
await db.watchStat.updateMany({ where: { malId: 21 }, data: { image: ELBAPH } });
await db.top10Event.updateMany({ where: { malId: 21 }, data: { image: ELBAPH } });
console.log("snapshots refreshed");
process.exit(0);
