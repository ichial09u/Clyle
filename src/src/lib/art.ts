/**
 * Client-side art URL helper.
 *
 * Hero/poster art comes from third-party CDNs (AniList, MAL, image-search).
 * Some networks — school Chromebooks especially — filter or throttle those
 * CDNs, which is how the desktop hero ends up stuck on whichever single
 * image did load. Wrapping them through our own /api/art proxy makes every
 * piece of art same-origin: one host to load, immune to CDN filters, and
 * CDN-cacheable on top.
 *
 * Local paths (/logos/…) already load from our origin — passed through.
 */
export function artUrl(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("/")) return src;
  return `/api/art?u=${encodeURIComponent(src)}`;
}
