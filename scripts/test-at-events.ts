/**
 * Prove the bell event pipeline on the Anime Trending source:
 * seed a snapshot with #1/#2 swapped -> forced refresh must emit
 * one "up" (surpassed) + one "down" (dropped a rank) event.
 * Run: npx tsx scripts/test-at-events.ts
 */
import { refreshTop10Month, getTop10Month } from "../src/lib/top10-month";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const meta = await db.top10Meta.findUnique({ where: { key: "top10month.snapshot" } });
  if (!meta) throw new Error("no snapshot — run /api/top10 once first");
  const snap = JSON.parse(meta.value);

  const [a, b] = snap.items;
  console.log("seeding swap:", a.title, "<->", b.title);
  // store the SWAPPED list, with prevRank = today's real ranks
  snap.items[0] = { ...b, rank: 1, prevRank: b.rank };
  snap.items[1] = { ...a, rank: 2, prevRank: a.rank };
  await db.top10Meta.upsert({
    where: { key: "top10month.snapshot" },
    create: { key: "top10month.snapshot", value: JSON.stringify(snap) },
    update: { value: JSON.stringify(snap) },
  });

  await refreshTop10Month(true);

  const { items } = await getTop10Month();
  console.log("== restored Top 10 ==");
  for (const it of items.slice(0, 3)) {
    console.log(`#${it.rank}${it.prevRank != null && it.prevRank !== it.rank ? ` (was #${it.prevRank})` : ""} ${it.title}`);
  }

  const events = await db.top10Event.findMany({ orderBy: { id: "desc" }, take: 6 });
  console.log("\n== events emitted ==");
  for (const e of events) console.log(`  [${e.type}] ${e.title} rank=${e.rank} prev=${e.prevRank}`);
}
main().finally(() => db.$disconnect());
