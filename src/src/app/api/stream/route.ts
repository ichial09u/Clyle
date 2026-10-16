import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";
import { megaplayDub, verifyRealMegaplayDub } from "@/lib/megaplay";
import { anikotoDub, verifyRealAnikotoDub } from "@/lib/anikoto";
import { supaplayDub } from "@/lib/supaplay";
import { anivexaDubStream } from "@/lib/anivexa";
import { resolveAniweebStream } from "@/lib/aniweeb";
import { wcoStream, WCO_REFERER } from "@/lib/wco";
import { lm2Stream } from "@/lib/lm2";
import { flixDubStream, FLIX_REFERER, flixDubThrough } from "@/lib/flixcloud";
import {
  isBackupServer,
  isAniweebServer,
  ANIWEEB_SUBDUB_SERVERS,
  backupProviderOf,
  backupServerName,
  backupServerId,
  type BackupServerId,
  type AniweebServerId,
} from "@/lib/backup-servers";
import { withSkipDataLive } from "@/lib/skip-times";
import { episodeHeights } from "@/lib/episode-quality";
import { ZOKO_REFERER } from "@/lib/stream-proxy-registry";
import { db } from "@/lib/db";
import type { Lang, ServerId } from "@/lib/zoko";

export const dynamic = "force-dynamic";
// fake-dub verification (sub-vs-dub segment compare) can take a while cold
export const maxDuration = 60;

