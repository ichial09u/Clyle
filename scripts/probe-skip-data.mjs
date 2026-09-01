/**
 * Probe /api/stream for several catalog anime and dump the resolved skip data
 * + its tier source — to diagnose "Skip Intro lands at the start/middle of
 * the OP on newer anime". Run against the dev server.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";

const newest = await db.anime.findMany({
  orderBy: [{ year: "desc" }, { malId: "asc" }],
  take: 6,
  select: { malId: true, title: true, year: true, durationMin: true },
});
const classics = await db.anime.findMany({
  where: { malId: { in: [21, 1, 5114] } },
  select: { malId: true, title: true, year: true, durationMin: true },
});
const picks = [...newest, ...classics];

for (const a of picks) {
  const res = await fetch(`${BASE}/api/stream?malId=${a.malId}&ep=1&lang=sub&server=zoko`).catch(() => null);
  if (!res || !res.ok) {
    console.log(`${a.malId} ${a.title} (${a.year ?? "?"}): stream FAIL ${res?.status ?? "no-res"}`);
    continue;
  }
  const data = await res.json();
  const s = data.skip;
  const fmt = (iv) => (iv ? `${iv.start.toFixed(1)}->${iv.end.toFixed(1)} (${Math.round(iv.end - iv.start)}s)` : "none");
  console.log(
    `${a.malId} ${String(a.title).slice(0, 34).padEnd(34)} yr=${a.year ?? "?"} dur=${a.durationMin ?? "?"}m src=${(s?.source ?? "none").padEnd(13)} intro=${fmt(s?.intro)} outro=${fmt(s?.outro)}`,
  );
}
