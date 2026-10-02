/**
 * TVmaze episode-title source — the missing tier for CURRENT-SEASON anime.
 *
 * Why: the existing title sources both fail exactly where the user looks —
 *  - AniList streamingEpisodes only exists for Crunchyroll-linked shows
 *    (Mushoku Tensei III, Clevatess II …: ZERO entries), and for One Piece it
 *    covers only eps 62-130;
 *  - MAL's paginated episode list lags days (One Piece) or is never filled in
 *    (many seasonal sequels list a single episode all season).
 *
 * TVmaze (TheTVDB data) carries real names for airing shows within ~a day —
 * verified: Mushoku Tensei S3E14 "Resolve" (aired 2026-09-27) and Clevatess
 * S2E13 "True Hero" (aired 2026-09-30) were both titled on lookup.
 *
 * Numbering: anime absolute episode numbers do NOT map to TVmaze seasons
 * (One Piece = year-seasons S2024/S2025/S2026 restarting at 1). The robust
 * join key is the AIRDATE: AniList's schedule (Anime.nextEpisodeNum/At,
 * weekly cadence) derives each episode's Japanese broadcast date, and the
 * TVmaze episode aired within ±3 days of it supplies the name. The airdate
 * match also self-validates the show mapping (a wrong candidate rarely has
 * an episode airing that exact day); when several candidates do, the one
 * whose episode-list position is closest to our absolute number wins
 * (originals outrank remakes for long-runners).
 *
 * Free API, no key; 20 req / 10 s. Everything is cached in-memory (search
 * 24 h, episode lists 6 h) so repeat invocations cost zero requests.
 */

import { recentAiringScheduleByMal } from "@/lib/anilist";

interface TvmazeShow {
  id: number;
  name: string;
  premiered: string | null;
}

interface TvmazeEpisode {
  season: number;
  number: number | null;
  airdate: string | null; // "YYYY-MM-DD" (Japanese broadcast date)
  name: string | null;
  airstamp: string | null;
}

const searchCache = new Map<string, { expires: number; shows: TvmazeShow[] }>();
const episodesCache = new Map<number, { expires: number; episodes: TvmazeEpisode[] }>();
// malId -> exact (episode, airingAt) tail of AniList's airingSchedule — the
// two-step AniList query (lastPage probe + page fetch) is worth caching
const scheduleCache = new Map<number, { expires: number; nodes: Array<{ episode: number; airingAt: number }> }>();

const SEARCH_TTL = 24 * 3600_000;
const EPISODES_TTL = 6 * 3600_000;
const DATE_WINDOW_DAYS = 3;

