import type { Anime } from "@prisma/client";
import type { AnimeLite } from "@/lib/types";

export type { AnimeLite, HomePayload } from "@/lib/types";

export function lite(row: Anime): AnimeLite {
  let genres: string[] = [];
  try {
    genres = JSON.parse(row.genres);
  } catch {
    genres = [];
  }
  return {
    malId: row.malId,
    title: row.title,
    titleEnglish: row.titleEnglish,
    image: row.image,
    banner: row.banner,
    synopsis: row.synopsis,
    type: row.type,
    ratingShort: row.ratingShort,
    status: row.status,
    airing: row.airing,
    season: row.season,
    year: row.year,
    durationMin: row.durationMin,
    score: row.score,
    rank: row.rank,
    popularity: row.popularity,
    totalEpisodes: row.totalEpisodes,
    genres,
    inCatalog: row.inCatalog,
    source: row.source,
  };
}
