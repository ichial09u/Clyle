import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { resolveStream } from "@/lib/zoko-stream";
import {
  allowHostWithReferer,
  refererForHost,
  isAllowedHost,
  PROXY_SUFFIXES,
  ZOKO_REFERER,
} from "@/lib/stream-proxy-registry";
import { flixStoredMaster, FLIX_REFERER } from "@/lib/flixcloud";

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

const CDN_SUFFIXES = [".aniwatchtv.uk", ".zokoanime.video", ".1embed.buzz"];

/**
 * Upstream headers for one host: each provider's CDN only accepts the
 * Referer its own player sends (Zoko -> zokoanime.video, Megaplay ->
 * megaplay.buzz, SupaPlay -> none). The registry remembers which is which;
 * hosts resolved before this point fall back to Zoko's headers.
 */
function upstreamHeadersFor(hostname: string, refererOverride?: string): Record<string, string> {
  // a self-described child URL carries the referer its own playlist used —
  // authoritative across lambda/instance boundaries (the in-memory registry
  // is per-instance; megaplay's CDN host families rotate past every static
  // list, so the playlist itself is the only durable source of truth)
  const referer = refererOverride !== undefined ? refererOverride : refererForHost(hostname);
  if (referer === "") return { "User-Agent": UA, Accept: "*/*" }; // signed URLs, no referer wanted
  if (referer) return { "User-Agent": UA, Referer: referer, Accept: "*/*" };
  return { "User-Agent": UA, Origin: ZOKO_ORIGIN, Referer: `${ZOKO_ORIGIN}/`, Accept: "*/*" };
}

export function allowHost(hostname: string) {
  allowHostWithReferer(hostname, undefined);
}

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (CDN_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (PROXY_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (isAllowedHost(h)) return true;
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

function proxied(abs: URL, type: "m3u8" | "seg" | "vtt", referer?: string | null, pk?: string | null): string {
  // `rf` rides along on every child URL so any later lambda serving it uses
  // the exact upstream headers the issuing playlist was fetched with
  const rf = referer != null ? `&rf=${encodeURIComponent(referer)}` : "";
  // `pk` likewise: FlixCloud child playlists need the same XOR key the master
  // used (it is static per video, but propagating keeps the flow stateless)
  const p = pk ? `&pk=${encodeURIComponent(pk)}` : "";
  return `/api/stream/proxy?type=${type}&u=${encodeURIComponent(abs.toString())}${rf}${p}`;
}

/**
 * FlixCloud serves every playlist base64(XOR(bytes, __pk)) — the 32-byte key
 * their patched hls.js derives from a per-video WASM mixing step. We resolved
 * that key at stream time (flixcloud.ts); peel the layer here so OUR stock
 * hls.js sees plaintext playlists. Segments are standard HLS and pass through.
 */
function flixDecrypt(text: string, pkHex: string | null): string {
  if (!pkHex || text.startsWith("#EXTM3U")) return text;
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+\/=]+$/.test(trimmed)) return text; // not a base64 blob
  try {
    const bin = Buffer.from(trimmed, "base64");
    const pk = Buffer.from(pkHex, "hex");
    if (pk.length < 16) return text;
    const out = Buffer.from(bin);
    for (let i = 0; i < out.length; i++) out[i] ^= pk[i % pk.length];
    const dec = out.toString("utf8");
    return dec.startsWith("#EXTM3U") ? dec : text;
  } catch {
    return text;
  }
}

/**
 * SRT → WebVTT (FlixCloud ships English SDH/dubtitle SRTs). The changes are
 * tiny: a WEBVTT header, and commas in the timecodes become dots.
 */
function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/^\d+\s*$/gm, "") // SRT sequence numbers are invalid VTT cues
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `WEBVTT\n\n${body}\n`;
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

