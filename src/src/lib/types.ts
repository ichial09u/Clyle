/** Shared client/server types (no Prisma imports — safe for client bundles). */

export interface AnimeLite {
  malId: number;
  title: string;
  titleEnglish: string | null;
  image: string | null;
  banner: string | null;
  /** Official title-logo art (fanart.tv-style clearlogo) — overlaid inside poster cards. */
  logo?: string | null;
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
  /** unix SECONDS (UTC) the next episode airs — null when finished/unscheduled.
   *  Cards show "New episode soon" within 3 days of it; the hero counts down. */
  nextEpisodeAt: number | null;
  nextEpisodeNum: number | null;
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
  hasDub: boolean;
  /** which servers carry a real DUB for this title ("zoko", "kiwi") */
  dubServers: Array<"zoko" | "kiwi">;
  /**
   * Which servers carry a REAL sub for this title. Pokémon-class titles are
   * DUB-ONLY on Zoko/Kiwi (their sub pages are 200 shells) — SUB buttons on
   * those titles are dead and must not render. Absent/unknown = optimistic
   * (both servers), matching the pre-verdict behavior.
   */
  subServers?: Array<"zoko" | "kiwi">;
  /**
   * Per-EPISODE dub boundaries (highest episode with a proven REAL dub per
   * server chain; 0 = none, null = unknown -> fall back to hasDub/dubServers).
   * Episodes past the boundary show no DUB button (e.g. One Piece's Elbaph
   * arc — the anime is dubbed but those episodes aren't yet).
   */
  dubThrough: { s1: number | null; s2: number | null };
  /**
   * Episodes with a DEFINITIVE no-dub proof on BOTH server chains (per-
   * episode DubProbe rows). The prefix boundary above can't express holes
   * inside a dubbed range (DAN DA DAN S1: eps 4-6 were never dubbed while
   * 1-3 and 7-12 stream real dubs) — these exact episodes get no DUB
   * button even though they sit under the boundary.
   */
  dubMissing: number[];
  /**
   * BACKUP DUB servers (the Anivexa network) for episodes our main chain
   * can't dub. One entry per provider that actually carries the dub over the
   * uncovered episodes — a title only ONE backup can dub shows exactly ONE
   * dub button. null = still probing (buttons appear on a later view; play
   * time still backfills transparently), [] = probed, nothing helps.
   */
  backupDub?: Array<{ server: string; provider: string; name: string; through: number | null; covered: number[] }> | null;
  episodes: EpisodeInfo[];
  newlyAdded: number;
  /**
   * Season structure for franchise entries that carry MANY seasons on ONE
   * row (South Park: 29 seasons + movies & specials on a single entry).
   * Present = the episode grid renders a season dropdown instead of one
   * giant flat wall of numbers; every range is inclusive [from, to].
   */
  seasons?: Array<{ season: number; label: string; from: number; to: number }>;
  /**
   * true = this show is airing and a brand-new episode may have JUST aired,
   * but the freshness check (AniList) was too slow to wait for inline — the
   * import is finishing in the background and the client should refetch
   * shortly so the episode appears without the user leaving and coming back.
   */
  freshnessPending?: boolean;
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
  /** true = sections are still filling server-side (cold cache / import) —
   *  the client re-polls; the hero data in `anime` is already complete. */
  pending?: boolean;
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
  /** real title of the newest episode ("The Forbidden Continent"), null until the backfill lands one */
  latestTitle?: string | null;
  total: number;
  updatedAt: string;
}

export interface GenreInfo {
  name: string;
  count: number;
}

/* ---------------- continue watching / progress / comments / profile ---------------- */

export interface ContinueItem {
  malId: number;
  title: string;
  image: string | null;
  banner: string | null;
  totalEpisodes: number;
  type: string | null;
  episode: number;
  lang: "sub" | "dub";
  server: string;
  position: number;
  duration: number;
  percent: number;
  completed: boolean;
  updatedAt: string;
}

export interface EpisodeBar {
  episode: number;
  position: number;
  duration: number;
  percent: number;
  completed: boolean;
}

export interface CommentItem {
  id: string;
  userId?: string;
  nickname: string;
  avatar: string | null;
  text: string;
  createdAt: string;
  parentId?: string | null; // set when this is a reply to another comment
  likes?: number; // total like count
  likedByMe?: boolean; // this device's identity has liked it
}

export interface ProfileInfo {
  id: string;
  nickname: string;
  avatar: string | null;
}
