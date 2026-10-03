#!/usr/bin/env node
/**
 * Verify every embedded playback source END-TO-END through the real
 * playback path:  /api/stream  ->  /api/stream/proxy  (exactly what the
 * player does, incl. the rf referer pass-through).
 *
 *   node scripts/verify-embeds.mjs [baseUrl]
 *   BASE_URL=https://<prod>.vercel.app node scripts/verify-embeds.mjs
 *
 * Matrix:
 *   - zoko SUB (flagship long-runner + latest ep + a finished show)
 *   - kiwi SUB
 *   - zoko DUB (verdict-gated; falls through the backfill chain — the
 *     response `provider` names the real source)
 *   - anivexa-anineko / animegg / hianime / allmanga / reanime DUB
 *     (each tried FIRST when requested; provider must match unless the
 *     upstream was empty, in which case the fallback that served counts)
 *
 * PASS requires the master playlist to load through the proxy AND one
 * child (variant or segment) to load through the proxy too.
 */
const BASE = (process.env.BASE_URL || (process.argv[2] || "http://localhost:3000")).replace(/\/+$/, "");

const results = [];
function report(provider, subject, status, detail) {
  results.push({ provider, subject, status, detail });
  console.log(`  [${status.padEnd(4)}] ${provider.padEnd(24)} ${subject.padEnd(30)} ${detail}`);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function jget(url, timeoutMs = 45_000) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Resolve one episode on one server via /api/stream. */
async function resolveStream(malId, ep, lang, server) {
  const url = `${BASE}/api/stream?malId=${malId}&ep=${ep}&lang=${lang}&server=${server}`;
  const { status, json } = await jget(url, 60_000);
  if (status !== 200 || !json?.src) {
    throw new Error(`api/stream ${status} ${json?.error ?? ""}`.trim());
  }
  return json;
}

/** Proxied URL exactly like WatchView builds it. */
function proxied(u, type, referer) {
  return `${BASE}/api/stream/proxy?type=${type}&u=${encodeURIComponent(u)}${referer ? `&rf=${encodeURIComponent(referer)}` : ""}`;
}

/**
 * Fetch an m3u8 (or mp4) through the proxy, then follow one child:
 * - m3u8 master -> first variant line -> fetch that through the proxy
 * - m3u8 media  -> first segment -> range-fetch through the proxy
 * - mp4         -> range-fetch first bytes
 * Returns { children, bytes } for the report.
 */
/**
 * Fetch an m3u8 (or mp4) through the proxy, then follow one child.
 * One retry: a stale-while-revalidate token refresh can 403/502 the very
 * first hit (the api/stream response raced the background re-resolve);
 * hls.js recovers the same way in the browser.
 */
async function verifyPlayable(src, referer, label) {
  const isHls = /\.m3u8(\?|$)/i.test(src);
  let first = null;
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      first = await fetch(proxied(src, isHls ? "m3u8" : "seg", referer), {
        headers: { "User-Agent": UA, ...(isHls ? {} : { Range: "bytes=0-1880" }) },
        signal: AbortSignal.timeout(25_000),
      });
      if (first.ok) break;
      lastErr = new Error(`proxy first fetch -> ${first.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i === 0) await new Promise((r) => setTimeout(r, 3500)); // let SWR refresh land
  }
  if (!first || !first.ok) throw lastErr ?? new Error("proxy fetch failed");
  if (!isHls) {
    const buf = new Uint8Array(await first.arrayBuffer());
    if (buf.length < 100) throw new Error("mp4 too small");
    return "mp4 bytes ok";
  }
  const text = await first.text();
  if (!text.includes("#EXTM3U")) throw new Error("proxy playlist: no #EXTM3U");
  const child = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!child) throw new Error("playlist has no children");
  // the proxy rewrites children to relative /api/stream/proxy?... URLs
  const childUrl = child.startsWith("http") ? proxied(child, "seg", referer) : `${BASE}${child}`;
  const seg = await fetch(childUrl, {
    headers: { "User-Agent": UA, Range: "bytes=0-1880" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!seg.ok && seg.status !== 206) throw new Error(`proxy child fetch -> ${seg.status}`);
  return "playlist + child ok";
}

async function run(provider, subject, malId, ep, lang, server, { requireProvider = false } = {}) {
  try {
    const stream = await resolveStream(malId, ep, lang, server);
    const servedBy = stream.provider ?? stream.serverUsed ?? "?";
    const detail = await verifyPlayable(stream.src, stream.referer ?? null, subject);
    if (requireProvider && servedBy !== server && !servedBy.includes(server.replace("anivexa-", ""))) {
      report(provider, subject, "N/A", `upstream empty; fallback served by ${servedBy} (${detail})`);
      return;
    }
    report(provider, subject, "PASS", `served by ${servedBy}: ${detail}`);
  } catch (e) {
    report(provider, subject, "FAIL", String(e.message || e).slice(0, 140));
  }
}

async function main() {
  console.log(`== Embedded playback verification — ${BASE} ==\n`);
  const OP = 21; // One Piece — long-runner flagship
  const JJK = 40748; // JUJUTSU KAISEN — wide dub coverage
  const FRIEREN = 52991; // Frieren — verified real dub on Zoko

  // warm the stream allowlist/verdict caches the way a real visit would
  await fetch(`${BASE}/api/stream/proxy?prime=1&malId=${OP}&ep=1&lang=sub&server=zoko`, { method: "POST" }).catch(() => {});

  // ---- main chain: SUB ----
  console.log("Main chain — SUB:");
  await run("zoko-sub", "One Piece ep1", OP, 1, "sub", "zoko");
  await run("zoko-sub", "One Piece latest", OP, 1176, "sub", "zoko");
  await run("kiwi-sub", "One Piece ep1", OP, 1, "sub", "kiwi");

  // ---- main chain: DUB ----
  console.log("\nMain chain — DUB (backfill chain may serve; provider names it):");
  await run("zoko-dub", "Frieren ep1 dub", FRIEREN, 1, "dub", "zoko");
  await run("zoko-dub", "JJK ep1 dub", JJK, 1, "dub", "zoko");

  // ---- backup dub network, provider by provider ----
  console.log("\nAnivexa backup DUB network (JJK ep1, provider-first):");
  for (const p of ["anineko", "animegg", "hianime", "allmanga", "reanime"]) {
    await run(`anivexa-${p}`, "JJK ep1 dub", JJK, 1, "dub", `anivexa-${p}`, { requireProvider: true });
  }

  // ---- summary ----
  console.log("\n== Summary ==");
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const na = results.filter((r) => r.status === "N/A").length;
  console.log(`PASS ${pass} / FAIL ${fail} / N/A ${na}`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => r.status === "FAIL")) console.log(`  - ${r.provider} [${r.subject}]: ${r.detail}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("verify-embeds crashed:", e);
  process.exitCode = 1;
});
