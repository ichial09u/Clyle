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

import type { BackupServerId } from "@/lib/backup-servers";

export type { BackupServerId } from "@/lib/backup-servers";
export { isBackupServer, backupProviderOf, backupServerId, backupServerName } from "@/lib/backup-servers";

export const ZOKO_BASE = "https://zokoanime.video";

export type Lang = "sub" | "dub";

/**
 * Playback servers, as shown in the app's episode sheet.
 *
 * "zoko" / "kiwi" are the main chain. The "anivexa-*" ids are the BACKUP DUB
 * servers (the Anivexa network) — they exist per-title, appear ONLY on
 * episodes where that provider carries a dub our main chain can't serve,
 * and resolve through /api/stream like every other server.
 */
export type ServerId = "zoko" | "kiwi" | BackupServerId;

export const SERVERS: Array<{ id: ServerId; name: string; note: string }> = [
  { id: "zoko", name: "Zoko", note: "Zoko player" },
  { id: "kiwi", name: "Kiwi", note: "Kiwi server" },
];

/**
 * Zoko's stream page. `server` selects the backend stream; today both map to
 * the same source, but the app passes the flag through so new backends are
 * picked up automatically.
 */
export function zokoStreamPageUrl(malId: number, episode: number, lang: Lang, server: ServerId = "zoko"): string {
  return server === "kiwi"
    ? `${ZOKO_BASE}/stream/mal/${malId}/${episode}/${lang}?server=kiwi`
    : `${ZOKO_BASE}/stream/mal/${malId}/${episode}/${lang}`;
}

/** Embeddable player page for one episode (used as the iframe fallback). */
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