async function tvmazeFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.tvmaze.com${path}`, {
      // TVmaze is fine with 1 retry — transient container-level timeouts seen
      // locally made a bare fetch flaky, the API itself is solid
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function tvmazeSearchShow(query: string): Promise<TvmazeShow[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const hit = searchCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.shows;
  const res = await tvmazeFetch<Array<{ show: TvmazeShow }>>(`/search/shows?q=${encodeURIComponent(key)}`);
  const shows = (res ?? []).map((r) => r.show).filter((s) => s && s.id);
  searchCache.set(key, { expires: Date.now() + SEARCH_TTL, shows });
  return shows;
}

async function tvmazeEpisodes(showId: number): Promise<TvmazeEpisode[]> {
  const hit = episodesCache.get(showId);
  if (hit && hit.expires > Date.now()) return hit.episodes;
  const res = await tvmazeFetch<TvmazeEpisode[]>(`/shows/${showId}/episodes?specials=0`);
  const episodes = Array.isArray(res) ? res : [];
  if (episodes.length) episodesCache.set(showId, { expires: Date.now() + EPISODES_TTL, episodes });
  return episodes;
}

/** Strip the obvious season suffixes that make TVmaze search miss. */
function searchQueryFor(titleEnglish: string | null, title: string): string {
  const raw = (titleEnglish?.trim() || title).trim();
  return (
    raw
      .replace(/\b(Season|Series|Part)\s*\d+\s*$/i, "")
      .replace(/\b(S|II|III|IV|V|VI|VII|VIII|IX|X)\s*$/i, "")
      .replace(/\s*[:\-–]\s*[^:\-–]{0,40}$/, "") // "Mushoku Tensei: Jobless…" -> "Mushoku Tensei"
      .trim() || raw
  );
}

/** "YYYY-MM-DD" of (unix seconds) in JST — the date Japanese TV aired it. */
export function jstDateOf(unixSec: number): string {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * Build epNumber -> broadcast-date ("YYYY-MM-DD", JST) for the wanted
 * episodes. Exact dates come from AniList's airingSchedule tail (survives
 * season finales, split-cour gaps, double-episode weeks); the weekly backoff
 * from nextEpisodeAt fills anything the schedule tail doesn't cover (e.g. a
 * brand-new episode AniList hasn't scheduled a follow-up for).
 */
async function buildAirdates(
  malId: number,
  wanted: number[],
  nextEpisodeNum: number | null,
  nextEpisodeAtSec: number | null,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!wanted.length) return out;

  // exact: AniList airingSchedule tail (cached 24h)
  let nodes = scheduleCache.get(malId)?.nodes;
  const hit = scheduleCache.get(malId);
  if (!nodes || !hit || hit.expires <= Date.now()) {
    nodes = await recentAiringScheduleByMal(malId, 30).catch(() => []);
    scheduleCache.set(malId, { expires: Date.now() + 24 * 3600_000, nodes });
  }
  for (const n of wanted) {
    const node = nodes?.find((s) => s.episode === n);
    if (node?.airingAt) out.set(n, jstDateOf(node.airingAt));
  }

  // fallback: weekly backoff from the next scheduled episode
  if (out.size < wanted.length && nextEpisodeNum && nextEpisodeAtSec && nextEpisodeNum > 1) {
    for (const n of wanted) {
      if (out.has(n)) continue;
      const back = nextEpisodeNum - n;
      if (back < 0) continue; // not aired yet per schedule
      out.set(n, jstDateOf(nextEpisodeAtSec - back * 7 * 86400));
    }
  }
  return out;
}

function withinDays(a: string, b: string, days: number): boolean {
  if (!a || !b) return false;
  const da = Date.parse(`${a}T00:00:00Z`);
  const db_ = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db_)) return false;
  return Math.abs(da - db_) <= days * 86400_000;
}

/**
 * Resolve real episode titles from TVmaze for `wanted` episode numbers of one
 * anime. Returns epNumber -> title for the episodes matched (subset of
 * wanted). Best-effort: empty map on any failure — callers fall through to
 * the next source. Never throws.
 */
export async function tvmazeEpisodeTitles(opts: {
  malId: number;
  titleEnglish: string | null;
  title: string;
  year: number | null;
  wanted: number[];
  nextEpisodeNum: number | null;
  nextEpisodeAtSec: number | null;
}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const { malId, titleEnglish, title, year, wanted, nextEpisodeNum, nextEpisodeAtSec } = opts;
    if (!wanted.length) return out;
    const airdates = await buildAirdates(malId, wanted, nextEpisodeNum, nextEpisodeAtSec);
    if (!airdates.size) return out; // no anchor at all -> nothing to match on
    // the newest wanted episode anchors the show match
    const anchorEp = Math.max(...[...airdates.keys()]);
    const anchorDate = airdates.get(anchorEp)!;

    const query = searchQueryFor(titleEnglish, title);
    const candidates = (await tvmazeSearchShow(query)).slice(0, 5);
    if (!candidates.length) return out;

    // (episodes, positionOfAnchor) per candidate — position = list index of
    // the airdate-matched episode, used to prefer the true original for
    // long-runners (One Piece 1999 outranks the 2023 remake: position 1180
    // beats 24 against our absolute 1180)
    const scored: Array<{ show: TvmazeShow; eps: TvmazeEpisode[]; position: number }> = [];
    for (const show of candidates) {
      const eps = await tvmazeEpisodes(show.id);
      if (!eps.length) continue;
      const idx = eps.findIndex((e) => withinDays(e.airdate ?? "", anchorDate, DATE_WINDOW_DAYS));
      if (idx >= 0) scored.push({ show, eps, position: idx + 1 });
      if (scored.length >= 2) break; // enough to pick from
    }
    if (!scored.length) return out;

    scored.sort((a, b) => {
      // long-runner rule: closest list-position to our absolute number
      if (anchorEp > 100) {
        const da = Math.abs(a.position - anchorEp);
        const db_ = Math.abs(b.position - anchorEp);
        if (da !== db_) return da - db_;
      }
      return 0; // keep search order otherwise
    });
    const { eps } = scored[0];

    for (const [ep, date] of airdates) {
      const match = eps.find((e) => withinDays(e.airdate ?? "", date, DATE_WINDOW_DAYS));
      const name = match?.name?.trim();
      if (name) out.set(ep, name);
    }
  } catch {
    /* best-effort by design — callers fall through to the next title source */
  }
  return out;
}
