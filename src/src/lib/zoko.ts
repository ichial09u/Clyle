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

import type { ServerId } from "@/lib/backup-servers";

export type { BackupServerId, AnivexaServerId, AniweebServerId } from "@/lib/backup-servers";
export {
  isBackupServer,
  backupProviderOf,
  backupServerId,
  backupServerName,
  backupServerLangs,
  MEGAPLAY_IFRAME_SERVER,
  MEGAFLIX_IFRAME_SERVER,
  isIframeServer,
  isIframeDubServer,
  isAniweebServer,
  isAnivexaServer,
  ANIWEEB_SERVER_IDS,
  ANIWEEB_SERVER_NAMES,
  ANIWEEB_SUBDUB_SERVERS,
} from "@/lib/backup-servers";

export const ZOKO_BASE = "https://zokoanime.video";

export type Lang = "sub" | "dub";

/**
 * Playback servers, as shown in the app's episode sheet.
 *
 * "zoko" / "kiwi" are the main chain. The backup ids (anivexa-* DUB-only,
 * aniweeb-1/2 + vidcloud SUB+DUB) exist per-title and appear on episodes
 * their network actually covers; the two iframe fallbacks (megaplay-dub,
 * megaflix) hand the episode to the third-party embed player. All resolve
 * through /api/stream (iframes skip the resolve) like every other server.
 */
export type { ServerId } from "@/lib/backup-servers";

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

/**
 * Megaplay's MAL-keyed embed player — the DUB iframe fallback for titles
 * whose dub our resolvers can't extract (their getSources API answers
 * client-side-encrypted payloads; their own player decrypts in-browser).
 * DUB only — the sub stays on Zoko/Kiwi.
 */
export function megaplayPlayerUrl(malId: number, episode: number): string {
  return `https://megaplay.buzz/stream/mal/${malId}/${episode}/dub`;
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
