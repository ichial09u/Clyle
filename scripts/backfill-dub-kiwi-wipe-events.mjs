/**
 * Backfill dub verdicts + clear the notification feed (one-time, Task: dub bring-back).
 *
 * 1. hasDubKiwi was probed empirically: the Kiwi server (?server=kiwi) returns
 *    byte-identical payloads to Zoko for sub AND dub (same video ids), so its
 *    dub availability equals Zoko's per title. Copy the verdicts over.
 * 2. Wipe all legacy Top10Event rows — the user reset notifications: the bell
 *    stays EMPTY until the new rank-change events (up/down/enter/leave) fire.
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  // copy per-row (updateMany can't reference another column in SQLite via Prisma)
  const rows = await db.anime.findMany({ where: { inCatalog: true }, select: { malId: true, hasDub: true } });
  let copied = 0;
  for (const row of rows) {
    if (row.hasDub == null) continue;
    await db.anime.update({ where: { malId: row.malId }, data: { hasDubKiwi: row.hasDub } });
    copied += 1;
  }
  console.log(`copied hasDub -> hasDubKiwi for ${copied} anime`);
  const del = await db.top10Event.deleteMany({});
  console.log(`wiped ${del.count} legacy Top10Event rows (notifications reset)`);
  const dist = await db.anime.groupBy({ by: ["hasDubKiwi"], where: { inCatalog: true }, _count: { malId: true } });
  for (const d of dist) console.log(`hasDubKiwi=${d.hasDub}: ${d._count.malId}`);
}
main().finally(() => db.$disconnect());
