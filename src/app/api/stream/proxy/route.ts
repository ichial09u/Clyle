import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";

export const dynamic = "force-dynamic";

/**
 * GET /api/stream/proxy?u=<encoded upstream url>
 *
 * Playback proxy — the missing piece that lets OUR player stream Zoko's
 * content without Zoko's ad-laden page:
 *
 *  1. Zoko's HLS CDN only accepts requests carrying Zoko's own Origin, so the
 *     browser cannot fetch playlists/segments directly. We fetch server-side
 *     with the right Origin/Referer and re-serve the bytes.
 *  2. For playlists (.m3u8) every child playlist / segment / key / subtitle
 *     URL is rewritten to point back at this proxy, so the whole session
 *     stays inside our origin.
 *  3. Segments and WebVTT subtitles stream straight through (no buffering).
 *
 * Only hosts advertised by a resolved stream (or Zoko's known CDN suffixes)
 * are fetchable — this is not a general open proxy.
 */

const ZOKO_ORIGIN = "https://zokoanime.video";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CDN_SUFFIXES = [".aniwatchtv.uk", ".zokoanime.video"];
const dynamicHosts = new Set<string>();

export function allowHost(hostname: string) {
  dynamicHosts.add(hostname.toLowerCase());
}

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (CDN_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (dynamicHosts.has(h)) return true;
  return false;
}

/** Remember every host mentioned by a resolved stream (called on resolve). */
async function primeAllowlist(malId: number, ep: number, lang: string, server: string) {
  const stream = await resolveStream(malId, ep, Number.isFinite(+ep) ? +ep : 1, lang === "dub" ? "dub" : "sub", server === "kiwi" ? "kiwi" : "zoko").catch(() => null);
  if (!stream) return;
  const hosts: string[] = [];
  try { hosts.push(new URL(stream.src).hostname); } catch { /* ignore */ }
  for (const sub of stream.subtitles ?? []) {
    try { hosts.push(new URL(sub.src).hostname); } catch { /* ignore */ }
  }
  for (const h of hosts) allowHost(h);
}

function proxied(abs: URL, type: "m3u8" | "seg" | "vtt"): string {
  return `/api/stream/proxy?type=${type}&u=${encodeURIComponent(abs.toString())}`;
}

function rewritePlaylist(text: string, baseUrl: URL): string {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      out.push("");
      continue;
    }
    if (line.startsWith("#")) {
      // rewrite URI="..." attributes (EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA)
      const rewritten = line.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
        try {
          const abs = new URL(uri, baseUrl);
          const isPlaylist = /\.m3u8($|\?)/i.test(abs.pathname);
          return `URI="${proxied(abs, isPlaylist ? "m3u8" : "seg")}"`;
        } catch {
          return _m;
        }
      });
      out.push(rewritten);
      continue;
    }
    try {
      const abs = new URL(line, baseUrl);
      const isPlaylist = /\.m3u8($|\?)/i.test(abs.pathname);
      const isVtt = /\.vtt($|\?)/i.test(abs.pathname);
      out.push(proxied(abs, isVtt ? "vtt" : isPlaylist ? "m3u8" : "seg"));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const raw = sp.get("u");
  if (!raw) return new NextResponse("missing u", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("bad u", { status: 400 });
  }
  if (target.protocol !== "https:" || !hostAllowed(target.hostname)) {
    return new NextResponse("host not allowed", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      "User-Agent": UA,
      Origin: ZOKO_ORIGIN,
      Referer: `${ZOKO_ORIGIN}/`,
      Accept: "*/*",
    },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);

  if (!upstream || !upstream.ok) {
    return new NextResponse(`upstream ${upstream ? upstream.status : "unreachable"}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isM3u8 = /\.m3u8($|\?)/i.test(target.pathname) || contentType.includes("mpegurl");

  if (isM3u8) {
    const text = await upstream.text();
    allowHost(target.hostname);
    // remember hosts of any absolute URLs we are about to hand out
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith("#")) continue;
      try { allowHost(new URL(l, target).hostname); } catch { /* ignore */ }
    }
    return new NextResponse(rewritePlaylist(text, target), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const type = sp.get("type");
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  if (type === "vtt" || contentType.includes("vtt")) {
    const text = await upstream.text();
    return new NextResponse(text, { headers: { ...headers, "Content-Type": "text/vtt; charset=utf-8" } });
  }

  // segments: stream the body straight through
  return new NextResponse(upstream.body, {
    headers: {
      ...headers,
      "Content-Type": contentType || "video/mp2t",
      ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length") as string } : {}),
    },
  });
}

/**
 * Warm the allowlist for an episode before the player starts fetching.
 * GET /api/stream/proxy?prime=1&malId=21&ep=1&lang=sub&server=zoko
 */
export async function POST(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("prime") !== "1") return new NextResponse("noop", { status: 400 });
  const malId = parseInt(sp.get("malId") ?? "", 10);
  const ep = parseInt(sp.get("ep") ?? "1", 10);
  if (!Number.isFinite(malId)) return new NextResponse("bad params", { status: 400 });
  await primeAllowlist(malId, ep, sp.get("lang") ?? "sub", sp.get("server") ?? "zoko");
  return new NextResponse("ok");
}
