import { NextResponse } from "next/server";
import { resolveStream } from "@/lib/zoko-stream";
import { megaplayDub, verifyRealMegaplayDub } from "@/lib/megaplay";
import { anikotoDub, verifyRealAnikotoDub } from "@/lib/anikoto";
import { supaplayDub } from "@/lib/supaplay";
import { anivexaDubStream } from "@/lib/anivexa";
import { flixDubStream, FLIX_REFERER, flixDubThrough } from "@/lib/flixcloud";
import {
  isBackupServer,
  backupProviderOf,
  backupServerName,
  backupServerId,
  type BackupServerId,
} from "@/lib/backup-servers";
import { withSkipDataLive } from "@/lib/skip-times";
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
 *   4. Megaplay (yenime's api.flikhub.net backend) — Server #2's DUB source,
 *      and the final backfill for Server #1 when SupaPlay is unmapped.
 *   5. Megaplay-embed (megaplay.buzz getSources via AniKoto embed ids) —
 *      carries dubs flikhub misses (JJK S2 case); needs an
 *      Anime.anikotoSeriesId mapping from the dub-hunt campaign.
 *   6. Anivexa backup network (AniNeko / AnimeGG / AniWatch / AllManga /
 *      Reanime) — the user-requested backup DUB servers for titles our
 *      chain can't dub (and per-episode dub gaps like One Piece's newest
 *      arc). Requesting server=anivexa-<provider> goes there FIRST and
 *      falls back down this chain when the provider can't deliver.
 * All backfill sources are DUB ONLY — SUB always flows through Zoko/Kiwi.
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

  if (lang === "sub") {
    // SUB always flows through Zoko/Kiwi — the backup network is DUB only,
    // so even a backup server request answers with Zoko's sub.
    const stream = await resolveStream(malId, ep, "sub", backupWanted ? "zoko" : server, { fresh });
    if (!stream) return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
    // ZOKO_REFERER rides along so the player's FIRST proxy call is self-vetting:
    // Zoko rotates CDN domains (aniwatchtv.uk -> 1embed.buzz -> next), and the
    // proxy's static allowlist can never keep up. With rf= present the proxy
    // accepts the master playlist, and every child inherits the same rf.
    return respond(malId, ep, stream, backupWanted ? "zoko" : server, backupWanted ? "zoko" : server, ZOKO_REFERER);
  }

  // ---- explicit BACKUP DUB server request ("DUB AniNeko" button) --------
  // The user picked a specific backup provider: try it FIRST. If its
  // upstream is dead or it never declared this episode, fall through to the
  // standard dub chain below so the player never sits on a spinner.
  if (backupWanted) {
    const provider = backupProviderOf(server as BackupServerId);
    const animeRow = await db.anime.findUnique({
      where: { malId },
      select: { titleEnglish: true, title: true },
    });
    const title = animeRow?.titleEnglish?.trim() || animeRow?.title || null;
    const backup = await anivexaDubStream(malId, ep, { title, prefer: provider, maxAttempts: 1 }).catch(() => null);
    if (backup) {
      return respond(malId, ep, { src: backup.src, subtitles: [] }, server, server, backup.referer);
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
      return respond(malId, ep, { src: flix.src, subtitles: flix.subtitles, skip: flix.skip }, server, "flix", FLIX_REFERER, flix.pk);
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
  if (requested) return respond(malId, ep, requested, mainServer, mainServer, ZOKO_REFERER);
  const alt = await pOther;
  if (alt) return respond(malId, ep, alt, other, other, ZOKO_REFERER);

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
  if (supa) return respond(malId, ep, supa, mainServer, "supaplay");
  const mega = await pMega;
  if (mega) return respond(malId, ep, mega, mainServer, "yenime");
  const koto = await pKoto;
  if (koto) return respond(malId, ep, koto, mainServer, "megaplay-embed");

  // Phase C — the Anivexa backup network, the final net. One provider
  // attempt here keeps the worst-case dub latency bounded; a provider that
  // was already tried above is skipped by the prefer-miss path.
  const backup = await anivexaDubStream(malId, ep, {
    prefer: backupWanted ? backupProviderOf(server as BackupServerId) : null,
    maxAttempts: 1,
  }).catch(() => null);
  if (backup) {
    return respond(malId, ep, { src: backup.src, subtitles: [] }, server, backupServerId(backup.provider), backup.referer);
  }

  return NextResponse.json({ error: "stream unavailable" }, { status: 404 });
}

/** Enrich + send one resolved stream (skip data, provider, referer, no-store). */
async function respond(
  malId: number,
  ep: number,
  stream: { src: string; subtitles: Array<{ lang: string; label: string; src: string }>; skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } } },
  serverUsed: ServerId,
  provider: "zoko" | "kiwi" | "supaplay" | "yenime" | "megaplay-embed" | "flix" | ServerId,
  referer?: string | null,
  pk?: string,
) {
  // enrich Zoko's sparse skip data (OP/ED timings) with the vendored AniSkip
  // dataset + a cached live AniSkip query for brand-new/uncovered episodes
  // (the live query wants the episode's length in minutes for its filters)
  const meta = await db.anime.findUnique({ where: { malId }, select: { durationMin: true } });
  const enriched = await withSkipDataLive(malId, ep, stream, { episodeLengthMin: meta?.durationMin });
  return NextResponse.json(
    {
      ...enriched,
      serverUsed,
      provider,
      // backup dub sources need their Referer riding along on every proxy
      // fetch (rf param) — the player forwards it on the first playlist call
      ...(referer ? { referer } : {}),
      // FlixCloud playlists arrive XOR-obfuscated; the proxy peels that with
      // this per-video key (rides along like rf, propagates to children)
      ...(pk ? { pk } : {}),
      // a friendly display name for the toast ("DUB via AniNeko (backup)")
      ...(isBackupServer(provider) ? { providerName: backupServerName(provider) } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
