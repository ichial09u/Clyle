// Diagnostic 2: how far back do untitled One Piece episodes go, and what does
// MAL's list tail actually contain (titles + last page)?
import { db } from "../src/lib/db.ts";
import { jikan } from "../src/lib/jikan.ts";

const untitled = await db.episode.findMany({
  where: { animeId: 21, lang: "sub", title: null },
  select: { number: true },
  orderBy: { number: "desc" },
});
console.log("One Piece untitled eps:", untitled.map((e) => e.number).join(", "));

const titled = await db.episode.findMany({
  where: { animeId: 21, lang: "sub", title: { not: null } },
  select: { number: true },
  orderBy: { number: "desc" },
  take: 3,
});
console.log("highest titled eps:", titled.map((e) => e.number).join(", "));

const p12 = await jikan<{ data: Array<{ mal_id: number; title: string | null }>; pagination?: { last_visible_page?: number } }>(
  "/anime/21/episodes?page=12",
  { fresh: true },
);
console.log("page12 last_visible_page:", p12?.pagination?.last_visible_page);
for (const e of (p12?.data ?? []).slice(-8)) {
  console.log(`  jikan ep ${e.mal_id}: ${e.title ?? "(no title)"}`);
}

// does page 13 exist?
const p13 = await jikan<{ data: Array<{ mal_id: number; title: string | null }> }>("/anime/21/episodes?page=13", { fresh: true });
console.log("page13 entries:", p13?.data?.length ?? "null (MAL list ends at page 12)");
for (const e of (p13?.data ?? []).slice(0, 8)) {
  console.log(`  jikan ep ${e.mal_id}: ${e.title ?? "(no title)"}`);
}
process.exit(0);
