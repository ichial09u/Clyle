/**
 * Pokémon episode titles — direct myanimelist.net scrape (Jikan is blocked
 * in the sandbox and AniList has no streamingEpisodes for the franchise).
 *
 * For every Pokémon-genre anime that has multi-episode untitled rows, walks
 * MAL's paginated episode table (?p=N, 100 rows/page), extracts
 * number/title/aired, and updates the local Episode rows. Series-only —
 * movies/specials are single-episode and stay on their default rows.
 *
 * Politeness: ~1.4s between requests; resumable (only untitled rows are
 * written back).
 *
 * Usage: node scripts/scrape-mal-ep-titles.mjs
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEpisodePage(html) {
  const rows = [...html.matchAll(/<tr class="episode-list-data">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const out = [];
  for (const r of rows) {
    const num = /<td class="episode-number[^"]*"[^>]*data-raw="(\d+)"/.exec(r)?.[1];
    const title =
      /<td class="episode-title[^"]*"[^>]*>\s*(?:<a[^>]*>)?([^<]+)/.exec(r)?.[1]?.trim() ?? null;
    const aired =
      /<td class="episode-aired[^"]*"[^>]*data-raw="([^"]+)"/.exec(r)?.[1] ??
      /<td class="episode-aired[^"]*"[^>]*>\s*(?:<span[^>]*>)?([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/.exec(r)?.[1] ??
      null;
    if (num) out.push({ number: parseInt(num, 10), title, aired });
  }
  return out;
}

function toIsoDate(s) {
  if (!s) return null;
  // "Apr 1, 1997" -> 1997-04-01 ; already-ISO strings pass through
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) return null;
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const mon = months[m[1]];
  if (!mon) return null;
  return `${m[3]}-${mon}-${String(m[2]).padStart(2, "0")}`;
}

async function fetchPage(malId, page) {
  const url = `https://myanimelist.net/anime/${malId}/_/episode${page > 1 ? `?p=${page}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`mal ${res.status}`);
  return res.text();
}

async function main() {
  const poke = await db.anime.findMany({
    where: { genres: { contains: '%"Pokémon"%' }, totalEpisodes: { gt: 1 } },
    select: { malId: true, title: true, totalEpisodes: true },
    orderBy: { year: "asc" },
  });
  console.log(`[mal-eps] ${poke.length} multi-episode Pokémon titles`);
  let titled = 0;
  for (const a of poke) {
    const untitled = await db.episode.count({
      where: { animeId: a.malId, lang: "sub", OR: [{ title: null }, { title: "" }] },
    });
    if (!untitled) continue;
    const pages = Math.ceil(a.totalEpisodes / 100);
    let got = 0;
    try {
      for (let p = 1; p <= pages; p++) {
        const html = await fetchPage(a.malId, p);
        const eps = parseEpisodePage(html);
        for (const e of eps) {
          if (!e.title) continue;
          const res = await db.episode.updateMany({
            where: { animeId: a.malId, number: e.number, lang: "sub" },
            data: { title: e.title, ...(toIsoDate(e.aired) ? { aired: toIsoDate(e.aired) } : {}) },
          });
          got += res.count;
        }
        await sleep(1_400);
      }
    } catch (e) {
      console.error(`[mal-eps] malId ${a.malId} "${a.title}" page error:`, e.message);
    }
    titled += got;
    console.log(`  ${a.malId} "${a.title.slice(0, 42)}" -> ${got} titles`);
  }
  console.log(`[mal-eps] done — ${titled} episode titles written`);
}

main()
  .catch((e) => {
    console.error("[mal-eps] fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