async function probeVariant(url: URL, referer?: string): Promise<boolean> {
  try {
    const res = await fetch(url.toString(), {
      headers: upstreamHeadersFor(url.hostname, referer),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(3_000),
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
async function enrichMaster(text: string, target: URL, inheritedReferer?: string): Promise<string | null> {
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
        return (await probeVariant(u, inheritedReferer)) ? h : null;
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

/* ------------------------------------------------------------------ *
 * Parallel segment acceleration (the "every anime struggles to load" fix).
 *
 * Measured on the Zoko/Kiwi CDN (hls.dramahot.top family): each HTTP
 * connection is throttled to roughly 300 KB/s regardless of origin — a
 * single-connection 720p segment (~680 KB) takes ~2.3 s (barely above
 * real-time for its 4 s of video) and a 1080p segment (~1.4 MB) takes
 * ~4.7 s — BELOW real-time, so playback stalls no matter the title.
 *
 * The CDN throttles PER CONNECTION, not per client, so the proxy fetches
 * each large segment as 4 concurrent byte-range requests and stitches
 * them: ~4x effective throughput (~1.2 MB/s) — 1080p lands in ~1.2 s.
 * Any failure (no Range support, non-206, timeout) falls back to the
 * plain single-connection stream, so this can only speed things up.
 * ------------------------------------------------------------------ */

const SEG_PARALLEL_MIN = 384 * 1024; // below this a single fetch is already fast
const SEG_PARALLEL_MAX = 8 * 1024 * 1024; // progressive MP4s etc. must keep streaming
const SEG_CONNECTIONS = 4;

async function fetchSegmentRanges(
  target: URL,
  headers: Record<string, string>,
  total: number,
): Promise<Buffer | null> {
  const chunkSize = Math.ceil(total / SEG_CONNECTIONS);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < SEG_CONNECTIONS; i++) {
    const start = i * chunkSize;
    if (start >= total) break;
    ranges.push([start, Math.min(start + chunkSize - 1, total - 1)]);
  }
  if (ranges.length < 2) return null;
  const parts = await Promise.all(
    ranges.map(async ([start, end]) => {
      const res = await fetch(target.toString(), {
        headers: { ...headers, Range: `bytes=${start}-${end}` },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status !== 206) throw new Error(`range ${res.status}`); // CDN ignored Range
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== end - start + 1) throw new Error("short range");
      return buf;
    }),
  );
  return Buffer.concat(parts);
}

function rewritePlaylist(text: string, baseUrl: URL, inheritedReferer?: string, pk?: string | null): string {
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
          return `URI="${proxied(abs, isPlaylist ? "m3u8" : "seg", inheritedReferer, pk)}"`;
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
      out.push(proxied(abs, isVtt ? "vtt" : isPlaylist ? "m3u8" : "seg", inheritedReferer, pk));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** curl transport (Cloudflare 403-challenges undici on some FlixCloud paths —
 *  the AES-128 key files — while curl's TLS fingerprint passes). Returns the
 *  raw body on HTTP 200, else null. */
function curlBuffer(url: string, referer: string, timeoutMs = 25_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-sS", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-A", UA, "-H", `Referer: ${referer}`, "-H", "Accept: */*", "-w", "\n__STATUS__%{http_code}", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5_000, encoding: "buffer" },
      (err, stdout) => {
        try {
          const out = stdout as Buffer;
          const marker = Buffer.from("\n__STATUS__");
          const idx = out.lastIndexOf(marker);
          if (idx < 0) return resolve(null);
          const code = parseInt(out.subarray(idx + marker.length).toString("utf8"), 10);
          resolve(code === 200 ? out.subarray(0, idx) : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  // ---- FlixCloud stored master: served from the resolver's cache ----------
  // The stream route already fetched + decrypted + absolutized the master
  // (in the same invocation that burned the one-time token, so the JWT's
  // client-IP binding was satisfied). We just hand the stored text out and
  // let the normal rewrite pass proxy its JWT-less children.
  const fkey = sp.get("fkey");
  if (fkey) {
    const malId = parseInt(sp.get("malId") ?? "", 10);
    const ep = parseInt(sp.get("ep") ?? "", 10);
    if (Number.isFinite(malId) && Number.isFinite(ep)) {
      const stored = await flixStoredMaster(malId, ep).catch(() => null);
      if (stored) {
        const pk = sp.get("pk") ?? undefined;
        const rf = sp.get("rf") ?? undefined;
        const target = sp.get("u");
        const base = target ? new URL(target) : new URL("https://fetch9.flixcloud.cc/master.m3u8");
        return new NextResponse(rewritePlaylist(stored, base, rf, pk), {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "public, max-age=30",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      // fall through to the u fallback below when the store went cold
    }
  }

  const raw = sp.get("u");
  if (!raw) return new NextResponse("missing u", { status: 400 });

  // self-described child URL: `rf` is the exact Referer its issuing playlist
  // was fetched with (rotating megaplay families outrun any static list, and
  // Vercel lambdas share no memory — the URL itself is the source of truth)
  const hasRf = sp.has("rf");
  const rfParam = sp.get("rf") ?? "";
  // FlixCloud playlist XOR key (hex) — present only on flix-backed streams
  const pkParam = sp.get("pk");

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("bad u", { status: 400 });
  }
  // a rewritten child was already vetted when its playlist was served
  if (target.protocol !== "https:" || (!hasRf && !hostAllowed(target.hostname))) {
    return new NextResponse("host not allowed", { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: upstreamHeadersFor(target.hostname, hasRf ? rfParam : undefined),
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);

  // FlixCloud-backed session and undici got challenged (403 challenge page on
  // the AES-128 key files) — retry with curl's transport before giving up
  if (pkParam && (!upstream || upstream.status === 403)) {
    const buf = await curlBuffer(target.toString(), hasRf && rfParam ? rfParam : FLIX_REFERER);
    if (buf && buf.length > 0) {
      const isM3u8Path = /\.m3u8($|\?)/i.test(target.pathname);
      if (isM3u8Path) {
        const text = flixDecrypt(buf.toString("utf8"), pkParam);
        const inheritedReferer = hasRf ? rfParam : refererForHost(target.hostname);
        return new NextResponse(rewritePlaylist(text, target, inheritedReferer, pkParam), {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "public, max-age=30",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "Cache-Control": "public, max-age=86400, immutable",
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/octet-stream",
        },
      });
    }
  }

  if (!upstream || !upstream.ok) {
    return new NextResponse(`upstream ${upstream ? upstream.status : "unreachable"}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isM3u8 = /\.m3u8($|\?)/i.test(target.pathname) || contentType.includes("mpegurl");

  if (isM3u8) {
    const rawText = await upstream.text();
    // FlixCloud: peel the XOR layer before any rewriting happens
    const text = flixDecrypt(rawText, pkParam);
    // this playlist's own referer is what all of its children expect
    const inheritedReferer = hasRf ? rfParam : refererForHost(target.hostname);
    allowHostWithReferer(target.hostname, inheritedReferer);
    // remember hosts of any absolute URLs we are about to hand out
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith("#")) continue;
      try { allowHostWithReferer(new URL(l, target).hostname, inheritedReferer); } catch { /* ignore */ }
    }
    // single-variant master? add the CDN's hidden quality siblings (360/480/720/1080)
    const enriched = await enrichMaster(text, target, inheritedReferer).catch(() => null);
    return new NextResponse(rewritePlaylist(enriched ?? text, target, inheritedReferer, pkParam), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // playlists: 30s edge/browser cache — tokens rotate, but 30s is well
        // inside their lifetime and kills the double-fetch on seek-backs
        "Cache-Control": "public, max-age=30",
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
    // FlixCloud subtitles are SRT — browsers only render WebVTT tracks
    const isSrt = /\.srt($|\?)/i.test(target.pathname) || contentType.includes("subrip");
    return new NextResponse(isSrt ? srtToVtt(text) : text, {
      headers: { ...headers, "Content-Type": "text/vtt; charset=utf-8" },
    });
  }

  // segments: stream the body straight through — unless it is a big one, in
  // which case the parallel range fetch above beats the single throttled
  // connection by ~4x (the per-connection CDN throttle was the stall).
  // The already-open single fetch stays open as the fallback; it is only
  // discarded once the parallel fetch has actually succeeded.
  const contentLength = parseInt(upstream.headers.get("content-length") ?? "", 10);
  const upstreamHeaders = upstreamHeadersFor(target.hostname, hasRf ? rfParam : undefined);
  if (
    upstream.status === 200 &&
    Number.isFinite(contentLength) &&
    contentLength >= SEG_PARALLEL_MIN &&
    contentLength <= SEG_PARALLEL_MAX
  ) {
    const stitched = await fetchSegmentRanges(target, upstreamHeaders, contentLength).catch(() => null);
    if (stitched) {
      void upstream.body?.cancel().catch(() => undefined);
      return new NextResponse(new Uint8Array(stitched), {
        headers: {
          ...headers,
          // segments are immutable at a given (tokened) URL — a day of browser
          // caching means seek-backs and ABR down-switches hit memory, not the
          // proxy lambda again (overrides the no-store default above)
          "Cache-Control": "public, max-age=86400, immutable",
          "Content-Type": contentType || "video/mp2t",
          "Content-Length": String(contentLength),
        },
      });
    }
  }

  return new NextResponse(upstream.body, {
    headers: {
      ...headers,
      // segments are immutable at a given (tokened) URL — a day of browser
      // caching means seek-backs and ABR down-switches hit memory, not the
      // proxy lambda again (overrides the no-store default above)
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Type": contentType || "video/mp2t",
      ...(Number.isFinite(contentLength) ? { "Content-Length": String(contentLength) } : {}),
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
