/**
 * Backup server identities — shared by client and server code.
 *
 * The Anivexa network (lib/anivexa.ts, server-side) resolves DUB streams
 * from its providers; the UI shows each one as its own server button, but
 * ONLY on episodes where that provider actually carries the dub.
 *
 * The Aniweeb network (lib/aniweeb.ts, server-side) is MAL-keyed and serves
 * BOTH languages: `aniweeb-1` / `aniweeb-2` are api.aniweeb.net's two embed
 * servers (Lu / Nagumo), `vidcloud` is aniweeb's "Sakamoto" player (the
 * vidcloud.sbs getSources network). All three resolve to real playlists
 * server-side, so they cast and download like Zoko/Kiwi.
 *
 * MegaFlix (lib/megaflix.ts) is an embed-only AniList-keyed player — same
 * handling as the Megaplay iframe fallback (no direct stream extraction).
 *
 * Kept free of node imports so client bundles can import it safely.
 */

export const ANIVEXA_PROVIDERS = ["anineko", "animegg", "hianime", "allmanga", "reanime"] as const;
export type AnivexaProvider = (typeof ANIVEXA_PROVIDERS)[number];

/** Display names for the server sheet / player toasts. */
export const BACKUP_PROVIDER_NAMES: Record<AnivexaProvider, string> = {
  anineko: "AniNeko",
  animegg: "AnimeGG",
  hianime: "AniWatch",
  allmanga: "AllManga",
  reanime: "Reanime",
};

/** "anivexa-anineko" etc. — DUB only (the Anivexa network carries no subs). */
export type AnivexaServerId = `anivexa-${AnivexaProvider}`;

/**
 * Aniweeb API servers (lib/aniweeb.ts) — MAL-keyed, SUB + DUB:
 *  - aniweeb-1: api.aniweeb.net embed server 1 ("Lu")
 *  - aniweeb-2: api.aniweeb.net embed server 2 ("Nagumo")
 *  - vidcloud:  aniweeb's "Sakamoto" player (vidcloud.sbs getSources)
 * All three extract real playlists server-side, so they behave exactly like
 * the main servers (castable, downloadable, quality ladder).
 */
export const ANIWEEB_SERVER_IDS = ["aniweeb-1", "aniweeb-2", "vidcloud"] as const;
export type AniweebServerId = (typeof ANIWEEB_SERVER_IDS)[number];

export const ANIWEEB_SERVER_NAMES: Record<AniweebServerId, string> = {
  "aniweeb-1": "Aniweeb S1",
  "aniweeb-2": "Aniweeb S2",
  vidcloud: "VidCloud",
};

/** Every Aniweeb-network server id (walk order = quality of evidence). */
export const ANIWEEB_SUBDUB_SERVERS: AniweebServerId[] = ["aniweeb-1", "aniweeb-2", "vidcloud"];

/**
 * Megaplay's MAL-keyed embed player — the DUB iframe fallback. Megaplay
 * carries English dubs for a huge MAL-keyed catalog, but its getSources API
 * now answers client-side-encrypted ({"enc": ...}) payloads our resolvers
 * can't peel — while their OWN player decrypts in the browser. When no
 * resolvable dub exists for an episode, this server hands the episode to
 * their embed (same pattern as the Zoko iframe fallback). DUB only.
 */
export const MEGAPLAY_IFRAME_SERVER = "megaplay-dub" as const;

/**
 * MegaFlix Anime Player (megaflix.buzz) — the user-requested AniList-keyed
 * embed (`/stream/ani/{anilistId}/{ep}/{sub|dub}`). Their edge answers a
 * "Netherlands network endpoint" placeholder to every vantage point we can
 * test from, so no stream extraction or coverage oracle is possible — the
 * server rides at the END of every walk chain behind a pre-flight verdict
 * (lib/megaflix.ts) and becomes usable automatically if their gate ever
 * opens. SUB + DUB embed routes.
 */
export const MEGAFLIX_IFRAME_SERVER = "megaflix" as const;

/** The embed-only servers (no /api/stream resolve; pre-flighted in the UI). */
export const IFRAME_SERVERS = [MEGAPLAY_IFRAME_SERVER, MEGAFLIX_IFRAME_SERVER] as const;

export function isIframeServer(s: string): boolean {
  return s === MEGAPLAY_IFRAME_SERVER || s === MEGAFLIX_IFRAME_SERVER;
}

/** Every server the app can play: the main chain + both backup networks
 *  + the two embed fallbacks. */
export type ServerId =
  | "zoko"
  | "kiwi"
  | AnivexaServerId
  | AniweebServerId
  | typeof MEGAPLAY_IFRAME_SERVER
  | typeof MEGAFLIX_IFRAME_SERVER;

export type BackupServerId = AnivexaServerId | AniweebServerId;

export function isBackupServer(s: string): s is BackupServerId {
  return (
    s.startsWith("anivexa-") ||
    (ANIWEEB_SERVER_IDS as readonly string[]).includes(s)
  );
}

/** The Megaplay iframe fallback server (dub-only, embed-only). */
export function isIframeDubServer(s: string): boolean {
  return s === MEGAPLAY_IFRAME_SERVER;
}

export function isAnivexaServer(s: string): s is AnivexaServerId {
  return s.startsWith("anivexa-");
}

export function isAniweebServer(s: string): s is AniweebServerId {
  return (ANIWEEB_SERVER_IDS as readonly string[]).includes(s);
}

export function backupProviderOf(s: AnivexaServerId): AnivexaProvider {
  return s.slice("anivexa-".length) as AnivexaProvider;
}

export function backupServerId(p: AnivexaProvider): BackupServerId {
  return `anivexa-${p}`;
}

/** Display name for any backup server id. */
export function backupServerName(s: BackupServerId): string {
  if (isAnivexaServer(s)) return BACKUP_PROVIDER_NAMES[backupProviderOf(s)];
  if (isAniweebServer(s)) return ANIWEEB_SERVER_NAMES[s];
  return s;
}

/** Which languages a backup server can actually serve (the Anivexa
 *  network is DUB-only; Aniweeb's network carries both). */
export function backupServerLangs(s: BackupServerId): Array<"sub" | "dub"> {
  return isAnivexaServer(s) ? ["dub"] : ["sub", "dub"];
}
