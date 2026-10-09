import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { freshMediaByMal, airedEpisodeCount } from "@/lib/anilist";
import { importEpisodes, importEpisodesFromList, episodeTitleBackfillPages, backfillEpisodeTitles } from "@/lib/sync";
import { prefetchSkipTimes } from "@/lib/skip-times";
import { probeDubAvailable, probeSubAvailable } from "@/lib/zoko-stream";
import { probeMegaplayDub, storeMegaplayVerdict } from "@/lib/megaplay";
import { jikanHealthy } from "@/lib/jikan";
import { recomputeDubBoundaries } from "@/lib/dub-boundary";
import { cachedBackupDubSummary, warmBackupDubSummary } from "@/lib/anivexa";
import { flixDubThrough } from "@/lib/flixcloud";
import { backupServerId, type BackupServerId } from "@/lib/backup-servers";
import { getDubAudioVerdict } from "@/lib/dub-audio";

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

  // ---- WCO source (South Park, one entry per season) ----------------------
  // A western cartoon has no AniList/Jikan/Zoko presence: the AniList
  // freshness race and the Zoko sub/dub probes below would all fail (and
  // the probes would store false verdicts that HIDE the buttons). Instead:
  // the grid answers from local rows and a memoized background refresh
  // re-scrapes WCO for new episodes of the airing season. (Task 27: the
  // franchise is spread out — malId 999900 = Movies & Specials,
  // 999901..999929 = Season 1..29 — so each entry is a flat grid like every
  // other show; the old single-entry season dropdown is gone.)
  if (anime.source === "wco") {
    const episodes = await db.episode.findMany({
      where: { animeId: malId, lang: "sub" },
      orderBy: { number: "asc" },
      select: { number: true, title: true, aired: true, addedAt: true },
    });
    const total = episodes.length > 0 ? episodes[episodes.length - 1].number : anime.totalEpisodes;

    // background refresh (10-min GLOBAL memo): one re-scrape of the WCO
    // series page, with each new episode routed to its OWN entry — the
    // airing S29 (999929) keyed by its real episode number, brand-new
    // specials appended to Movies & Specials (999900)
    const wcoMemo = Date.now() - (lastFreshRun.get(0) ?? 0) < FRESHNESS_MEMO_MS;
    if (!wcoMemo) {
      lastFreshRun.set(0, Date.now());
      after(async () => {
        try {
          const { wcoFreshEpisodes } = await import("@/lib/wco");
          const fresh = await wcoFreshEpisodes();
          if (!fresh.length) return;
          const touched = new Map<number, number>();
          let nextSpecial = -1;
          for (const f of fresh) {
            if (f.season != null && f.season >= 1 && f.season <= 29 && f.episode != null) {
              const target = 999900 + f.season;
              await db.episode.upsert({
                where: { animeId_number_lang: { animeId: target, number: f.episode, lang: "sub" } },
                update: { title: f.title, slug: f.slug },
                create: { animeId: target, number: f.episode, title: f.title, slug: f.slug, lang: "sub" },
              });
              touched.set(target, Math.max(touched.get(target) ?? 0, f.episode));
            } else {
              // a new special/movie — append to the Movies & Specials entry
              if (nextSpecial < 0) {
                const last = await db.episode.findFirst({
                  where: { animeId: 999900, lang: "sub" },
                  orderBy: { number: "desc" },
                  select: { number: true },
                });
                nextSpecial = (last?.number ?? 0) + 1;
              }
              await db.episode.upsert({
                where: { animeId_number_lang: { animeId: 999900, number: nextSpecial, lang: "sub" } },
                update: { title: f.title, slug: f.slug },
                create: { animeId: 999900, number: nextSpecial, title: f.title, slug: f.slug, lang: "sub" },
              });
              touched.set(999900, nextSpecial);
              nextSpecial += 1;
            }
          }
          for (const [id, max] of touched) {
            await db.anime.update({ where: { malId: id }, data: { totalEpisodes: max } }).catch(() => undefined);
          }
        } catch {
          /* background best-effort */
        }
      });
    }

    return NextResponse.json({
      malId,
      title: anime.titleEnglish?.trim() || anime.title,
      type: anime.type,
      airing: anime.airing,
      durationMin: anime.durationMin,
      total,
      // per-season entries can have number gaps (S28 starts at 2 — WCO never
      // carried S28E1): the grid renders EXACTLY these numbers instead of a
      // contiguous 1..total range. Absent for every other show.
      numbers: episodes.map((e) => e.number),
      // WCO serves the one natively-English track — there is no sub/dub
      // choice to make (owner: "don't show sub button at all for South
      // Park"). Dub-only payload: the server sheet renders a single DUB
      // button and the player hides the [SUB|DUB] control entirely.
      hasDub: true,
      dubServers: ["zoko" as const],
      hasSub: false,
      subServers: [] as Array<"zoko" | "kiwi">,
      dubThrough: { s1: total, s2: total },
      dubMissing: [] as number[],
      backupDub: [],
      episodes: episodes.map((e) => ({ number: e.number, title: e.title, aired: e.aired, addedAt: e.addedAt })),
      newlyAdded: 0,
      freshnessPending: false,
    });
  }


  // freshness check for airing shows — pulls the aired episode count from AniList.
  // BUDGET (the slow-buttons complaint): AniList inline used to block the grid
  // for as long as the upstream felt like taking (3-8s on a bad day, right
  // between "Watch" and the episode buttons). Now it races a 1.5s budget —
  // on loss the check + import finish in the background and the NEXT view
  // picks the new episodes up. The grid answers from local rows at all times.
  let newlyAdded = 0;
  const freshEpisodes: number[] = [];
  // true when the freshness check was deferred past this response (AniList
  // slow or schedule-less) — a brand-new episode may be importing right now
  // and the client refetches shortly so it shows up without a re-visit.
  let freshnessPending = false;
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
        freshnessPending = true; // no schedule — probe MAL's list
        after(() => backgroundFreshness());
      }
    } else {
      // AniList slow or unreachable — the grid must not wait on it
      freshnessPending = true;
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
  // SUB verdicts — mirror of the dub probes (Pokémon-class titles are
  // DUB-ONLY on Zoko/Kiwi: their sub pages are 200 shells with no payload,
  // so every SUB button on them was guaranteed-dead before this existed).
  let hasSub = anime.hasSub;
  let hasSubKiwi = anime.hasSubKiwi;
  const probeJobs: Array<Promise<void>> = [];
  if (hasSub == null) {
    probeJobs.push(
      probeSubAvailable(malId, 1).then((v) => {
        if (v != null) {
          hasSub = v;
          void db.anime.update({ where: { malId }, data: { hasSub: v } }).catch(() => undefined);
        }
      }),
    );
  }
  if (hasSubKiwi == null) {
    probeJobs.push(
      probeSubAvailable(malId, 1, "kiwi").then((v) => {
        if (v != null) {
          hasSubKiwi = v;
          void db.anime.update({ where: { malId }, data: { hasSubKiwi: v } }).catch(() => undefined);
        }
      }),
    );
  }
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

  // SUB buttons from the verdicts (mirror of dubServers). null = not probed
  // -> optimistic (show SUB; the stream API validates at play time), so a
  // fleet of unprobed titles looks exactly like today until a probe lands.
  const subServers: Array<"zoko" | "kiwi"> = [];
  if (hasSub !== false) subServers.push("zoko");
  if (hasSubKiwi !== false) subServers.push("kiwi");

  // null = not probed -> optimistic (show DUB; the stream API validates)
  const dubServers: Array<"zoko" | "kiwi"> = [];
  if (hasDub !== false) dubServers.push("zoko");
  if (hasDubKiwi !== false) dubServers.push("kiwi");
  // no Zoko/Kiwi dub but a backfill source can serve one — still offer both
  // DUB buttons; /api/stream transparently lands them on the backfill source
  // (flikhub megaplay, the megaplay-embed network when the anime is mapped,
  // or the FlixCloud dual-audio embeds when the title carries one)
  const flixThru = flixDubThrough(malId);
  const backfillPossible = hasDubMega === true || anime.anikotoSeriesId != null || flixThru != null;
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
    !!anime.supaplayPath?.trim() ||
    flixThru != null;
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
        // Fleet verdict gate: a provider the audio fleet measured FAKE for an
        // episode (Japanese audio under a DUB label — the DAN DA DAN pattern)
        // must not claim that episode. Providers whose entire needed coverage
        // is fake drop off the sheet entirely — "whoever HAS that dub" means
        // a REAL dub, measured, not merely declared.
        const fakeRows = await db.dubAudio.findMany({
          where: { malId, verdict: "fake", server: { startsWith: "anivexa-" } },
          select: { ep: true, server: true },
        });
        const fakeByServer = new Map<string, Set<number>>();
        for (const r of fakeRows) {
          let set = fakeByServer.get(r.server);
          if (!set) fakeByServer.set(r.server, (set = new Set()));
          set.add(r.ep);
        }
        backupDub = summary
          .map((b) => {
            const fakes = fakeByServer.get(backupServerId(b.provider));
            const covered = fakes ? b.covered.filter((ep) => !fakes.has(ep)) : b.covered;
            return {
              server: backupServerId(b.provider),
              provider: b.provider,
              name: b.name,
              through: covered.length ? covered[covered.length - 1] : null,
              covered,
            };
          })
          // only providers that actually dub at least ONE uncovered episode
          .filter((b) => b.covered.some((ep) => neededSet.has(ep)));
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
    hasSub: subServers.length > 0,
    subServers,
    dubThrough: {
      s1: maxThru(anime.dubThruS1, flixThru),
      s2: maxThru(anime.dubThruS2, flixThru),
    },
    dubMissing,
    backupDub,
    episodes: episodes.map((e) => ({ number: e.number, title: e.title, aired: e.aired, addedAt: e.addedAt })),
    newlyAdded,
    freshnessPending,
  });
}

/** boundary pick: the highest proven dub episode across a chain and the flix map (null-aware) */
function maxThru(a: number | null | undefined, b: number | null): number | null {
  if (b == null) return a ?? null;
  if (a == null) return b;
  return Math.max(a, b);
}
