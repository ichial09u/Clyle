import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Intro-scout fleet API — the server half of the 24/7 bot fleet that makes
 * the Skip Intro button accurate.
 *
 * The bots watch the first minutes of every catalog episode (the real
 * streams, same playlists the player serves) and cross-match loudness
 * envelopes across episodes: the opening is the one part of a show that
 * repeats identically, so where two episodes align IS the opening. Findings
 * land in IntroScout (per-episode intervals) + ScoutRef (per-anime
 * reference fingerprint), and the stream API serves them ahead of the
 * vendored AniSkip dataset because they are measured on OUR encodes.
 *
 *   GET  ?token=T&limit=N  -> the work backlog:
 *        { kind: "establish", malId, title, epA, epB }   no reference yet —
 *              watch two episodes and found the anime's reference
 *        { kind: "verify", malId, title, ep, ref }       reference exists —
 *              watch one episode and match it against the reference
 *   POST ?token=T          -> report findings + new references:
 *        { bot, findings: [{ malId, ep, status, start?, end?, quality?, detail? }],
 *          refs?: [{ malId, start, end, env }] }
 *
 * Auth: shared fleet token (the fleet runs on the owner's machine; the
 * token keeps random visitors from poisoning the dataset).
 */
const TOKEN = process.env.SCOUT_TOKEN ?? "clyle-scout-v1";

const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // nodetect re-try window
const ESTABLISH_NEG_TTL_MS = 8 * 60 * 60 * 1000; // failed pairs rotate fast
const REVERIFY_MS = 30 * 24 * 60 * 60 * 1000; // re-verify measured rows monthly
const FINDING_KEEP = 500; // the report feed is capped (ephemeral telemetry)

