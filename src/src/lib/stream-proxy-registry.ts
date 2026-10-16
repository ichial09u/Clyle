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

const dynamicHosts = new Set<string>();
/** hostname -> Referer to send (missing entry = Zoko default) */
const hostReferers = new Map<string, string>();

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

/** Allow a host for proxying, remembering which Referer it expects. */
export function allowHostWithReferer(hostname: string, referer: string | undefined): void {
  const h = hostname.toLowerCase();
  if (!h) return;
  dynamicHosts.add(h);
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

/** Was this host explicitly allowed by a resolver (beyond the static suffixes)? */
export function isAllowedHost(hostname: string): boolean {
  return dynamicHosts.has(hostname.toLowerCase());
}
