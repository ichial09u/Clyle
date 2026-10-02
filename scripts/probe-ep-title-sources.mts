// Probe what AniList streamingEpisodes + Jikan actually carry for One Piece (21)
// right now — does either source have titles for eps 1178-1180?
import { streamingEpisodeTitlesByMal } from "../src/lib/anilist.ts";
import { jikan } from "../src/lib/jikan.ts";

const stream = await streamingEpisodeTitlesByMal(21).catch((e) => { console.error("anilist err", String(e)); return []; });
const nums = stream.map((s) => s.number).sort((a, b) => a - b);
console.log("AniList streamingEpisodes: count =", stream.length, "range =", nums[0], "-", nums[nums.length - 1]);
for (const s of stream.filter((s) => s.number >= 1175)) console.log("  AL", s.number, "=", s.title);

const res = await jikan<{ data: Array<{ mal_id: number; title: string | null }> }>(`/anime/21/episodes?page=13`).catch((e) => { console.error("jikan err", String(e)); return null; });
if (res?.data) {
  console.log("Jikan page13 count =", res.data.length, "first =", res.data[0]?.mal_id, "last =", res.data[res.data.length - 1]?.mal_id);
  for (const e of res.data.filter((e) => e.mal_id >= 1175)) console.log("  MAL", e.mal_id, "=", e.title);
}
process.exit(0);
