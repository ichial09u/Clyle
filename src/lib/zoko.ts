/**
 * Zoko player integration.
 *
 * Zoko serves every episode through a predictable URL keyed on the
 * MyAnimeList (MAL) id of the anime:
 *
 *   player:    https://zokoanime.video/stream/mal/{malId}/{episodeNumber}/{sub|dub}
 *   downloads: https://zokoanime.video/download/mal/{malId}/{episodeNumber}/{sub|dub}
 *
 * e.g. https://zokoanime.video/stream/mal/21/1/sub  ->  One Piece episode 1 (SUB)
 *
 * This app NEVER scrapes episode sources — metadata comes from the Jikan
 * (MyAnimeList) API and playback is always delegated to Zoko's own player.
 */

export const ZOKO_BASE = "https://zokoanime.video";

export type Lang = "sub" | "dub";

/** Embeddable player page for one episode. */
export function zokoPlayerUrl(malId: number, episode: number, lang: Lang = "sub"): string {
  return `${ZOKO_BASE}/stream/mal/${malId}/${episode}/${lang}`;
}

/** Zoko's download page for one episode (mirrors the player URL pattern). */
export function zokoDownloadUrl(malId: number, episode: number, lang: Lang = "sub"): string {
  return `${ZOKO_BASE}/download/mal/${malId}/${episode}/${lang}`;
}

export type Quality = "360p" | "720p" | "1080p";

/** MB per minute of video, derived from Zoko's reported One Piece sizes. */
const MB_PER_MIN: Record<Quality, number> = {
  "360p": 2.86, // ~68.73 MB for a 24 min episode
  "720p": 5.38, // ~129.06 MB
  "1080p": 9.25, // ~221.98 MB
};

/** Estimate a download size from episode duration, like the app in the video does. */
export function estimateSizeMB(durationMin: number | null | undefined, quality: Quality): number {
  const min = durationMin && durationMin > 0 ? durationMin : 24;
  return Math.round(min * MB_PER_MIN[quality]);
}

export function prettySize(mb: number): string {
  return `~${mb.toFixed(2)} MB`;
}
