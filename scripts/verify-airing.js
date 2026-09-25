#!/usr/bin/env node
/* Verify /api/home carries next-episode air times (cards + hero countdown). */
const BASE = process.argv[2] || "http://localhost:3000";

fetch(`${BASE}/api/home`)
  .then((r) => r.json())
  .then((j) => {
    const op = j.hero?.[0];
    console.log("hero:", op?.title, "| nextEpisodeAt:", op?.nextEpisodeAt, "| nextEpisodeNum:", op?.nextEpisodeNum);
    if (op?.nextEpisodeAt) {
      const ms = op.nextEpisodeAt * 1000 - Date.now();
      console.log(`  airs in ${(ms / 86400000).toFixed(2)} days -> ${new Date(op.nextEpisodeAt * 1000).toISOString()}`);
    }
    let withAir = 0,
      total = 0;
    const sample = [];
    for (const s of j.sections ?? []) {
      for (const it of s.items ?? []) {
        total++;
        if (it.nextEpisodeAt) {
          withAir++;
          if (sample.length < 10) {
            const h = (it.nextEpisodeAt * 1000 - Date.now()) / 3600000;
            sample.push(`${it.title} · ep ${it.nextEpisodeNum} · ${h > 72 ? Math.round(h / 24) + "d" : h.toFixed(1) + "h"} away`);
          }
        }
      }
    }
    console.log(`cards with air time: ${withAir} / ${total}`);
    console.log(sample.slice(0, 10).join("\n"));
  })
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
