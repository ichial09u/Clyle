// One-off: is malId 62542's untitled range upstream-available (MAL list)?
import { db } from "../src/lib/db.ts";
import { jikan } from "../src/lib/jikan.ts";

const untitled = await db.episode.findMany({
  where: { animeId: 62542, lang: "sub", title: null },
  select: { number: true },
  orderBy: { number: "asc" },
});
console.log("62542 untitled eps:", untitled.map((e) => e.number).join(","));
const anime = await db.anime.findUnique({
  where: { malId: 62542 },
  select: { title: true, airing: true, totalEpisodes: true },
});
console.log("62542:", JSON.stringify(anime));
const list = await jikan<{ data: Array<{ mal_id: number; title: string | null }> }>(
  "/anime/62542/episodes?page=1",
  { fresh: true },
);
for (const e of (list?.data ?? []).slice(0, 14)) console.log("  MAL ep", e.mal_id, ":", e.title ?? "(no title)");
process.exit(0);