/**
 * GET /api/stream?malId=21&ep=1&lang=sub&server=zoko
 *
 * Resolves one episode's direct HLS playlist + subtitle tracks + skip data
 * from Zoko, so our own player can stream it without Zoko's ad-laden page.
 *
 * DUB fallback chain (missing-dub backfill):
 *   1. the requested server (Zoko/Kiwi — verdict-gated real dubs)
 *   2. the other server ("if Zoko doesn't have it, show Kiwi's server")
 *   3. SupaPlay — ONLY when Server #1 was requested (its DUB source; needs
 *      an Anime.supaplayPath mapping)
 *   4. Aniweeb network (Aniweeb S1 / S2 / VidCloud — MAL-keyed, resolvable
 *      real playlists, the user-requested backup pool) — SUB and DUB
 *   5. Megaplay (yenime's api.flikhub.net backend) — Server #2's DUB source,
 *      and the final backfill for Server #1 when SupaPlay is unmapped.
 *   6. Megaplay-embed (megaplay.buzz getSources via AniKoto embed ids) —
 *      carries dubs flikhub misses (JJK S2 case); needs an
 *      Anime.anikotoSeriesId mapping from the dub-hunt campaign.
 *   7. Anivexa backup network (AniNeko / AnimeGG / AniWatch / AllManga /
 *      Reanime) — DUB only. Requesting server=anivexa-<provider> goes there
 *      FIRST and falls back down this chain when the provider can't deliver.
 * Sub backfill: when NEITHER main server carries the sub (both 404), the
 * Aniweeb network fills the gap — SUB no longer dead-ends on Zoko/Kiwi.
 * MegaFlix is embed-only (megaflix.buzz) and never resolves here.
 * The response's `serverUsed` keeps reporting Zoko/Kiwi (or the requested
 * server for backfill hits); `provider` names the actual source.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const malId = parseInt(sp.get("malId") ?? "", 10);
  const ep = parseInt(sp.get("ep") ?? "", 10);
  const lang: Lang = sp.get("lang") === "dub" ? "dub" : "sub";
  const rawServer = sp.get("server") ?? "zoko";
  const backupWanted = isBackupServer(rawServer);
  const server: ServerId = rawServer === "kiwi" ? "kiwi" : backupWanted ? rawServer : "zoko";
  const fresh = sp.get("fresh") === "1";
  if (!Number.isFinite(malId) || malId <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  // ---- WCO source (South Park) ------------------------------------------
  // Western cartoon: no AniList/MAL mapping on any chain site — playback
  // flows through the app's own resolvers for BOTH languages (the show
  // is natively English; SUB and DUB both play the same track). Answered
  // BEFORE the Zoko machinery so no chain probes burn time on it.
  // Task 27: the franchise is spread out — malId 999900+season picks the
  // entry's season (0 = Movies & Specials); the resolver maps (entry, ep)
  // to the WCO slug, falling back to the Episode row's stored slug for
  // freshness-scraped episodes that aren't in the baked manifest.
  // TWO PLAYERS, TWO SITES (owner: "another site like wco in the other
  // player — that's why there are 2 players"):
  //   Server 1 (zoko) = WCO  — wcoStream first, LM2 mirror as the dead-ep
  //                            fallback (S23E10 "Christmas Snow")
  //   Server 2 (kiwi) = LookMovie2 — lm2Stream FIRST (its own site, not a
  //                            WCO skin), WCO as the safety net so the
  //                            player never dead-ends on a busy pool
  // CC task: WCO ships no caption tracks for the show, so the vendored
  // English WebVTT (harvested from the LM2 mirror catalog, stored in
  // SpCaption) rides along as the episode's caption track — the player's
  // CC panel and drift sync pick it up like any other source's subs.
  const animeRow = await db.anime.findUnique({ where: { malId }, select: { source: true } });
  // the retired single-entry aggregator (999999) lost its Anime row when the
  // franchise spread out per season — stale deep links / session stacks must
  // still resolve (wcoStream maps 999999 by flat number), not 404
  if (animeRow?.source === "wco" || (!animeRow && malId >= 999900 && malId <= 999999)) {
    const wantLm2 = server === "kiwi"; // Server 2 = LookMovie2
    // BOTH sites play PROXIED — that is the path proven on real devices, and
    // with the proxy's Range passthrough the <video> element can seek inside
    // the MP4/HLS (raw browser-direct playback left seeks broken on devices
    // whose direct fetch the CDN refuses, with no way to fall back).
    const wcoFirst = async () => {
      const s = await wcoStream(malId, ep).catch(() => null);
      return s ? { s, provider: "wco" as const, direct: false } : null;
    };
    const lm2First = async () => {
      const s = await lm2Stream(malId, ep).catch(() => null);
      return s ? { s, provider: "lm2" as const, direct: false } : null;
    };
    // the requested site first; the other site is the shared safety net
    const hit = wantLm2 ? await lm2First() || (await wcoFirst()) : (await wcoFirst()) || (await lm2First());
    if (hit) {
      return respond(
        malId,
        ep,
        lang,
        await withSpCaptions(malId, ep, hit.s),
        server === "kiwi" ? "kiwi" : "zoko",
        hit.provider,
        hit.provider === "wco" ? WCO_REFERER : undefined,
        undefined,
        hit.direct,
      );
    }
    return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
  }

  if (lang === "sub") {
    // NEW — explicit Aniweeb-network SUB request (the backup pool serves
    // BOTH languages): try the requested source FIRST, fall through to the
    // main chain so the player never sits on a spinner.
    if (isAniweebServer(rawServer)) {
      const aniweeb = await resolveAniweebStream(malId, ep, "sub", rawServer as AniweebServerId, { fresh }).catch(() => null);
      if (aniweeb) {
        return respond(malId, ep, lang, { src: aniweeb.src, subtitles: aniweeb.subtitles }, server, rawServer, aniweeb.referer);
      }
    }
    // main chain — Zoko first, Kiwi second (unchanged)
    const stream = await resolveStream(malId, ep, "sub", backupWanted ? "zoko" : server, { fresh });
    if (!stream) {
      // GAP-FILL: neither main server carries this sub — the Aniweeb
      // network fills it in ("if they both don't have a … sub it can just
      // fill it in"). Three sources, raced in quality order.
      for (const which of ANIWEEB_SUBDUB_SERVERS) {
        const filled = await resolveAniweebStream(malId, ep, "sub", which, { fresh }).catch(() => null);
        if (filled) {
          return respond(malId, ep, lang, { src: filled.src, subtitles: filled.subtitles }, server, which, filled.referer);
        }
      }
      return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
    }
    // ZOKO_REFERER rides along so the player's FIRST proxy call is self-vetting:
    // Zoko rotates CDN domains (aniwatchtv.uk -> 1embed.buzz -> next), and the
    // proxy's static allowlist can never keep up. With rf= present the proxy
    // accepts the master playlist, and every child inherits the same rf.
    return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, stream), backupWanted ? "zoko" : server, backupWanted ? "zoko" : server, ZOKO_REFERER);
  }

  // ---- explicit BACKUP server request ("DUB AniNeko" / "Aniweeb S1") ----
  // The user picked a specific backup provider: try it FIRST. If its
  // upstream is dead or it never declared this episode, fall through to the
  // standard dub chain below so the player never sits on a spinner.
  if (backupWanted) {
    if (isAniweebServer(rawServer)) {
      const aniweeb = await resolveAniweebStream(malId, ep, "dub", rawServer as AniweebServerId, { fresh }).catch(() => null);
      if (aniweeb) {
        return respond(malId, ep, lang, { src: aniweeb.src, subtitles: aniweeb.subtitles }, server, server, aniweeb.referer);
      }
    } else {
      const provider = backupProviderOf(server as "anivexa-anineko");
      const animeRow = await db.anime.findUnique({
        where: { malId },
        select: { titleEnglish: true, title: true },
      });
      const title = animeRow?.titleEnglish?.trim() || animeRow?.title || null;
      const backup = await anivexaDubStream(malId, ep, { title, prefer: provider, maxAttempts: 1 }).catch(() => null);
      if (backup) {
        return respond(malId, ep, lang, { src: backup.src, subtitles: [] }, server, server, backup.referer);
      }
    }
    // else: fall through — better a real dub from another source than a 404
  }

  // ---- FlixCloud-first for mapped titles (Ranma ½ 2024 S1) ---------------
  // animefrenzy's dual-audio FlixCloud embeds carry the real English track.
  // The fleet probed every chain verdict FALSE for this title — Zoko's own
  // "dub" page is a re-upload of the sub — so resolving the chain here would
  // gamble on a DUB label with Japanese audio. Flix or honest 404 (the player
  // then offers the sub), nothing in between. Resolution happens server-side
  // so playback stays inside OUR player instead of their ArtPlayer iframe.
  const flixThru = flixDubThrough(malId);
  if (lang === "dub" && flixThru != null && ep <= flixThru) {
    const flix = await flixDubStream(malId, ep).catch(() => null);
    if (flix) {
      // flix.src is already a proxy URL serving the stored synthesized master
      // (the raw JWT master is IP-bound, so it never reaches the player raw);
      // pk rides along for the child playlists the proxy fetches later
      return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, { src: flix.src, subtitles: flix.subtitles, skip: flix.skip }), server, "flix", FLIX_REFERER, flix.pk);
    }
    return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
  }

  // ---- DUB: two-phase parallel resolution --------------------------------
  // The old chain resolved STRICTLY serially (requested server -> other
  // server -> SupaPlay -> megaplay -> megaplay-embed), so a fake/missing dub
  // on both Zoko and Kiwi (DAN DA DAN S1) made the player's spinner wait for
  // FIVE sequential upstream round-trips before the first frame. Phase A now
  // resolves both servers CONCURRENTLY (the DB verdicts short-circuit the
  // fake ones instantly — no payload fetch at all); only when both come back
  // empty does Phase B race the three backfill sources concurrently. The
  // selection order below still honours the same priority as before, so the
  // response is identical — just reached much sooner.
  //
  // A BACKUP server request that its own provider couldn't serve lands HERE —
  // `mainServer` keeps the Zoko/Kiwi machinery honest (never pass an
  // anivexa-* id into resolveStream) and the response reports the REAL source.
  const mainServer: "zoko" | "kiwi" = server === "kiwi" ? "kiwi" : "zoko";
  const other: "zoko" | "kiwi" = mainServer === "kiwi" ? "zoko" : "kiwi";
  const pRequested = resolveStream(malId, ep, "dub", mainServer, { fresh }).catch(() => null);
  const pOther = resolveStream(malId, ep, "dub", other, { fresh }).catch(() => null);

  const requested = await pRequested;
  if (requested) return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, requested), mainServer, mainServer, ZOKO_REFERER);
  const alt = await pOther;
  if (alt) return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, alt), other, other, ZOKO_REFERER);

  // Phase B — the DUB backfill sources, all at once. SupaPlay only belongs
  // to Server #1 requests (its DUB source); megaplay/yenime is Server #2's,
  // and the megaplay-embed network is the final net. The 24h-cached verdicts
  // keep the ad-stub fake dubs out; a transient "couldn't check" (null)
  // never blocks playback.
  const pSupa = mainServer === "zoko" ? supaplayDub(malId, ep, { fresh }).catch(() => null) : null;
  const pMega = (async () => {
    const megaVerdict = await verifyRealMegaplayDub(malId, ep);
    if (megaVerdict === false) return null;
    return megaplayDub(malId, ep, { fresh });
  })().catch(() => null);
  const pKoto = (async () => {
    const kotoVerdict = await verifyRealAnikotoDub(malId, ep);
    if (kotoVerdict === false) return null;
    return anikotoDub(malId, ep, { fresh });
  })().catch(() => null);

  const supa = await pSupa;
  if (supa) return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, supa), mainServer, "supaplay");

  // Phase B2 — the ANIWEEB network (user-requested backup pool, MAL-keyed,
  // real resolvable playlists). All three sources race concurrently and the
  // first usable one in quality order wins; a miss here still leaves the
  // megaplay/anikoto/anivexa chain below.
  const pAni1 = resolveAniweebStream(malId, ep, "dub", "aniweeb-1", { fresh }).catch(() => null);
  const pAni2 = resolveAniweebStream(malId, ep, "dub", "aniweeb-2", { fresh }).catch(() => null);
  const pVid = resolveAniweebStream(malId, ep, "dub", "vidcloud", { fresh }).catch(() => null);
  const ani1 = await pAni1;
  if (ani1) return respond(malId, ep, lang, { src: ani1.src, subtitles: ani1.subtitles }, mainServer, "aniweeb-1", ani1.referer);
  const ani2 = await pAni2;
  if (ani2) return respond(malId, ep, lang, { src: ani2.src, subtitles: ani2.subtitles }, mainServer, "aniweeb-2", ani2.referer);
  const vid = await pVid;
  if (vid) return respond(malId, ep, lang, { src: vid.src, subtitles: vid.subtitles }, mainServer, "vidcloud", vid.referer);

  const mega = await pMega;
  if (mega) return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, mega), mainServer, "yenime");
  const koto = await pKoto;
  if (koto) return respond(malId, ep, lang, await withInheritedCaptions(malId, ep, lang, koto), mainServer, "megaplay-embed");

  // Phase C — the Anivexa backup network, the final net. One provider
  // attempt here keeps the worst-case dub latency bounded; a provider that
  // was already tried above is skipped by the prefer-miss path. (An Aniweeb
  // server id isn't an Anivexa provider — prefer stays null there.)
  const backup = await anivexaDubStream(malId, ep, {
    prefer: backupWanted && server.startsWith("anivexa-") ? backupProviderOf(server as "anivexa-anineko") : null,
    maxAttempts: 1,
  }).catch(() => null);
  if (backup) {
    return respond(malId, ep, lang, { src: backup.src, subtitles: [] }, server, backupServerId(backup.provider), backup.referer);
  }

  return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
}

/**
 * CAPTION INHERITANCE — a stream that ships no caption tracks used to blank
 * the CC panel even though the OTHER language's page carries the full
 * multi-language track set (the census proved this is widespread: zoko lists
 * 0 subtitles on 39 dub pages whose sub pages carry 5-12 languages, and 12
 * sub pages whose ONLY tracks live on the dub page). Subtitles are text
 * tracks timed to the episode content, not the audio language, so the other
 * page's tracks ride along — and the CC-sync fleet's per-episode offsets
 * (CaptionSync) apply to them exactly as before. Never blocks playback: any
 * failure returns the stream untouched.
 */
