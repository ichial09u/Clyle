// Pre-deploy validation: run the real syncCatalog() (with the 3b title heal)
// locally, then report how many previously-untitled episodes got titles.
import { syncCatalog } from "../src/lib/sync.ts";
import { db } from "../src/lib/db.ts";

const before = await db.episode.count({ where: { lang: "sub", title: null } });
console.log("untitled episodes before:", before);

const result = await syncCatalog(true);
console.log("sync:", JSON.stringify(
  { ok: result.ok, episodesAdded: result.episodesAdded, animeAdded: result.animeAdded, animeChecked: result.animeChecked, durationMs: result.durationMs },
));

const after = await db.episode.count({ where: { lang: "sub", title: null } });
console.log("untitled episodes after:", after, "(filled:", before - after, ")");

// show what filled for the season imports + One Piece state
const filled = await db.episode.findMany({
  where: { animeId: { in: [61897, 63817, 62811, 62542] }, lang: "sub", title: { not: null } },
  select: { animeId: true, number: true, title: true },
  orderBy: [{ animeId: "asc" }, { number: "asc" }],
});
for (const e of filled) console.log(`  malId ${e.animeId} ep ${e.number}: ${e.title}`);
const op = await db.episode.findMany({
  where: { animeId: 21, lang: "sub", number: { gte: 1164 } },
  select: { number: true, title: true },
  orderBy: { number: "asc" },
});
console.log("One Piece 1164+ titles now:");
for (const e of op) console.log(`  ep ${e.number}: ${e.title ?? "(still NULL)"}`);
process.exit(0);
