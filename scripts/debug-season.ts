import { seasonNow, seasonStillAiring } from "../src/lib/anilist";
async function main() {
  const cur = await seasonNow();
  const prev = await seasonStillAiring();
  console.log(`seasonNow: ${cur.length} items; seasonStillAiring: ${prev.length} items`);
  const interesting = [...cur, ...prev].filter((m) => m.idMal === 64340 || m.idMal === 53913 || m.idMal === 61990 || m.idMal === 63140);
  for (const m of interesting) {
    console.log(`idMal=${m.idMal} title=${m.title?.english ?? m.title?.romaji} format=${m.format} status=${m.status} isAdult=${m.isAdult} eps=${m.episodes} next=${m.nextAiringEpisode?.episode}`);
  }
  const counts = new Map<string, number>();
  for (const m of [...cur, ...prev]) counts.set(m.format ?? "?", (counts.get(m.format ?? "?") ?? 0) + 1);
  console.log("formats:", JSON.stringify([...counts.entries()]));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