async function withInheritedCaptions<
  T extends { subtitles: Array<{ lang: string; label: string; src: string }> },
>(malId: number, ep: number, lang: Lang, stream: T): Promise<T> {
  if (stream.subtitles?.length) return stream;
  const donor: Lang = lang === "dub" ? "sub" : "dub";
  try {
    const other = await resolveStream(malId, ep, donor, "zoko");
    if (other?.subtitles?.length) return { ...stream, subtitles: other.subtitles };
  } catch {
    /* captions are a bonus — never block playback on them */
  }
  return stream;
}

/**
 * Attach the vendored English CC (SpCaption) to a South Park stream. The
 * src is a same-origin /api/captions/sp URL — WatchView serves /-rooted
 * caption sources directly (no proxy hop needed for our own origin).
 */
async function withSpCaptions<T extends { subtitles: Array<{ lang: string; label: string; src: string }> }>(
  malId: number,
  ep: number,
  stream: T,
): Promise<T> {
  try {
    const cap = await db.spCaption.findUnique({
      where: { malId_ep: { malId, ep } },
      select: { content: true },
    });
    if (!cap) return stream;
    return {
      ...stream,
      subtitles: [{ lang: "en", label: "English", src: `/api/captions/sp/${malId}/${ep}.vtt` }, ...stream.subtitles],
    };
  } catch {
    return stream; // captions are a bonus — never block playback on them
  }
}

