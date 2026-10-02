// Debug One Piece (21) TVmaze matching step by step
import { execFileSync } from "node:child_process";
import { recentAiringScheduleByMal } from "../src/lib/anilist.ts";
import { jstDateOf, tvmazeEpisodeTitles } from "../src/lib/tvmaze.ts";

// this container cannot reach api.tvmaze.com via node fetch — curl shim
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("api.tvmaze.com")) {
    try {
      const body = execFileSync("curl", ["-s", "--max-time", "20", url], { maxBuffer: 64 * 1024 * 1024 });
      return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
    } catch (e) {
      return Promise.resolve(new Response(null, { status: 599, statusText: String(e).slice(0, 60) }));
    }
  }
  return nativeFetch(input as Parameters<typeof nativeFetch>[0], init);
}) as typeof fetch;

const sched = await recentAiringScheduleByMal(21, 30);
const eps = sched.map((s) => s.episode).sort((a, b) => a - b);
console.log("schedule nodes:", sched.length, "range:", eps[0], "-", eps[eps.length - 1]);
for (const s of sched.filter((s) => s.episode >= 1176)) console.log("  sched", s.episode, jstDateOf(s.airingAt));

// direct curl TVmaze: search + 1505 episodes tail
const search = JSON.parse(execFileSync("curl", ["-s", "--max-time", "10", "https://api.tvmaze.com/search/shows?q=ONE%20PIECE"], { maxBuffer: 32 * 1024 * 1024 }).toString()) as Array<{ show: { id: number; name: string; premiered: string | null } }>;
console.log("search:", search.slice(0, 5).map((r) => `${r.show.id}:${r.show.name}(${r.show.premiered})`).join(" | "));

const list = JSON.parse(execFileSync("curl", ["-s", "--max-time", "20", "https://api.tvmaze.com/shows/1505/episodes?specials=0"], { maxBuffer: 32 * 1024 * 1024 }).toString()) as Array<{ season: number; number: number | null; airdate: string | null; name: string | null }>;
console.log("1505 episodes:", list.length, "last3:", JSON.stringify(list.slice(-3)));

const titles = await tvmazeEpisodeTitles({
  malId: 21,
  titleEnglish: "ONE PIECE",
  title: "ONE PIECE",
  year: 1999,
  wanted: [1174, 1175, 1176, 1177, 1178, 1179, 1180],
  nextEpisodeNum: 1181,
  nextEpisodeAtSec: 1798985760,
});
console.log("tvmazeEpisodeTitles result:", JSON.stringify([...titles.entries()]));
process.exit(0);
