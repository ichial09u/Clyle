import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/art?u=<encoded image url> — same-origin art proxy.
 *
 * Hero banners / posters normally hot-link AniList's and MAL's CDNs. On some
 * networks (school Chromebooks, filtered DNS) those hosts are blocked or
 * flaky, so the hero background shows whichever single image happened to
 * load and never switches to the featured anime. Proxying through our own
 * origin fixes that, and Vercel's edge + the browser cache the results.
 *
 * Host allowlist — NOT an open proxy.
 */
const ALLOWED_HOSTS = new Set([
  "s4.anilist.co",
  "s1.anilist.co",
  "cdn.myanimelist.net",
  "z-cdn.chatglm.cn",
  "firebasestorage.googleapis.com",
  "img.youtube.com",
  "i.ytimg.com",
  // TMDB poster art — the catalog's primary poster source since Task 23
  "image.tmdb.org",
]);

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse("missing u", { status: 400 });

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new NextResponse("bad url", { status: 400 });
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    return new NextResponse("host not allowed", { status: 403 });
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClyleBot/1.0)", Accept: "image/*,*/*;q=0.8" },
      // art URLs are immutable — let the Next data cache hold them for a
      // week so repeat hero/poster renders skip the upstream entirely
      next: { revalidate: 604800 },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("upstream error", { status: 502 });
    }
    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);
    // browser caches hard (art is immutable), edge caches for a week
    headers.set("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400");
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch {
    return new NextResponse("fetch failed", { status: 502 });
  }
}