/** Enrich + send one resolved stream (skip data, provider, referer, no-store). */
async function respond(
  malId: number,
  ep: number,
  lang: Lang,
  stream: {
    src: string;
    subtitles: Array<{ lang: string; label: string; src: string }>;
    skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } };
    /** per-quality direct sources (South Park's WCO encodes / LM2 masters) —
     * passed straight to the player's quality sheet + download chips */
    qualities?: Array<{ height: number; src: string }>;
  },
  serverUsed: ServerId,
  provider: "zoko" | "kiwi" | "supaplay" | "yenime" | "megaplay-embed" | "flix" | "wco" | "lm2" | "aniweeb-1" | "aniweeb-2" | "vidcloud" | ServerId,
  referer?: string | null,
  pk?: string,
  direct?: boolean,
) {
  // enrich Zoko's sparse skip data (OP/ED timings) with the vendored AniSkip
  // dataset + a cached live AniSkip query for brand-new/uncovered episodes
  // (the live query wants the episode's length in minutes for its filters)
  const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
  const enriched = await withSkipDataLive(malId, ep, stream, { episodeLengthMin: meta?.durationMin });
  // the episode's REAL resolution ladder — fleet-measured or parsed from the
  // master playlist now (persisted either way). Drives the download dialog's
  // options: old shows list 360p only, never a 1080p that doesn't exist.
  // Only resolvable for direct URLs (proxy-served synthesized masters are
  // skipped — the fallback ladder applies there).
  // South Park arrives with the ladder ALREADY resolved per-encode
  // (stream.qualities) — progressive MP4s have no master to parse, so the
  // runtime probe below would fetch a whole movie for nothing.
  const qualitySrcs = stream.qualities?.length ? [...stream.qualities].sort((a, b) => b.height - a.height) : null;
  const heights = qualitySrcs
    ? qualitySrcs.map((q) => q.height)
    : /^https?:\/\//i.test(stream.src)
      ? await episodeHeights(malId, ep, lang, stream.src, referer).catch(() => null)
      : null;
  return NextResponse.json(
    {
      ...enriched,
      serverUsed,
      provider,
      ...(heights && heights.length ? { heights } : {}),
      ...(qualitySrcs ? { qualitySrcs } : {}),
      // backup dub sources need their Referer riding along on every proxy
      // fetch (rf param) — the player forwards it on the first playlist call
      ...(referer ? { referer } : {}),
      // FlixCloud playlists arrive XOR-obfuscated; the proxy peels that with
      // this per-video key (rides along like rf, propagates to children)
      ...(pk ? { pk } : {}),
      // WCO: the <video> element must hit the CDN directly (server-side
      // fetches are fingerprint-gated) — the player skips the proxy entirely
      ...(direct ? { direct: true } : {}),
      // a friendly display name for the toast ("DUB via AniNeko (backup)")
      ...(isBackupServer(provider) ? { providerName: backupServerName(provider) } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
