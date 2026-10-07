/**
 * TSA CRON PATROL — the immortal slice of the Timestamp Scout Army.
 *
 * The sandbox (local box) reaps long-lived processes and OOM-kills servers,
 * so the 1,000-bot campaign can't rely on a local daemon alone. This route is
 * wired into vercel.json crons (every 5 minutes): each invocation is ONE bot
 * patrol — pick the highest-popularity show episode that has NO measured
 * opening yet, measure it the One Piece way (watch our own sub encode,
 * envelope cross-match against the next episode), and store the finding.
 * Lambdas can't be reaped — the campaign always advances.
 *
 * The local fleet (scripts/timestamp-army-1000.mjs) is the fast lane when the
 * box cooperates; this cron is the guaranteed floor (~288 patrols/day).
 *
 * GET (also via cron) -> { ok, job?, verdict?, stored?, reason? }
 */
import { NextResponse } from "next/server";
import { analyzePlaylist, matchEnvelope, plausibleInterval } from "@/lib/intro-detect";
import { resolveStream } from "@/lib/zoko-stream";
import { db } from "@/lib/db";
import skipDataset from "@/lib/skip-times.data.json";
import type { ServerId } from "@/lib/zoko";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_QUALITY = 0.72;
const QUEUE_TTL_MS = 15 * 60_000;
const SCAN_SHOWS = 600; // popularity window per rebuild

type Job = { malId: number; ep: number; partnerEp: number; title: string };

const g = globalThis as unknown as { tsaQueue?: { jobs: Job[]; at: number }; tsaBusy?: boolean };

function loudestSpan(env: number[], spanSec = 70) {
  const span = Math.floor(spanSec / 0.5);
  if (env.length <= span) return env.length ? { start: 0, end: env.length * 0.5 } : null;
  let bestI = 0, bestSum = -1, sum = 0;
  for (let i = 0; i < env.length; i++) {
    sum += env[i];
    if (i >= span) sum -= env[i - span];
    if (i >= span - 1 && sum > bestSum) { bestSum = sum; bestI = i - span + 1; }
  }
  return { start: bestI * 0.5, end: (bestI + span) * 0.5 };
}

async function buildQueue(): Promise<Job[]> {
  const animes = await db.anime.findMany({
    where: { inCatalog: true, NOT: { type: "Movie" }, malId: { not: 21 } },
    select: { malId: true, title: true, popularity: true },
    orderBy: { popularity: "desc" },
    take: SCAN_SHOWS,
  });
  const malIds = animes.map((a) => a.malId);
  const eps = await db.episode.findMany({
    where: { animeId: { in: malIds } },
    select: { animeId: true, number: true },
    orderBy: { number: "asc" },
  });
  const byShow = new Map<number, number[]>();
  for (const e of eps) {
    if (!byShow.has(e.animeId)) byShow.set(e.animeId, []);
    byShow.get(e.animeId)!.push(e.number);
  }
  const covered = new Set<string>();
  const [scouts, fills] = await Promise.all([
    db.introScout.findMany({ where: { malId: { in: malIds } }, select: { malId: true, ep: true } }),
    db.skipDbFill.findMany({ where: { malId: { in: malIds } }, select: { malId: true, ep: true } }),
  ]);
  for (const s of scouts) covered.add(`${s.malId}/${s.ep}`);
  for (const f of fills) covered.add(`${f.malId}/${f.ep}`);
  const ds = skipDataset as Record<string, Record<string, { op?: number[] }>>;
  for (const malId of malIds) {
    const per = ds[String(malId)];
    if (!per) continue;
    for (const ep of Object.keys(per)) covered.add(`${malId}/${Number(ep)}`);
  }
  const jobs: Job[] = [];
  for (const a of animes) {
    const list = byShow.get(a.malId) ?? [];
    for (let i = 0; i < list.length; i++) {
      if (covered.has(`${a.malId}/${list[i]}`)) continue;
      const partner = i + 1 < list.length ? list[i + 1] : i > 0 ? list[i - 1] : null;
      if (partner == null) continue;
      jobs.push({ malId: a.malId, ep: list[i], partnerEp: partner, title: a.title });
    }
  }
  return jobs;
}

async function takeJob(): Promise<Job | null> {
  const now = Date.now();
  if (!g.tsaQueue || now - g.tsaQueue.at > QUEUE_TTL_MS) {
    g.tsaQueue = { jobs: await buildQueue(), at: now };
  }
  return g.tsaQueue?.jobs.shift() ?? null;
}

