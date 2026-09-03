#!/usr/bin/env node
/**
 * Pull the intro-scout fleet data accumulated on PROD into the local db
 * (same spirit as the deploy carry-forward, runnable any time — protects
 * the bots' measurements from the serverless db's ephemeral lifecycle).
 *
 * Usage: node scripts/scout-sync.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const PROD = process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app";
const db = new PrismaClient();

const res = await fetch(`${PROD}/api/export`, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) { console.error(`export fetch failed: ${res.status}`); process.exit(1); }
const data = await res.json();
const file = "db/export-scout.tmp.json";
writeFileSync(file, JSON.stringify({ introScout: data.introScout ?? [], scoutRef: data.scoutRef ?? [] }));

let rows = 0, refs = 0;
for (const s of data.introScout ?? []) {
  const existing = await db.introScout.findUnique({ where: { malId_ep: { malId: s.malId, ep: s.ep } } });
  if (!existing) {
    await db.introScout.create({
      data: { malId: s.malId, ep: s.ep, start: s.start, end: s.end, quality: s.quality ?? 0, bots: s.bots ?? 1, server: s.server === "kiwi" ? "kiwi" : "zoko", detail: s.detail ?? null },
    }).catch(() => undefined);
  } else if ((s.bots ?? 1) > existing.bots) {
    await db.introScout.update({
      where: { id: existing.id },
      data: { start: s.start, end: s.end, quality: s.quality ?? existing.quality, bots: s.bots ?? existing.bots },
    }).catch(() => undefined);
  }
  rows++;
}
for (const r of data.scoutRef ?? []) {
  const existing = await db.scoutRef.findUnique({ where: { malId: r.malId } });
  if (!existing) {
    await db.scoutRef.create({ data: { malId: r.malId, start: r.start, end: r.end, env: r.env ?? "[]" } }).catch(() => undefined);
  }
  refs++;
}
try { unlinkSync(file); } catch { /* keep on failure */ }
console.log(`scout-sync: ${rows} measured rows + ${refs} refs pulled from prod into local db`);
process.exit(0);
