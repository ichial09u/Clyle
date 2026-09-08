import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { freshMediaByMal, airedEpisodeCount } from "@/lib/anilist";
import { importEpisodes, importEpisodesFromList, episodeTitleBackfillPages, backfillEpisodeTitles } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { probeDubAvailable } from "@/lib/zoko-stream";
import { probeMegaplayDub, storeMegaplayVerdict } from "@/lib/megaplay";
import { jikanHealthy } from "@/lib/jikan";
import { recomputeDubBoundaries } from "@/lib/dub-boundary";
import { cachedBackupDubSummary, warmBackupDubSummary } from "@/lib/anivexa";
import { backupServerId, type BackupServerId } from "@/lib/backup-servers";
export const dynamic = "force-dynamic";

// ---- 90s per-anime freshness memo (the repeat-view tax fix) ---------------
// Re-running the AniList freshness race + inline title fill on EVERY view
// made repeat views cost the same 2-3.5s as the first. Within 90s of the
// last freshness run for an anime, the grid answers from local rows alone
// (pure DB, ~10ms) — the first view stays budget-raced, later ones are free.
const FRESHNESS_MEMO_MS = 90_000;
const lastFreshRun = new Map<number, number>(); // malId -> last run ts

/**
 * GET /api/anime/{malId}/episodes
 *
 * Episodes are materialised locally (numbers + dates) so the app can show
 * the grid instantly and badge new arrivals; playback itself always uses
 * Zoko's player URL. If more episodes have aired than we know of, they are
 * imported here and now — "import immediately".
 *
 * Freshness source: AniList (single lightweight request; its
 * nextAiringEpisode pinpoints exactly how many episodes have aired, which
 * even covers long-runners like One Piece). Falls back to probing MAL's
 * paginated episode list when AniList has no schedule for the show.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ malId: string }> }) {
  const { malId: malIdStr } = await params;
  const malId = parseInt(malIdStr, 10);
  if (!Number.isFinite(malId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const anime = await db.anime.findUnique({ where: { malId } });
  if (!anime) return NextResponse.json({ error: "not found" }, { status: 404 });

  // freshness check for airing shows — pulls the aired episode count from AniList.
  // BUDGET (the slow-buttons complaint): AniList inline used to block the grid
  // for as long as the upstream felt like taking (3-8s on a bad day, right
  // between "Watch" and the episode buttons). Now it races a 1.5s budget —
  // on loss the check + import finish in the background and the NEXT view
  // picks the new episodes up. The grid answers from local rows at all times.
  let newlyAdded = 0;
  const freshEpisodes: number[] = [];
  const memoHit = Date.now() - (lastFreshRun.get(malId) ?? 0) < FRESHNESS_MEMO_MS;
  if (!memoHit) {
    if (lastFreshRun.size > 4000) lastFreshRun.clear(); // bounded
    lastFreshRun.set(malId, Date.now());
  }
  const backgroundFreshness = async () => {
    try {
      const media = await freshMediaByMal(malId);
      const aired = airedEpisodeCount(media);
      if (aired != null && aired > anime.totalEpisodes) {
        await db.anime.update({ where: { malId }, data: { totalEpisodes: aired } });
        await importEpisodes(malId, aired);
      } else if (aired == null) {
        await importEpisodesFromList(malId); // no schedule — probe MAL's list
      }
    } catch {
      /* background best-effort */
    }
  };
  if (anime.airing && !memoHit) {
    let media: Awaited<ReturnType<typeof freshMediaByMal>> | null = null;
    try {
      media = await Promise.race([
        freshMediaByMal(malId),
        new Promise<null>((r) => setTimeout(() => r(null), 1_500)),
      ]);
    } catch {
      media = null;
    }
    if (media) {
      const aired = airedEpisodeCount(media);
      if (aired != null) {
        if (aired > anime.totalEpisodes) {
          await db.anime.update({ where: { malId }, data: { totalEpisodes: aired } });
          const added = await importEpisodes(malId, aired);
          newlyAdded = added.length;
          freshEpisodes.push(...added);
        }
      } else {
        after(() => backgroundFreshness());
      }
    } else {
      // AniList slow or unreachable — the grid must not wait on it
      after(() => backgroundFreshness());
    }
    // brand-new episodes import their skip intro/ending along with them
    // (background, rate-limited, after the response is flushed)
    if (freshEpisodes.length) after(() => prefetchSkipTimes(freshEpisodes.map((ep) => ({ malId, ep, lenMin: anime.durationMin })), 8));
  }

  // real episode titles ("Episode 1: Ryomen Sukuna") — rows created from
  // AniList's aired count have none. Small gaps fill inline (one Jikan page
  // for a normal show, so even the very first visit sees titles); large
  // gaps (long-runners) run after the response flushes. Fully-titled anime
  // skip all of this for the price of one query.
  //
  // GUARD (the DAN DA DAN skeleton hang): a flaky Jikan turns that inline
  // await into ~84s of timeouts+backoffs and the grid stares at skeletons.
  // So the inline path (a) only runs while Jikan is healthy and (b) races a
  // short budget — on loss the backfill keeps running in the background and
  // the NEXT view of this page has the titles.
  const titlePages = memoHit ? 0 : await episodeTitleBackfillPages(malId);
  if (titlePages > 0) {
    if (titlePages <= 2 && jikanHealthy()) {
      await Promise.race([
        backfillEpisodeTitles(malId).catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 2_000)),
      ]);
    } else {
      after(() => backfillEpisodeTitles(malId).catch(() => undefined));
    }
  }

  const episodes = await db.episode.findMany({
    where: { animeId: malId, lang: "sub" },
    orderBy: { number: "asc" },
    select: { number: true, title: true, aired: true, addedAt: true },
  });

  // fall back to the stored count if the episode table has not caught up yet
  const total = episodes.length > 0 ? episodes[episodes.length - 1].number : anime.totalEpisodes;

  // does a REAL DUB exist for this show? probe once per server, remember.
  // The verdict is per-anime (probed at ep 1) — individual later episodes
  // just 404 at play time until the dub catches up.
  //
  // These probes download segments from BOTH servers (~5-10s cold) — never
  // make the grid wait for them (that was the other half of the skeleton
  // hang). Until a verdict lands, null keeps the optimistic UI and the
  // stream route validates at play time anyway.
  let hasDub = anime.hasDub;
  let hasDubKiwi = anime.hasDubKiwi;
  let hasDubMega = anime.hasDubMega;
  const probeJobs: Array<Promise<void>> = [];
  if (hasDub == null) {
    probeJobs.push(
      probeDubAvailable(malId, 1).then((v) => {
        if (v != null) {
          hasDub = v;
          void db.anime.update({ where: { malId }, data: { hasDub: v } }).catch(() => undefined);
        }
      }),
    );
  }
  if (hasDubKiwi == null) {
    probeJobs.push(
      probeDubAvailable(malId, 1, "kiwi").then((v) => {
        if (v != null) {
          hasDubKiwi = v;
          void db.anime.update({ where: { malId }, data: { hasDubKiwi: v } }).catch(() => undefined);
        }
      }),
    );
  }
  // missing-dub backfill: when neither Zoko nor Kiwi carries a real dub,
  // probe the Megaplay/yenime source once — that's what fills the gap.
  if (hasDub === false && hasDubKiwi === false && hasDubMega == null) {
    probeJobs.push(
      probeMegaplayDub(malId, 1).then((v) => {
        if (v != null) {
          hasDubMega = v;
          void storeMegaplayVerdict(malId, v);
        }
      }),
    );
  }
  if (probeJobs.length) after(() => Promise.all(probeJobs).catch(() => undefined));

  // null = not probed -> optimistic (show DUB; the stream API validates)
  const dubServers: Array<"zoko" | "kiwi"> = [];
  if (hasDub !== false) dubServers.push("zoko");
  if (hasDubKiwi !== false) dubServers.push("kiwi");
  // no Zoko/Kiwi dub but a backfill source can serve one — still offer both
  // DUB buttons; /api/stream transparently lands them on the backfill source
  // (flikhub megaplay, or the megaplay-embed network when the anime is mapped)
  const backfillPossible = hasDubMega === true || anime.anikotoSeriesId != null;
  if (!dubServers.length && backfillPossible) dubServers.push("zoko", "kiwi");

  // ---- per-EPISODE dub boundaries (the Elbaph fix) ------------------------
  // An anime-level "has dub" can't express "the dub hasn't reached the
  // current arc yet": One Piece carries DUB buttons on episodes that were
  // never dubbed. dubThru is the highest episode a REAL dub is proven for
  // per server chain (0 = proven none; null = unknown -> keep the optimistic
  // anime-level behaviour above). Maintained by the fleet bots + refreshed
  // here in the background.
  const totalNum = total;
  const checkedAt = anime.dubThruCheckedAt?.getTime() ?? 0;
  // a backfill mapping (SupaPlay path / AniKoto series) means dub is possible
  // even when all three anime-level verdicts are false (JJK S2 case) — keep
  // the boundary search alive for those
  const anyDubPossible =
    anime.hasDub !== false ||
    anime.hasDubKiwi !== false ||
    anime.hasDubMega !== false ||
    anime.anikotoSeriesId != null ||
    !!anime.supaplayPath?.trim();
  // a chain's search is CLOSED only when its boundary converged (thru = hi-1,
  // thru = total, or thru = 0 proven-none); anything else keeps probing
  const chainClosed = (thru: number | null, hi: number | null) => {
    if (thru == null) return false; // unknown — search open
    if (thru <= 0) return true; // proven no dub anywhere
    return thru >= (hi ?? totalNum + 1) - 1; // converged at the hi bound
  };
  const gapOpen =
    !chainClosed(anime.dubThruS1, anime.dubHiS1) || !chainClosed(anime.dubThruS2, anime.dubHiS2);
  const stale =
    anyDubPossible &&
    (gapOpen ||
      (((anime.dubThruS1 ?? 0) < totalNum || (anime.dubThruS2 ?? 0) < totalNum) &&
        anime.airing &&
        Date.now() - checkedAt > 12 * 3600_000));
  if (stale) {
    after(() => recomputeDubBoundaries(malId, 6, { recheck: anime.airing }).catch(() => undefined));
  }

  // per-episode HOLES inside a proven prefix (DAN DA DAN S1: eps 4-6 were
  // never dubbed while 1-3 and 7-12 stream real dubs). A prefix boundary
  // can't express that, but the fleet's per-episode DubProbe rows can:
  // an episode is reported missing only when BOTH chains carry a definitive
  // ok=false probe for it (either chain alone can still serve the dub via
  // fallback). A later positive probe flips the row and it stops missing.
  let dubMissing: number[] = [];
  if (totalNum > 0) {
    const falseProbes = await db.dubProbe.findMany({
      where: { malId, ok: false, ep: { gte: 1, lte: totalNum } },
      select: { ep: true, chain: true },
    });
    const s1Miss = new Set(falseProbes.filter((p) => p.chain === "s1").map((p) => p.ep));
    const s2Miss = new Set(falseProbes.filter((p) => p.chain === "s2").map((p) => p.ep));
    dubMissing = [...s1Miss].filter((ep) => s2Miss.has(ep)).sort((x, y) => x - y);
  }

  // ---- BACKUP DUB servers (the Anivexa network) ---------------------------
  // "Add backup players for animes that HAS dub but we don't have yet —
  // whoever has that dub gets their server; if only 1 has it, only 1 dub
  // button." Episodes our chain can't dub (sub-only titles, the dub hasn't
  // reached the newest arc, or holes like DAN DA DAN 4-6) get one button per
  // outside provider that actually carries that dub. null = still probing
  // (the background warm fills it; /api/stream still backfills at play
  // time), [] = probed and nothing helps, otherwise one entry per provider
  // that covers at least ONE un-covered episode.
  let backupDub:
    | Array<{ server: BackupServerId; provider: string; name: string; through: number | null; covered: number[] }>
    | null = null;
  {
    const s1 = anime.dubThruS1 ?? null;
    const s2 = anime.dubThruS2 ?? null;
    const boundariesKnown = s1 != null || s2 != null;
    // null chainMax = unprobed -> optimistic full coverage (no clutter)
    const chainMax = boundariesKnown ? Math.max(s1 ?? 0, s2 ?? 0) : null;
    const needed: number[] = [];
    if (totalNum > 0) {
      if (chainMax != null) {
        for (let e = chainMax + 1; e <= totalNum; e++) needed.push(e);
      }
      for (const e of dubMissing) if (!needed.includes(e)) needed.push(e);
      if (dubServers.length === 0 && needed.length === 0) {
        // sub-only show, boundaries proven 0 — every episode is uncovered
        for (let e = 1; e <= totalNum; e++) needed.push(e);
      }
    }
    if (needed.length > 0) {
      const summary = await cachedBackupDubSummary(malId);
      if (summary != null) {
        const neededSet = new Set(needed);
        backupDub = summary
          // only providers that actually dub at least ONE uncovered episode
          .filter((b) => b.covered.some((ep) => neededSet.has(ep)))
          .map((b) => ({
            server: backupServerId(b.provider),
            provider: b.provider,
            name: b.name,
            through: b.through,
            covered: b.covered,
          }));
      } else {
        const title = anime.titleEnglish?.trim() || anime.title;
        after(() => warmBackupDubSummary(malId, title).catch(() => undefined));
      }
    } else if (totalNum > 0) {
      backupDub = []; // chain covers everything — no backup clutter
    }
  }

  return NextResponse.json({
    malId,
    title: anime.titleEnglish?.trim() || anime.title,
    type: anime.type,
    airing: anime.airing,
    durationMin: anime.durationMin,
    total,
    hasDub: dubServers.length > 0,
    dubServers,
    dubThrough: { s1: anime.dubThruS1 ?? null, s2: anime.dubThruS2 ?? null },
    dubMissing,
    backupDub,
    episodes: episodes.map((e) => ({ number: e.number, title: e.title, aired: e.aired, addedAt: e.addedAt })),
    newlyAdded,
  });
}
