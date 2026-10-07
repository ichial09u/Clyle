import "server-only";

/**
 * Crunchyroll Continue-Watching sync (server-side).
 *
 * Crunchyroll has no public API, but its own web player speaks a stable
 * OAuth dialect on beta-api.crunchyroll.com: the viewer's session lives in
 * the `etp_rt` cookie, and exchanging that cookie with the web client's
 * public pair (the same pair crunchyroll.com itself ships, also used by the
 * open-source crunchy-cli / crunchyroll-go) mints a normal user access
 * token. With it we read:
 *   • /content/v2/discover/{accountId}/history  — recently watched
 *   • /content/v2/discover/{accountId}/playheads — resume seconds per episode
 *
 * The etp_rt value is used for ONE exchange per sync and never stored.
 *
 * Credentials note: this pair is Crunchyroll's own PUBLIC web client id
 * (empty secret). If Crunchyroll ever rotates it, the fix is grabbing the
 * new Authorization header from a logged-in crunchyroll.com request in the
 * browser devtools and updating CR_CLIENT_PAIR here.
 */
const AUTH = "https://beta-api.crunchyroll.com/auth/v1/token";
const API = "https://beta-api.crunchyroll.com";
// "noaihdevm_6iyg0a8l0q:" — Crunchyroll's public web client id (empty secret)
const CR_CLIENT_PAIR = process.env.CR_CLIENT_PAIR || "bm9haWhkZXZtXzZpeWcwYThsMHE6";

export interface CrunchyrollAuth {
  accessToken: string;
  accountId: string;
  /** seconds until expiry (for logging) */
  expiresIn: number;
}

export class CrunchyrollAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrunchyrollAuthError";
  }
}

/** Exchange the viewer's etp_rt cookie for a user access token.
 *
 * Two dialects of the same exchange (the etp_rt value IS the refresh token):
 *   1. grant_type=refresh_token with the value in the body
 *   2. grant_type=etp_rt_cookie with the value as the etp_rt cookie
 * Either accepting us proves the flow; try both so a Crunchyroll-side
 * dialect change can't silently kill the sync. */
export async function authWithEtpRt(etpRt: string): Promise<CrunchyrollAuth> {
  const attempts: Array<() => Promise<Response>> = [
    () =>
      fetch(AUTH, {
        method: "POST",
        headers: {
          Authorization: `Basic ${CR_CLIENT_PAIR}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: etpRt, scope: "offline_access" }),
        signal: AbortSignal.timeout(15_000),
      }),
    () =>
      fetch(AUTH, {
        method: "POST",
        headers: {
          Authorization: `Basic ${CR_CLIENT_PAIR}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `etp_rt=${encodeURIComponent(etpRt)}`,
        },
        body: new URLSearchParams({ grant_type: "etp_rt_cookie", scope: "offline_access" }),
        signal: AbortSignal.timeout(15_000),
      }),
  ];

  let lastStatus = 0;
  for (const attempt of attempts) {
    let res: Response;
    try {
      res = await attempt();
    } catch {
      continue; // network hiccup — try the next dialect
    }
    lastStatus = res.status;
    if (res.ok) {
      const data = (await res.json()) as { access_token?: string; account_id?: string; expires_in?: number };
      if (data.access_token && data.account_id) {
        return { accessToken: data.access_token, accountId: data.account_id, expiresIn: data.expires_in ?? 0 };
      }
      continue;
    }
    if (res.status === 401) {
      // client pair rejected outright — no point trying the other dialect
      throw new CrunchyrollAuthError("Crunchyroll no longer accepts this app client — the web client pair needs updating.");
    }
    // 400 with a rejected/expired token: try the next dialect; if it's the
    // last one, the message below is what the viewer sees.
  }

  if (lastStatus === 400 || lastStatus === 0) {
    throw new CrunchyrollAuthError(
      "Crunchyroll rejected that cookie — it may have expired or been copied incompletely. Grab a fresh etp_rt value while logged in (it changes when you log in again).",
    );
  }
  throw new CrunchyrollAuthError(`Crunchyroll sign-in failed (${lastStatus}).`);
}

interface CrHistoryItem {
  panel?: {
    media?: {
      id?: string;
      title?: string;
      series_title?: string;
      season_title?: string;
      episode?: string | number;
      episode_metadata?: { episode_number?: number; season_number?: number; series_title?: string };
    };
  };
}

export interface CrWatchEntry {
  /** best-effort series title */
  seriesTitle: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** media id — for the playhead lookup */
  mediaId: string | null;
}

/** Read the viewer's Crunchyroll watch history (most recent first). */
export async function fetchWatchHistory(auth: CrunchyrollAuth, limit = 50): Promise<CrWatchEntry[]> {
  const res = await fetch(
    `${API}/content/v2/discover/${encodeURIComponent(auth.accountId)}/history?pageSize=${limit}`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new CrunchyrollAuthError(`Crunchyroll history request failed (${res.status}).`);
  }
  const data = (await res.json()) as { items?: CrHistoryItem[] };
  const out: CrWatchEntry[] = [];
  for (const item of data.items ?? []) {
    const m = item?.panel?.media;
    if (!m) continue;
    const seriesTitle = m.series_title ?? m.episode_metadata?.series_title ?? m.season_title ?? "";
    const episodeNumber = m.episode_metadata?.episode_number ?? (m.episode != null ? parseInt(String(m.episode), 10) : NaN);
    const seasonNumber = m.episode_metadata?.season_number ?? null;
    if (!seriesTitle || !Number.isFinite(episodeNumber)) continue;
    out.push({ seriesTitle, seasonNumber, episodeNumber, mediaId: m.id ?? null });
  }
  return out;
}

export interface CrPlayhead {
  contentId: string;
  playhead: number;
  fullyWatched: boolean;
}

/** Resume seconds for the given media ids (batched). */
export async function fetchPlayheads(auth: CrunchyrollAuth, mediaIds: string[]): Promise<Map<string, CrPlayhead>> {
  const map = new Map<string, CrPlayhead>();
  if (!mediaIds.length) return map;
  const res = await fetch(
    `${API}/content/v2/discover/${encodeURIComponent(auth.accountId)}/playheads?content_ids=${encodeURIComponent(
      mediaIds.join(","),
    )}`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) return map;
  const data = (await res.json()) as { data?: Array<{ content_id?: string; playhead?: number; fully_watched?: boolean }> };
  for (const row of data.data ?? []) {
    if (row.content_id) {
      map.set(row.content_id, { contentId: row.content_id, playhead: row.playhead ?? 0, fullyWatched: !!row.fully_watched });
    }
  }
  return map;
}

/** Accent/space/punctuation-fold a title so "Pokémon" == "pokemon". */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}
export const normTitle = norm;
