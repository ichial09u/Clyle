/**
 * Backup DUB server identities — shared by client and server code.
 *
 * The Anivexa network (lib/anivexa.ts, server-side) resolves streams from
 * these providers; the UI shows each one as its own server button, but ONLY
 * on episodes where that provider actually carries the dub ("whoever has
 * that dub gets their server — if only 1 has it, only 1 dub button").
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

/** "anivexa-anineko" etc. — never shown for SUB (backup servers are DUB only). */
export type BackupServerId = `anivexa-${AnivexaProvider}`;

/** Every server the app can play: the main chain + the backup dub network. */
export type ServerId = "zoko" | "kiwi" | BackupServerId;

export function isBackupServer(s: string): s is BackupServerId {
  return s.startsWith("anivexa-");
}

export function backupProviderOf(s: BackupServerId): AnivexaProvider {
  return s.slice("anivexa-".length) as AnivexaProvider;
}

export function backupServerId(p: AnivexaProvider): BackupServerId {
  return `anivexa-${p}`;
}

export function backupServerName(s: BackupServerId): string {
  return BACKUP_PROVIDER_NAMES[backupProviderOf(s)];
}
