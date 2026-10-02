// Why are current-season episodes untitled? Probe both sources for 2 shows.
import { streamingEpisodeTitlesByMal } from "../src/lib/anilist.ts";
import { jikan } from "../src/lib/jikan.ts";

for (const malId of [59193, 62513]) {
  // Mushoku Tensei III, Clevatess II
  const s = await streamingEpisodeTitlesByMal(malId).catch(() => []);
  const nums = s.map((x) => x.number).sort((a, b) => a - b);
  console.log(`malId=${malId} AniList streamingEpisodes: ${s.length}${nums.length ? ` (${nums[0]}-${nums[nums.length - 1]}) last="${s.find((x) => x.number === nums[nums.length - 1])?.title}"` : ""}`);

  const j = await jikan<{ data: Array<{ mal_id: number; title: string | null }> }>(`/anime/${malId}/episodes?page=1`).catch((e) => { console.log(`  jikan err: ${String(e).slice(0, 80)}`); return null; });
  if (j?.data) {
    const last = j.data[j.data.length - 1];
    console.log(`  Jikan page1: ${j.data.length} eps, last=${last.mal_id} "${last.title}"`);
  }
}
process.exit(0);
