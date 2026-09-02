/**
 * Local end-to-end test of the Top 10 This Month engine (no Next.js needed):
 * TMDB scrape -> catalog mapping -> snapshot + events -> getTop10Month().
 * Run with: npx tsx scripts/test-top10-month.ts
 */
import { refreshTop10Month, getTop10Month } from "../src/lib/top10-month";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("== refreshing (forced) ==");
  await refreshTop10Month(true);
  console.log("== current Top 10 This Month ==");
  const items = await getTop10Month();
  for (const it of items) {
    console.log(`#${it.rank}${it.prevRank != null && it.prevRank !== it.rank ? ` (was #${it.prevRank})` : ""} ${it.malId} — ${it.title}`);
  }
  const events = await db.top10Event.findMany({ orderBy: { id: "desc" }, take: 12 });
  console.log("\n== events ==");
  for (const e of events) console.log(`  [${e.type}] ${e.title} rank=${e.rank} prev=${e.prevRank} day=${e.day}`);
}
main().finally(() => db.$disconnect());