type BacklogItem =
  | { kind: "establish"; malId: number; title: string; epA: number; epB: number }
  | {
      kind: "verify";
      malId: number;
      title: string;
      ep: number;
      ref: { start: number; end: number; env: number[] };
    };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("token") !== TOKEN) return NextResponse.json({ error: "bad token" }, { status: 401 });
  const limit = Math.min(1200, Math.max(1, parseInt(sp.get("limit") ?? "800", 10) || 800));

  try {
    const [animes, refs, covered, recent] = await Promise.all([
      db.anime.findMany({
        where: { inCatalog: true },
        select: { malId: true, title: true, popularity: true },
        orderBy: { popularity: "asc" },
      }),
      db.scoutRef.findMany({ select: { malId: true, start: true, end: true, env: true } }),
      db.introScout.findMany({ select: { malId: true, ep: true, updatedAt: true } }),
      db.scoutFinding.findMany({
        where: { status: { in: ["nodetect", "error", "establish"] }, createdAt: { gte: new Date(Date.now() - ESTABLISH_NEG_TTL_MS) } },
        select: { malId: true, ep: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 4000,
      }),
    ]);

    const refByAnime = new Map(refs.map((r) => [r.malId, r]));
    const coveredSet = new Set(covered.filter((c) => Date.now() - c.updatedAt.getTime() < REVERIFY_MS).map((c) => `${c.malId}/${c.ep}`));
    // recent negative results suppress a retry for the TTL window
    const negUntil = new Map<string, number>();
    for (const f of recent) {
      const key = `${f.malId}/${f.ep}`;
      const ttl = f.status === "establish" ? ESTABLISH_NEG_TTL_MS : NEGATIVE_TTL_MS;
      const until = f.createdAt.getTime() + ttl;
      if (!negUntil.has(key) || negUntil.get(key)! < until) negUntil.set(key, until);
    }

    // episodes per anime (sub only — the fleet measures the shared video)
    const epsByAnime = new Map<number, number[]>();
    const episodes = await db.episode.findMany({
      where: { lang: "sub", animeId: { in: animes.map((a) => a.malId) } },
      select: { animeId: true, number: true },
      orderBy: { number: "asc" },
    });
    for (const e of episodes) {
      const list = epsByAnime.get(e.animeId) ?? [];
      list.push(e.number);
      epsByAnime.set(e.animeId, list);
    }

    const establish: BacklogItem[] = [];
    const verify: BacklogItem[] = [];
    for (const a of animes) {
      const eps = epsByAnime.get(a.malId) ?? [];
      if (!eps.length) continue;
      const ref = refByAnime.get(a.malId);
      if (!ref) {
        // pair establishment — pick the first two eps not in their negative
        // cache, so failed pairs rotate forward (1+2 -> 3+4 -> ...) instead
        // of stalling the anime for the whole TTL
        const fresh = eps.filter((ep) => Date.now() >= (negUntil.get(`${a.malId}/${ep}`) ?? 0));
        if (fresh.length < 2) continue;
        establish.push({ kind: "establish", malId: a.malId, title: a.title, epA: fresh[0], epB: fresh[1] });
        continue;
      }
      for (const ep of eps) {
        const key = `${a.malId}/${ep}`;
        if (coveredSet.has(key)) continue;
        if (Date.now() < (negUntil.get(key) ?? 0)) continue;
        verify.push({
          kind: "verify",
          malId: a.malId,
          title: a.title,
          ep,
          ref: { start: ref.start, end: ref.end, env: JSON.parse(ref.env) as number[] },
        });
      }
    }

    const backlog = [...establish, ...verify];

    return NextResponse.json(
      {
        ok: true,
        totals: {
          animes: animes.length,
          refs: refs.length,
          measured: covered.length,
          establish: establish.length,
          verify: verify.length,
        },
        backlog: backlog.slice(0, limit),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("token") !== TOKEN) return NextResponse.json({ error: "bad token" }, { status: 401 });
  let body: {
    bot?: string;
    findings?: Array<{ malId: number; ep: number; status: string; start?: number; end?: number; quality?: number; detail?: string }>;
    refs?: Array<{ malId: number; start: number; end: number; env: number[] }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const bot = (body.bot ?? "scout").slice(0, 32);
  let accepted = 0, refs = 0, rejected = 0;

  try {
    for (const f of body.findings ?? []) {
      if (!Number.isFinite(f.malId) || !Number.isFinite(f.ep) || f.ep < 1) { rejected++; continue; }
      const anime = await db.anime.findUnique({ where: { malId: f.malId }, select: { title: true } });
      const title = anime?.title ?? String(f.malId);
      await db.scoutFinding.create({
        data: {
          bot,
          malId: f.malId,
          ep: f.ep,
          title,
          status: ["ok", "nodetect", "error", "establish"].includes(f.status) ? f.status : "error",
          start: Number.isFinite(f.start) ? f.start : null,
          end: Number.isFinite(f.end) ? f.end : null,
          quality: Number.isFinite(f.quality) ? f.quality : null,
          detail: f.detail ? String(f.detail).slice(0, 300) : null,
        },
      });

      if (f.status === "ok" && Number.isFinite(f.start) && Number.isFinite(f.end) && f.end! > f.start!) {
        const prev = await db.introScout.findUnique({ where: { malId_ep: { malId: f.malId, ep: f.ep } } });
        if (prev) {
          // re-detection: same interval -> more agreement (bots++), else replace
          const agree = Math.abs(prev.start - f.start!) < 3 && Math.abs(prev.end - f.end!) < 3;
          await db.introScout.update({
            where: { id: prev.id },
            data: {
              start: f.start!,
              end: f.end!,
              quality: Number.isFinite(f.quality) ? f.quality : prev.quality,
              bots: agree ? Math.min(99, prev.bots + 1) : 1,
              detail: f.detail ? String(f.detail).slice(0, 300) : prev.detail,
            },
          });
        } else {
          await db.introScout.create({
            data: {
              malId: f.malId,
              ep: f.ep,
              start: f.start!,
              end: f.end!,
              quality: Number.isFinite(f.quality) ? f.quality : 0,
              detail: f.detail ? String(f.detail).slice(0, 300) : null,
            },
          });
        }
        accepted++;
      } else {
        rejected++;
      }
    }

    for (const r of body.refs ?? []) {
      if (!Number.isFinite(r.malId) || !Array.isArray(r.env) || !r.env.length) continue;
      if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start) continue;
      const env = r.env.slice(0, 1200).map((v) => Math.round(v * 1000) / 1000);
      await db.scoutRef.upsert({
        where: { malId: r.malId },
        update: { start: r.start, end: r.end, env: JSON.stringify(env) },
        create: { malId: r.malId, start: r.start, end: r.end, env: JSON.stringify(env) },
      });
      refs++;
    }

    // keep the feed bounded
    const count = await db.scoutFinding.count();
    if (count > FINDING_KEEP) {
      const old = await db.scoutFinding.findMany({
        orderBy: [{ id: "desc" }],
        skip: FINDING_KEEP,
        take: count - FINDING_KEEP,
        select: { id: true },
      });
      if (old.length) await db.scoutFinding.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    }

    return NextResponse.json({ ok: true, accepted, refs, rejected, bot }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
  }
}
