import { syncCatalog } from "../src/lib/sync";
import { prefetchSkipTimes } from "../src/lib/skip-times";
async function main() {
  const t0 = Date.now();
  const r = await syncCatalog(true);
  console.log(JSON.stringify({ ...r, newEpisodes: r.newEpisodes.length ? r.newEpisodes.slice(0, 12) : [], newEpisodeCount: r.newEpisodes.length, durationSec: Math.round((Date.now() - t0) / 1000) }, null, 1));
  if (r.newEpisodes.length) {
    console.log("prefetching skip times for", r.newEpisodes.length, "episodes...");
    await prefetchSkipTimes(r.newEpisodes, 20).catch((e) => console.log("skip prefetch failed:", String(e)));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("SYNC FAILED:", e); process.exit(1); });
