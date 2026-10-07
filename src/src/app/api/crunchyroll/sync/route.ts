import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  authWithEtpRt,
  CrunchyrollAuthError,
  fetchPlayheads,
  fetchWatchHistory,
  normTitle,
} from "@/lib/crunchyroll";
import { sessionFromRequest } from "@/lib/auth";
import { extractEtpRt, looksLikeEmail } from "@/lib/etprt";

export const dynamic = "force-dynamic";

/**
 * POST /api/crunchyroll/sync  { etpRt: string, userId?: string }
 *
 * Brings the viewer's Crunchyroll Continue Watching into Clyle:
 *   1. exchange the pasted etp_rt cookie for a one-shot user token
 *   2. read the Crunchyroll watch history + playhead seconds
 *   3. match each entry against OUR catalog (accent/space-folded titles)
 *   4. write WatchProgress rows under the signed-in identity (session cookie
 *      wins; otherwise the anonymous device id from the body)
 *
 * The etp_rt value is never stored — used once for the exchange and dropped.
 * Progress is only written where Crunchyroll actually has a resume point, and
 * removal tombstones are respected (a title the viewer removed stays gone).
 */
interface SyncBody {
  etpRt?: string;
  userId?: string;
}

export async function POST(req: Request) {
  let b: SyncBody;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const session = sessionFromRequest(req);
  const userId = session?.id ?? (typeof b.userId === "string" ? b.userId.trim().slice(0, 80) : "");
  if (!userId) return NextResponse.json({ error: "not signed in and no device id" }, { status: 401 });
  // the paste can be the bare value, an "etp_rt=…" fragment, or a whole Cookie
  // header — extract whatever we recognize before validating
  const etpRt = extractEtpRt(b.etpRt ?? "");
  if (!etpRt) {
    if (looksLikeEmail(b.etpRt ?? "")) {
      return NextResponse.json(
        { error: "Crunchyroll blocks password sign-ins from outside sites — paste the etp_rt cookie from your logged-in browser instead (Profile → Crunchyroll has the steps)." },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "paste your Crunchyroll etp_rt cookie (or the whole cookie line)" }, { status: 400 });
  }

  try {
    const auth = await authWithEtpRt(etpRt);
    const history = await fetchWatchHistory(auth, 50);
    if (!history.length) {
      return NextResponse.json(
        { ok: true, imported: 0, matched: [], unmatched: [], message: "Crunchyroll has no watch history for that account yet." },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const playheads = await fetchPlayheads(
      auth,
      history.map((h) => h.mediaId).filter((id): id is string => !!id),
    );

    // match Crunchyroll series titles against our catalog
    const catalog = await db.anime.findMany({
      where: { inCatalog: true },
      select: { malId: true, title: true, titleEnglish: true, durationMin: true },
    });
    const byNorm = new Map<string, (typeof catalog)[number]>();
    for (const a of catalog) {
      for (const t of [a.title, a.titleEnglish ?? ""]) {
        const n = normTitle(t);
        if (n && !byNorm.has(n)) byNorm.set(n, a);
      }
    }

    // respect removal tombstones — a synced title the viewer deleted stays gone
    const tombstoned = new Set(
      (await db.removedProgress.findMany({ where: { userId }, select: { malId: true } })).map((r) => r.malId),
    );
    // existing progress rows (never downgrade a newer local position)
    const candidateIds = [...new Set(history.map((h) => byNorm.get(normTitle(h.seriesTitle))?.malId ?? 0).filter(Boolean))];
    const existing = await db.watchProgress.findMany({
      where: { userId, malId: { in: candidateIds } },
      select: { malId: true, episode: true, position: true },
    });
    const existingMax = new Map<string, number>();
    for (const r of existing) {
      const k = `${r.malId}:${r.episode}`;
      existingMax.set(k, Math.max(existingMax.get(k) ?? 0, r.position));
    }

    // the User row must exist (foreign key)
    await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const matched: Array<{ malId: number; title: string; episode: number; position: number }> = [];
    const unmatched: Array<{ seriesTitle: string; episode: number }> = [];
    const seen = new Set<string>();

    for (const h of history) {
      const cr = playheads.get(h.mediaId ?? "");
      const position = cr?.playhead ?? 0;
      const episodeNum = h.episodeNumber ?? 0;
      const anime = byNorm.get(normTitle(h.seriesTitle));
      if (!anime) {
        if (!unmatched.some((u) => u.seriesTitle === h.seriesTitle)) unmatched.push({ seriesTitle: h.seriesTitle, episode: episodeNum });
        continue;
      }
      if (tombstoned.has(anime.malId)) continue;
      if (episodeNum < 1) continue; // special/unknown episode number — not resumable here
      const key = `${anime.malId}:${episodeNum}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (position < 5) continue; // junk position — nothing to resume
      if ((existingMax.get(key) ?? 0) >= position) continue; // local is already further
      // duration: Crunchyroll playhead vs OUR approximate episode length
      const duration = (anime.durationMin ?? 24) * 60;
      const completed = !!cr?.fullyWatched || position >= duration * 0.92;
      await db.watchProgress.upsert({
        where: { userId_malId_episode: { userId, malId: anime.malId, episode: episodeNum } },
        update: { position, duration, completed },
        create: {
          userId,
          malId: anime.malId,
          episode: episodeNum,
          position,
          duration,
          completed,
          lang: "sub",
          server: "zoko",
          title: anime.titleEnglish?.trim() || anime.title,
        },
      });
      matched.push({ malId: anime.malId, title: anime.titleEnglish?.trim() || anime.title, episode: episodeNum, position });
    }

    return NextResponse.json(
      { ok: true, imported: matched.length, matched, unmatched, message: matched.length ? undefined : "Nothing new to import." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof CrunchyrollAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Crunchyroll sync failed — try again in a moment." }, { status: 502 });
  }
}
