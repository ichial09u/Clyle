/**
 * One Piece (malId=21) sub skip-intro data audit — which tier serves each
 * episode, and how the intervals are distributed (late-shift diagnosis for
 * the "button appears too late / skips too far" user report).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MAL = 21;

const main = async () => {
  const total = await db.episode.count({ where: { animeId: MAL, lang: "sub" } });
  console.log("OP sub episodes in DB:", total);

  const scout = await db.$queryRawUnsafe(
    "SELECT ep, start, end, nodetect, updatedAt FROM IntroScout WHERE malId=? ORDER BY CAST(ep AS INTEGER)", MAL,
  );
  console.log("\nIntroScout rows for malId 21:", scout.length);
  const nd = scout.filter((r) => r.nodetect).length;
  console.log("  nodetect rows:", nd, "| measured rows:", scout.length - nd);
  if (scout.length) {
    const measured = scout.filter((r) => !r.nodetect);
    const st = measured.map((r) => r.start).sort((a, b) => a - b);
    const en = measured.map((r) => r.end).sort((a, b) => a - b);
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    console.log("  measured start median:", med(st), "p10:", st[Math.floor(st.length*0.1)], "p90:", st[Math.floor(st.length*0.9)]);
    console.log("  measured end   median:", med(en), "p10:", en[Math.floor(en.length*0.1)], "p90:", en[Math.floor(en.length*0.9)]);
    console.log("  sample rows:", JSON.stringify(scout.slice(0, 8)));
    const maxEp = scout.reduce((m, r) => Math.max(m, parseInt(r.ep) || 0), 0);
    console.log("  max scout ep:", maxEp);
  }

  const skipdb = await db.$queryRawUnsafe("SELECT COUNT(*) c FROM SkipDbFill WHERE malId=?", MAL);
  console.log("\nSkipDbFill rows for malId 21:", skipdb[0].c);
  const skipdbTitles = await db.$queryRowUnsafe?.() ;
  const t = await db.$queryRawUnsafe("SELECT COUNT(*) c FROM SkipDbTitle WHERE malId=?", MAL).catch(() => [{ c: "n/a" }]);
  console.log("SkipDbTitle rows for malId 21:", t[0].c);

  // what does the vendored AniSkip dataset carry for 21?
  const fs = await import("node:fs");
  const dataset = JSON.parse(fs.readFileSync("src/lib/skip-times.data.json", "utf8"));
  const byEp = dataset["21"];
  if (byEp) {
    const eps = Object.keys(byEp);
    const withOp = eps.filter((e) => byEp[e].op);
    const starts = withOp.map((e) => byEp[e].op[0]).sort((a, b) => a - b);
    const ends = withOp.map((e) => byEp[e].op[1]).sort((a, b) => a - b);
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
    console.log("\nAniSkip vendored dataset malId 21: episodes", eps.length, "| with op:", withOp.length);
    console.log("  op start median:", med(starts), "min:", starts[0], "max:", starts[starts.length-1]);
    console.log("  op end   median:", med(ends), "min:", ends[0], "max:", ends[ends.length-1]);
    console.log("  sample:", JSON.stringify(Object.fromEntries(eps.slice(0, 6).map((e) => [e, byEp[e].op ?? byEp[e]]))));
  } else {
    console.log("\nAniSkip vendored dataset malId 21: NO ENTRY");
  }

  // live API sample — what the player ACTUALLY receives (source field)
  console.log("\n--- live /api/stream samples (sub) ---");
  const base = process.env.BASE_URL || "http://localhost:3000";
  for (const ep of [1, 100, 300, 500, 588, 800, 1100]) {
    try {
      const r = await fetch(`${base}/api/stream?malId=${MAL}&ep=${ep}&lang=sub`, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) { console.log(`ep ${ep}: HTTP ${r.status}`); continue; }
      const j = await r.json();
      console.log(`ep ${ep}: skip=${JSON.stringify(j.skip)}`);
    } catch (e) {
      console.log(`ep ${ep}: fetch failed (${e.message?.slice(0, 60)})`);
    }
  }
};

main().finally(() => db.$disconnect());
