/**
 * Seed catalog — the MAL ids Zoko is known to carry.
 *
 * Zoko's player works purely off MAL ids (see lib/zoko.ts), so "an anime
 * Zoko has" == "a MAL id in this catalog". Newer anime are imported
 * automatically from the current season by the sync job (see lib/sync.ts),
 * and users can import anything else by MAL id.
 */

export interface SeedEntry {
  malId: number;
  /** Fallback title used until Jikan details are fetched. */
  title: string;
}

export const SEED_CATALOG: SeedEntry[] = [
  // --- animes visible in the app recording ---
  { malId: 21, title: "One Piece" },
  { malId: 34572, title: "Black Clover" },
  { malId: 235, title: "Detective Conan" },
  { malId: 31240, title: "Re:Zero kara Hajimeru Isekai Seikatsu" },
  { malId: 32615, title: "Youjo Senki (Saga of Tanya the Evil)" },
  { malId: 39535, title: "Mushoku Tensei: Jobless Reincarnation" },
  { malId: 269, title: "Bleach" },
  { malId: 41467, title: "Bleach: Sennen Kessen-hen" },
  { malId: 37430, title: "Tensei shitara Slime Datta Ken" },
  { malId: 16498, title: "Shingeki no Kyojin" },
  { malId: 1535, title: "Death Note" },
  { malId: 5114, title: "Fullmetal Alchemist: Brotherhood" },
  { malId: 30276, title: "One Punch Man" },
  { malId: 11061, title: "Hunter x Hunter (2011)" },
  { malId: 6702, title: "Fairy Tail" },
  { malId: 20, title: "Naruto" },
  { malId: 1735, title: "Naruto: Shippuuden" },
  { malId: 31964, title: "Boku no Hero Academia" },
  { malId: 9253, title: "Steins;Gate" },
  { malId: 14719, title: "JoJo's Bizarre Adventure (2012)" },
  // --- other Zoko staples ---
  { malId: 38000, title: "Kimetsu no Yaiba" },
  { malId: 40748, title: "Jujutsu Kaisen" },
  { malId: 51009, title: "Jujutsu Kaisen 2nd Season" },
  { malId: 50265, title: "Spy x Family" },
  { malId: 52991, title: "Sousou no Frieren" },
  { malId: 44511, title: "Chainsaw Man" },
  { malId: 37521, title: "Vinland Saga" },
  { malId: 34599, title: "Made in Abyss" },
  { malId: 20464, title: "Haikyuu!!" },
  { malId: 32182, title: "Mob Psycho 100" },
  { malId: 38691, title: "Dr. Stone" },
  { malId: 37999, title: "Kaguya-sama wa Kokurasetai" },
  { malId: 11757, title: "Sword Art Online" },
  { malId: 22319, title: "Tokyo Ghoul" },
  { malId: 20583, title: "Noragami" },
  { malId: 1575, title: "Code Geass: Hangyaku no Lelouch" },
  { malId: 918, title: "Gintama" },
  { malId: 30, title: "Neon Genesis Evangelion" },
  { malId: 1, title: "Cowboy Bebop" },
  { malId: 19, title: "Monster" },
  { malId: 52034, title: "Oshi no Ko" },
  { malId: 40620, title: "Enen no Shouboutai (Fire Force)" },
  { malId: 35760, title: "Shingeki no Kyojin Season 2" },
];

/** Full MAL genre + theme list, exactly like the Genres tab in the video. */
export const ALL_GENRES: string[] = [
  "Action", "Adult Cast", "Adventure", "Anthropomorphic", "Avant Garde",
  "Award Winning", "Boys Love", "CGDCT", "Childcare", "Comedy",
  "Combat Sports", "Crossdressing", "Delinquents", "Detective", "Drama",
  "Ecchi", "Educational", "Erotica", "Fantasy", "Gag Humor",
  "Girls Love", "Gore", "Gourmet", "Harem", "High Stakes Game",
  "Historical", "Horror", "Idols (Female)", "Idols (Male)", "Isekai",
  "Iyashikei", "Love Polygon", "Love Status Quo", "Magical Sex Shift",
  "Mahou Shoujo", "Martial Arts", "Mecha", "Medical", "Military", "Music",
  "Mystery", "Mythology", "Organized Crime", "Psychological", "Racing",
  "Reincarnation", "Romance", "Samurai", "School", "Sci-Fi", "Shoujo",
  "Shounen", "Showbiz", "Slice of Life", "Space", "Sports",
  "Strategy Game", "Super Power", "Supernatural", "Survival", "Suspense",
  "Team Sports", "Time Travel", "Vampire", "Workplace",
];

