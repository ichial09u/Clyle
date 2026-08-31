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
  const stream = await resolveStream(malId, ep, lang === "dub" ? "dub" : "sub", server === "kiwi" ? "kiwi" : "zoko").catch(() => null);
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

/* ------------------------------------------------------------------ *
 * Hidden-quality discovery.
 *
 * Zoko's master playlists advertise only ONE variant (usually 1080p),
 * but the CDN also hosts the standard ladder at the same path:
 *   {base}/360/index.m3u8, {base}/480/..., {base}/720/..., {base}/1080/...
 * We probe the siblings and synthesize a proper multi-variant master so
 * hls.js gets real levels -> the quality panel lists everything and the
 * Auto setting can actually adapt between qualities mid-episode.
 * ------------------------------------------------------------------ */

const VARIANT_HEIGHTS = [360, 480, 720, 1080] as const;
const VARIANT_META: Record<number, { bandwidth: number; resolution: string }> = {
  360: { bandwidth: 800_000, resolution: "640x360" },
  480: { bandwidth: 1_300_000, resolution: "854x480" },
  720: { bandwidth: 2_600_000, resolution: "1280x720" },
  1080: { bandwidth: 5_300_000, resolution: "1920x1080" },
};

// Probe results per master base path (the token dirs rotate with the tokens,
// so a fresh upload naturally re-probes).
const probeCache = new Map<string, { expires: number; heights: number[] }>();

async function probeVariant(url: URL): Promise<boolean> {
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": UA, Origin: ZOKO_ORIGIN, Referer: `${ZOKO_ORIGIN}/`, Accept: "*/*" },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const head = await res.text();
    return head.includes("#EXTM3U");
  } catch {
    return false;
  }
}

/**
 * If `text` is a single-variant master playlist, probe the sibling quality
 * dirs and return a synthesized multi-variant master (still upstream-absolute;
 * the normal rewrite pass proxies it afterwards). Otherwise return null.
 */
async function enrichMaster(text: string, target: URL): Promise<string | null> {
  if (!text.includes("#EXT-X-STREAM-INF")) return null;
  const lines = text.split(/\r?\n/);
  const variantUris = lines.filter((l) => l.trim() && !l.startsWith("#"));
  if (variantUris.length !== 1) return null; // already multi-variant (or odd) — leave alone

  const uri = variantUris[0].trim();
  const abs = new URL(uri, target);
  const m = abs.pathname.match(/\/(\d{3,4})\/index\.m3u8$/i);
  if (!m) return null;
  const current = parseInt(m[1], 10);
  if (!VARIANT_HEIGHTS.includes(current as (typeof VARIANT_HEIGHTS)[number])) return null;

  const dir = abs.pathname.slice(0, abs.pathname.lastIndexOf("/")) .replace(/\/\d{3,4}$/, ""); // .../token-dirs
  const cacheKey = `${abs.origin}${dir}`;
  const cached = probeCache.get(cacheKey);
  let heights: number[];

  if (cached && cached.expires > Date.now()) {
    heights = cached.heights;
  } else {
    const siblings = VARIANT_HEIGHTS.filter((h) => h !== current);
    const results = await Promise.all(
      siblings.map(async (h) => {
        const u = new URL(`${abs.origin}${dir}/${h}/index.m3u8`);
        return (await probeVariant(u)) ? h : null;
      }),
    );
    heights = [current, ...(results.filter((h) => h != null) as number[])];
    heights.sort((a, b) => a - b);
    probeCache.set(cacheKey, { expires: Date.now() + TTL_30MIN, heights });
  }

  if (heights.length <= 1) return null; // genuinely single-quality source

  // keep the original line's bandwidth/resolution for the current variant when present
  const infLine = lines.find((l) => l.startsWith("#EXT-X-STREAM-INF")) ?? "";
  const curBw = Number(/BANDWIDTH=(\d+)/.exec(infLine)?.[1] ?? VARIANT_META[current].bandwidth);
  const curRes = /RESOLUTION=(\S+)/.exec(infLine)?.[1] ?? VARIANT_META[current].resolution;

  const out: string[] = ["#EXTM3U", "#EXT-X-VERSION:4"];
  for (const h of heights) {
    const meta = VARIANT_META[h] ?? { bandwidth: 2_000_000, resolution: `${h}p` };
    const isCurrent = h === current;
    out.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${isCurrent ? curBw : meta.bandwidth},RESOLUTION=${isCurrent ? curRes : meta.resolution}`,
    );
    out.push(`${abs.origin}${dir}/${h}/index.m3u8`);
  }
  return out.join("\n");
}

const TTL_30MIN = 30 * 60 * 1000;

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
    // single-variant master? add the CDN's hidden quality siblings (360/480/720/1080)
    const enriched = await enrichMaster(text, target).catch(() => null);
    return new NextResponse(rewritePlaylist(enriched ?? text, target), {
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
