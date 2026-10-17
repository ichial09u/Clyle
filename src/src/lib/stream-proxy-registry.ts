/**
 * Shared host allowlist + per-host Referer registry for the playback proxy.
 *
 * Lives in its own module (not inside the proxy route) so resolvers
 * (zoko-stream, megaplay, supaplay) can register their CDN hosts without an
 * import cycle: route -> resolver -> registry, route -> registry.
 *
 * The proxy fetches upstream with the Referer each host expects:
 *  - Zoko's CDN wants Zoko's own Origin/Referer (historic default)
 *  - Megaplay's CDN wants `Referer: https://megaplay.buzz/`
 *  - SupaPlay's video CDN wants no special Referer at all
 */

export const ZOKO_REFERER = "https://zokoanime.video/";
export const MEGAPLAY_REFERER = "https://megaplay.buzz/";
/** Aniweeb's echovideo CDN expects the echo player's origin (it also 200s
 *  without one — belt and suspenders for the proxy + cast receiver). */
export const ANIWEEB_ECHO_REFERER = "https://play.echovideo.ru/";
/** empty string = send no Referer/Origin at all (plain signed URLs) */
export const NO_REFERER = "";

/** hostname -> allowedAt(ms). Bounded + TTL'd: an unbounded Set grew forever
 *  on a warm instance (rotating CDN families), and a permanently-remembered
 *  host skipped every shape check for the life of the process. */
const DYNAMIC_HOST_TTL_MS = 24 * 3600_000;
const DYNAMIC_HOST_CAP = 600;
const dynamicHosts = new Map<string, number>();
/** hostname -> Referer to send (missing entry = Zoko default) */
const hostReferers = new Map<string, string>();

/** Allow a host for proxying, remembering which Referer it expects. */
export function allowHostWithReferer(hostname: string, referer: string | undefined): void {
  const h = hostname.toLowerCase();
  if (!h) return;
  if (!dynamicHosts.has(h) && dynamicHosts.size >= DYNAMIC_HOST_CAP) {
    // evict the oldest-tracked host (insertion order) + its referer to stay
    // bounded; a still-live family gets re-learned by the next playlist serve
    const oldest = dynamicHosts.keys().next().value;
    if (oldest != null) {
      dynamicHosts.delete(oldest);
      hostReferers.delete(oldest);
    }
  }
  dynamicHosts.set(h, Date.now());
  if (referer != null) hostReferers.set(h, referer);
}

/** Referer the proxy should send for this host (undefined = Zoko default). */
export function refererForHost(hostname: string): string | undefined {
  const h = hostname.toLowerCase();
  const explicit = hostReferers.get(h);
  if (explicit != null) return explicit;
  for (const [suffix, referer] of MEGAP_SUFFIX_REFERERS) {
    if (h.endsWith(suffix)) return referer;
  }
  for (const [suffix, referer] of ANIWEEB_SUFFIX_REFERERS) {
    if (h.endsWith(suffix)) return referer;
  }
  for (const [suffix, referer] of NO_REFERER_SUFFIXES) {
    if (h.endsWith(suffix)) return referer;
  }
  return undefined;
}

/** Was this host explicitly allowed by a resolver (beyond the static suffixes)?
 *  Entries expire after 24h — a poisoned/rotted host must not stay trusted. */
export function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const at = dynamicHosts.get(h);
  if (at == null) return false;
  if (Date.now() - at > DYNAMIC_HOST_TTL_MS) {
    dynamicHosts.delete(h);
    hostReferers.delete(h);
    return false;
  }
  return true;
}

/** Megaplay CDN host families observed in the wild (subdomains rotate). */
const MEGAP_SUFFIX_REFERERS: Array<[string, string]> = [
  [".shiora.top", MEGAPLAY_REFERER],
  [".shiora.site", MEGAPLAY_REFERER],
  [".norami.top", MEGAPLAY_REFERER],
  [".akirax.buzz", MEGAPLAY_REFERER],
  [".mikora.top", MEGAPLAY_REFERER],
  [".kryntal.top", MEGAPLAY_REFERER],
  [".vaelith.top", MEGAPLAY_REFERER], // segment cloak host (DAN DA DAN dub)
];

/** Aniweeb's echovideo CDN family (ru-cdn2.echovideo.to, …) — plays with the
 *  echo player Referer, though the CDN answered 200 even without it. */
const ANIWEEB_SUFFIX_REFERERS: Array<[string, string]> = [
  [".echovideo.to", ANIWEEB_ECHO_REFERER],
  [".echovideo.ru", ANIWEEB_ECHO_REFERER],
  [".echovideo.com", ANIWEEB_ECHO_REFERER],
  [".aniweeb.net", ANIWEEB_ECHO_REFERER],
];

/**
 * Host suffixes the playback proxy may fetch. Static on purpose: on Vercel
 * each route is its own lambda, so runtime "allowHost" registration in one
 * function is invisible to the proxy's — the proxy must be able to allow
 * these hosts on its own (resolvers still register for per-host referers).
 */
/** Host families served with NO Referer at all (plain signed URLs). */
const NO_REFERER_SUFFIXES: Array<[string, string]> = [
  [".horrowing.cyou", NO_REFERER], // LM2 (lookmovie2) SP fallback storage — srvNNN rotate
  [".lookmovie2.to", NO_REFERER], // LM2 app host (movie session pages)
  [".vidcloud.sbs", NO_REFERER], // Aniweeb "Sakamoto" player — self-proxied HLS, no referer
];

export const PROXY_SUFFIXES: string[] = [
  ...MEGAP_SUFFIX_REFERERS.map(([suffix]) => suffix),
  ...ANIWEEB_SUFFIX_REFERERS.map(([suffix]) => suffix),
  ...NO_REFERER_SUFFIXES.map(([suffix]) => suffix),
  ".hakunaymatata.com", // SupaPlay's moviebox video CDN (signed MP4s)
  ".wcostream.com", // WCO source (South Park) — video hosts rotate (e01/u14/…), plain signed URLs
];

/**
 * WCO (South Park) video gateway pool. The getvid&json response pins the
 * playback URL to ONE `uNN` gateway, but the gateways are interchangeable:
 * the same evid token serves from any of them (verified 2026-10-09 across
 * u10/u13/u29/u32/u42). The catch: ~80% of the pool 403s datacenter IPs —
 * exactly where our resolvers, the playback proxy and the Chromecast
 * receiver all live — so a resolve that lands on a blocked gateway plays
 * nowhere (in-app spinner forever; TV stuck on its cast loading screen
 * with dead remote controls — the owner's 2026-10-09 cast report).
 * PRIMARY = gateways verified answering 206 through the production proxy
 * (datacenter IP) on 2026-10-09, healthy-first order. REST = the remaining
 * live hostnames (DNS-checked same day) as last-resort fallbacks for when
 * the healthy set rots; retries stay capped so a dead pool can't stall a
 * request for more than a few seconds (blocked nodes answer 403 in ~300ms).
 */
export const WCO_NODES_PRIMARY = ["u13", "u15", "u19", "u28", "u29", "u30"];
export const WCO_NODES_REST = [
  "u10", "u11", "u12", "u14", "u16", "u17", "u18", "u20", "u21", "u22", "u23",
  "u24", "u25", "u26", "u27", "u31", "u32", "u33", "u34", "u35", "u36", "u37",
  "u38", "u39", "u40", "u41", "u42", "u43", "u44",
];
