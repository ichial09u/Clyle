/**
 * One-shot: map the Jujutsu Kaisen franchise to its SupaPlay subject
 * (jujutsu-kaisen-english-KD0jSM9ot5 carries S1-S3) + the AniKoto series
 * ids. JJK S2/S3 previously showed no dub because supaplayDub hardcoded
 * se=1 and nothing mapped them.
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const SUPA_PATH = "jujutsu-kaisen-english-KD0jSM9ot5";

const targets = [
  { malId: 40748, season: 1, anikoto: 6209, note: "JJK S1 (verify anikoto id below)" }, // anikoto id for S1 unknown — search
  { malId: 51009, season: 2, anikoto: 6542, note: "JJK S2 (verified: jujutsu-kaisen-2nd-season-hk2c9)" },
];

// find any JJK-related catalog entries (S3 / movie / culling game)
const jjks = await db.anime.findMany({
  where: { inCatalog: true, OR: [{ title: { contains: "Jujutsu" } }, { titleEnglish: { contains: "Jujutsu" } }] },
  select: { malId: true, title: true, titleEnglish: true, year: true, totalEpisodes: true, type: true },
});
console.log("JJK entries in catalog:");
for (const a of jjks) console.log(`  [${a.malId}] ${a.titleEnglish || a.title} (${a.type ?? "?"}, ${a.year ?? "?"}, ${a.totalEpisodes} eps)`);

for (const t of targets) {
  const exists = await db.anime.findUnique({ where: { malId: t.malId }, select: { title: true } });
  if (!exists) { console.log(`skip ${t.malId} — not in catalog`); continue; }
  await db.anime.update({
    where: { malId: t.malId },
    data: { supaplayPath: SUPA_PATH, supaplaySeason: t.season, anikotoSeriesId: t.anikoto },
  });
  console.log(`mapped [${t.malId}] ${exists.title}: supaplaySeason=${t.season} anikotoSeriesId=${t.anikoto}`);
}
await db.$disconnect();