export async function GET() {
  if (g.tsaBusy) return NextResponse.json({ ok: true, reason: "patrol already running" });
  g.tsaBusy = true;
  try {
    const job = await takeJob();
    if (!job) return NextResponse.json({ ok: true, reason: "queue empty (or exhausted until rebuild)" });

    // resolve our own sub encodes (same resolver the player uses)
    const A = await resolveStream(job.malId, job.ep, "sub", "zoko" as ServerId).catch(() => null);
    if (!A?.src) {
      if (A === null) { g.tsaQueue?.jobs.push(job); return NextResponse.json({ ok: true, job: { ...job }, verdict: "deferred", reason: "resolve transient" }); }
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "resolve-fail", reason: "no sub stream (provider 404)" });
    }
    const encA = await analyzePlaylist(A.src, { log: () => {}, maxSec: 240, minSec: 120 });
    if (encA.status !== "ok") {
      g.tsaQueue?.jobs.push(job); // starve — retry on a later patrol
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "starved", detail: encA.detail });
    }
    const B = await resolveStream(job.malId, job.partnerEp, "sub", "zoko" as ServerId).catch(() => null);
    if (!B?.src) {
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "partner-unresolvable" });
    }
    const encB = await analyzePlaylist(B.src, { log: () => {}, maxSec: 240, minSec: 120 });
    if (encB.status !== "ok") {
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "partner-starved", detail: encB.detail });
    }

    // envelope cross-match (consecutive episodes share the OP)
    const anchorsA: Array<{ start: number; end: number }> = [...(encA.wall ? [encA.wall] : []), loudestSpan(encA.env)].filter((x): x is { start: number; end: number } => !!x);
    const anchorsB: Array<{ start: number; end: number }> = [...(encB.wall ? [encB.wall] : []), loudestSpan(encB.env)].filter((x): x is { start: number; end: number } => !!x);
    let mA: { start: number; end: number; quality: number } | null = null;
    let mB: { start: number; end: number; quality: number } | null = null;
    for (const a of anchorsA) {
      const t = matchEnvelope(encB.env, encA.env, a);
      if (t) { mB = t; mA = matchEnvelope(encA.env, encB.env, t); if (mA) break; mB = null; }
    }
    if (!mA || !mB) {
      for (const b of anchorsB) {
        const t = matchEnvelope(encA.env, encB.env, b);
        if (t) { mA = t; mB = matchEnvelope(encB.env, encA.env, t); if (mB) break; mA = null; }
      }
    }
    if (!mA || !mB) return NextResponse.json({ ok: true, job: { ...job }, verdict: "no-alignment" });
    if (!plausibleInterval(mA.start, mA.end) || !plausibleInterval(mB.start, mB.end)) {
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "implausible" });
    }
    if (Math.min(mA.quality, mB.quality) < MIN_QUALITY) {
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "low-quality", quality: +Math.min(mA.quality, mB.quality).toFixed(2) });
    }
    if (mA.end - mA.start < 30 || mA.end - mA.start > 180) {
      return NextResponse.json({ ok: true, job: { ...job }, verdict: "not-op-shaped" });
    }

    // persist BOTH episodes (mirrors /api/bots/intro-scout POST "ok" branch)
    let stored = 0;
    for (const [ep, m] of [[job.ep, mA], [job.partnerEp, mB]] as const) {
      const prev = await db.introScout.findUnique({ where: { malId_ep: { malId: job.malId, ep } } });
      const detail = `tsa-cron patrol ${job.ep}+${job.partnerEp} (measured on our sub encode) — ${job.title}`;
      if (prev) {
        const agree = Math.abs(prev.start - m.start) < 3 && Math.abs(prev.end - m.end) < 3;
        await db.introScout.update({
          where: { id: prev.id },
          data: { start: m.start, end: m.end, quality: m.quality, bots: agree ? Math.min(99, prev.bots + 1) : 1, nodetect: false, detail },
        });
      } else {
        await db.introScout.create({ data: { malId: job.malId, ep, start: m.start, end: m.end, quality: m.quality, detail } });
      }
      await db.scoutFinding.create({
        data: { bot: "tsa-cron", malId: job.malId, ep, title: job.title, status: "ok", start: m.start, end: m.end, quality: m.quality, detail },
      });
      stored++;
    }
    return NextResponse.json({
      ok: true, job: { malId: job.malId, ep: job.ep, partnerEp: job.partnerEp, title: job.title },
      verdict: "PASS", stored,
      A: { start: +mA.start.toFixed(1), end: +mA.end.toFixed(1), q: +mA.quality.toFixed(2) },
      B: { start: +mB.start.toFixed(1), end: +mB.end.toFixed(1), q: +mB.quality.toFixed(2) },
      queueLeft: g.tsaQueue?.jobs.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
  } finally {
    g.tsaBusy = false;
  }
}
