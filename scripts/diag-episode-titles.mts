// Diagnostic: why are recently-imported episodes untitled?
// 1) Does AniList streamingEpisodes carry titles for One Piece 1175-1179?
// 2) Does Jikan's paginated episode list (page 12 = eps 1101-1200) carry them?
import { streamingEpisodeTitlesByMal } from "../src/lib/anilist.ts";
import { jikan } from "../src/lib/jikan.ts";

const streaming = await streamingEpisodeTitlesByMal(21).catch((e) => {
  console.log("streaming FAILED:", String(e));
  return [];
});
console.log("AniList streaming entries:", streaming.length);
console.log("streaming range:", streaming[0]?.number, "-", streaming[streaming.length - 1]?.number);
for (const e of streaming.filter((x) => x.number >= 1174)) {
  console.log(`  anilist ep ${e.number}: ${e.title ?? "(no title)"}`);
}

const p12 = await jikan<{ data: Array<{ mal_id: number; title: string | null }> }>(
  "/anime/21/episodes?page=12",
  { fresh: true },
);
console.log("\nJikan page 12 entries:", p12?.data?.length ?? "null");
if (p12?.data?.length) {
  console.log("page 12 range:", p12.data[0]?.mal_id, "-", p12.data[p12.data.length - 1]?.mal_id);
  for (const e of p12.data.filter((x) => x.mal_id >= 1174)) {
    console.log(`  jikan ep ${e.mal_id}: ${e.title ?? "(no title)"}`);
  }
}
process.exit(0);
