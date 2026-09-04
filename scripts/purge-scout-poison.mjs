/**
 * Purge garbage IntroScout rows — establish pair failures and stream
 * unavailability were once stored as button-suppressing "nodetect" verdicts.
 * They are MEASUREMENT failures, not evidence an opening is absent, so every
 * such row is poison: dropped by the deploy merge (see merge-comments.mjs)
 * and deleted here as a deploy-time guard so the uploaded db stays clean.
 * Run with: node scripts/purge-scout-poison.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const a = await db.introScout.deleteMany({ where: { detail: { contains: "establish pair failed" } } });
const b = await db.introScout.deleteMany({ where: { detail: { contains: "stream unavailable" } } });
// any row claiming a zero/inverted interval is broken by definition
const rows = await db.introScout.findMany({ where: { nodetect: true }, select: { id: true, start: true, end: true } });
const broken = rows.filter((r) => r.end <= r.start);
for (const r of broken) await db.introScout.delete({ where: { id: r.id } }).catch(() => undefined);

console.log(`scout poison purged: ${a.count} establish-failure + ${b.count} stream-unavailable + ${broken.length} degenerate nodetect rows`);
await db.$disconnect();