/**
 * The POPULAR genres only — the big recognizable ones people actually browse
 * (AniList's main genres plus the most-loved themes). The Genres grid shows
 * just these, filtered to genres the catalog actually has, most titles first;
 * the niche/obscure tags from ALL_GENRES never appear as empty tiles.
 */
export const POPULAR_GENRES: string[] = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Military", "Music", "Mystery", "Psychological",
  "Romance", "School", "Sci-Fi", "Slice of Life", "Sports", "Super Power",
  "Supernatural", "Thriller", "Ecchi", "Isekai", "Historical", "Space",
  "Vampire", "Harem",
];

/**
 * "OG" — a pseudo-genre tile on the Genres grid: the catalog's hidden
 * pre-OG_MAX_YEAR vault (see OG_NICHE_* below). It is not a real MAL/AniList
 * tag: /api/genres surfaces the tile and /api/genre/OG swaps the genre-tag
 * filter for a start-year + fame filter.
 */
export const OG_GENRE = "OG";
export const OG_MAX_YEAR = 2009;

/**
 * "Pokémon" — a pseudo-genre tile on the Genres grid (like OG): the whole
 * franchise (main series + movies + specials) is tagged with it on import,
 * /api/genres pins its wordmark tile to the front, and /api/genre/Pokémon
 * serves it in WATCH ORDER (release-chronological) instead of popularity.
 */
export const POKEMON_GENRE = "Pokémon";

/**
 * "South Park" — a pseudo-genre tile on the Genres grid (Pokémon pattern):
 * the whole franchise (one entry carrying all 29 seasons + the movie + the
 * specials) is tagged with it, /api/genres pins its wordmark tile, and
 * /api/genre/South Park serves the entry. Playback flows through the WCO
 * source (lib/wco.ts) — South Park has no AniList/Zoko presence.
 */
export const SOUTHPARK_GENRE = "South Park";

/**
 * The OG vault is NICHE-ONLY — "animes people haven't heard about in a while
 * or at all", not the pre-2010 greatest hits. A title is too famous for the
 * vault when EITHER fame signal says so:
 *   - MAL popularity rank <= OG_NICHE_MAX_POPULARITY (lower = more famous;
 *     anything inside MAL's top 800 is a household name — Death Note (#2),
 *     Naruto (#9), Cowboy Bebop (#41), Cardcaptor Sakura (#713), Conan (#731))
 *   - MAL members >= OG_NICHE_MAX_MEMBERS (safety net for titles with no
 *     popularity data; ~100k members is already "most fans know this one")
 * /api/genre/OG (the grid) and /api/genres (the tile count) share this gate
 * so the number on the tile always matches what the vault actually holds.
 */
export const OG_NICHE_MAX_POPULARITY = 800;
export const OG_NICHE_MAX_MEMBERS = 100_000;

/**
 * Famous titles whose MAL row carries NO fame data at all (popularity, members
 * and rank all null) — the two fame gates above can't see them, so they are
 * excluded by id. Verified against the vault: these were the only leaks.
 * (Soul Hunter stays — it is genuinely niche, its data is just sparse.)
 */
const OG_FAMOUS_DATA_GAP_IDS = [136 /* Hunter x Hunter (1999) */, 2904 /* Code Geass R2 */];

/** Prisma where-clause for the niche OG vault (shared by both OG endpoints). */
export function ogNicheVaultWhere() {
  return {
    inCatalog: true,
    year: { not: null, lte: OG_MAX_YEAR },
    malId: { notIn: OG_FAMOUS_DATA_GAP_IDS },
    AND: [
      { OR: [{ popularity: null }, { popularity: { gt: OG_NICHE_MAX_POPULARITY } }] },
      { OR: [{ members: null }, { members: { lt: OG_NICHE_MAX_MEMBERS } }] },
    ],
  };
}
