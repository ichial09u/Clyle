/** Shared client/server types (no Prisma imports — safe for client bundles). */

export interface AnimeLite {
  malId: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  banner: string | null;
  synopsis: string | null;
  type: string | null;
  ratingShort: string | null;
  status: string | null;
  airing: boolean;
  season: string | null;
  year: number | null;
  durationMin: number | null;
  score: number | null;
  rank: number | null;
  popularity: number | null;
  totalEpisodes: number;
  genres: string[];
  inCatalog: boolean;
  source: string;
}

export interface HomeSection {
  key: string;
  title: string;
  items: AnimeLite[];
}

export interface HomePayload {
  hero: AnimeLite[];
  sections: HomeSection[];
  top10: AnimeLite[];
  lastSync: { at: string | null };
}

export interface EpisodeInfo {
  number: number;
  title: string | null;
  aired: string | null;
  addedAt: string;
}

export interface EpisodesPayload {
  malId: number;
  title: string;
  type: string | null;
  airing: boolean;
  durationMin: number | null;
  total: number;
  episodes: EpisodeInfo[];
  newlyAdded: number;
}

export interface RelatedCard {
  malId: number;
  name: string;
  relation?: string;
  image: string | null;
  inCatalog: boolean;
}

export interface DetailsPayload {
  anime: AnimeLite;
  otherSeasons: RelatedCard[];
  similar: RelatedCard[];
}

export interface SearchResult {
  malId: number;
  title: string;
  image: string | null;
  type: string | null;
  year: number | null;
  score: number | null;
}

export interface LatestUpdate {
  anime: AnimeLite;
  latest: number;
  total: number;
  updatedAt: string;
}

export interface GenreInfo {
  name: string;
  count: number;
}
