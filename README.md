# AnimeTest123

A mobile-first anime streaming front-end in the style of the Zoko app — rebuilt from a
screen recording as a **Next.js 16** web app.

- **Catalog / metadata**: [Jikan API](https://jikan.moe) (unofficial MyAnimeList API). No scraping.
- **Playback**: Zoko's own player only — `https://zokoanime.video/download/mal/{malId}/{episode}/{sub|dub}`
  (e.g. `.../download/mal/21/1/sub` = One Piece episode 1, SUB).
- **Catalog scope**: only anime Zoko carries. The seed list ships the staples; anything newer
  is imported automatically (see *Auto-import* below) or with one tap from search / genre pages.

## Screens (mirroring the app recording)

| Screen | Details |
| --- | --- |
| **Home** | Spotlight hero (TV / rating / score badges, season • status • runtime • ★score, genres, Share / Details / My List) + carousels: Spotlight, Trending, Most Popular, Most Watched, Top Airing, Most Favorite, New Episodes, Top 10 Today |
| **Details** | Full hero, synopsis, Other Seasons (sequels / side stories / summaries), You May Also Like, Episodes shortcut |
| **Episodes** | Numbered grid (5-across), oldest/newest sort, jump-to-number, red progress underline on your current episode, NEW badges |
| **Watch** | Zoko player embedded, `Episode N SUB/DUB` toggle, download format dialog (360p/720p/1080p with size estimates), Previous / Lock / Quality & Subtitles / Speed / Resize / Next control bar |
| **Genres** | The full MAL genre & theme grid; each genre shows catalog titles + importable MAL suggestions |
| **Search** | Instant catalog hits + MAL-wide results with one-tap import |
| **My List** | Local favorites (stored in your browser) |
| **Latest** | Freshest episodes with a **Sync now** button |

## Auto-import — "new episodes appear immediately"

Three layers keep the catalog current:

1. **On open** — the client pings `POST /api/sync` shortly after load if the catalog is stale.
2. **On view** — opening an airing show's episode list re-checks MAL and imports unseen episodes on the spot.
3. **On a schedule** — `.github/workflows/sync.yml` (optional) posts to `/api/sync` every 30 minutes.
   Set the `REPO_URL` repo secret after deploying to enable it.

A sync run:
- imports any missing episode numbers for airing catalog anime (long-runners like One Piece
  where MAL hides the count are probed via the paginated episode list), and
- imports every TV anime from the current season that is not in the catalog yet.

## Run it

```bash
bun install
bun run db:push        # create SQLite schema
bun run dev            # http://localhost:3000
```

Optional — pre-fill the catalog (details + episodes + current season):

```bash
bun scripts/seed-catalog.ts            # fill missing details (resumable, chunked)
bun scripts/seed-catalog.ts --sync     # also import episodes + current season now
```

The app self-seeds at runtime as well — first loads fetch details from Jikan in the background.

## Deploy anywhere (Vercel, VPS, …)

Any Node host works. After deploying, optionally add the `REPO_URL` secret so the
GitHub Action can keep the catalog warm.

## Project layout

```
src/app/page.tsx            single-page app shell (view stack, bottom nav)
src/components/anime/*      hero banner, poster card, section row, bottom nav
src/components/views/*      home, details, episodes, watch, genres, genre, search, my list, latest
src/app/api/*               home, anime, episodes, search, genres, latest, sync, import, mylist
src/lib/jikan.ts            rate-limited Jikan client (memory + disk cache, stale-while-revalidate)
src/lib/sync.ts             episode & season import engine
src/lib/zoko.ts             Zoko player URL builder + download size estimates
prisma/schema.prisma        Anime / Episode / SyncLog (SQLite)
scripts/seed-catalog.ts     resumable catalog seeder
```

## Notes

- Playback, quality selection, subtitles and speed are ultimately handled **inside Zoko's
  player**; this app is a catalog + launcher around it.
- My List and watch progress live in `localStorage` — no accounts needed.
- Content availability depends entirely on Zoko.
