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

/**
 * Host suffixes the playback proxy may fetch. Static on purpose: on Vercel
 * each route is its own lambda, so runtime "allowHost" registration in one
 * function is invisible to the proxy's — the proxy must be able to allow
 * these hosts on its own (resolvers still register for per-host referers).
 */
export const PROXY_SUFFIXES: string[] = [
  ...MEGAP_SUFFIX_REFERERS.map(([suffix]) => suffix),
  ".hakunaymatata.com", // SupaPlay's moviebox video CDN (signed MP4s)
  ".wcostream.com", // WCO source (South Park) — video hosts rotate (e01/u14/…), plain signed URLs
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
  return undefined;
}

/** Was this host explicitly allowed by a resolver (beyond the static suffixes)? */
export function isAllowedHost(hostname: string): boolean {
  return dynamicHosts.has(hostname.toLowerCase());
}
