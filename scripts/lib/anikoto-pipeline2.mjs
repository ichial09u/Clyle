/**
 * AniKoto discovery pipeline (v2): title -> /filter search (data-tip series ids)
 * -> anikotoapi episodes (megaplay embed ids) -> dub embed availability.
 */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function curl(url, extra = []) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9", ...extra, url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
  });
}

export async function anikotoSearch(keyword) {
  const html = await curl(`https://anikototv.to/filter?keyword=${keyword.replace(/ /g, "+")}`);
  const out = [];
  const seen = new Set();
  // <div class="ani poster tip" data-tip="6688"> <a href="https://anikototv.to/watch/{slug}/ep-1"
  const re = /data-tip="(\d+)"[^>]*>\s*<a href="[^"]*\/watch\/([a-zA-Z0-9-]+)\/ep-\d+/g;
  let m;
  while ((m = re.exec(html))) {
    const id = parseInt(m[1], 10);
    if (!seen.has(id)) { seen.add(id); out.push({ id, slug: m[2] }); }
  }
  return out;
}

export async function anikotoSeriesId(slug) {
  const html = await curl(`https://anikototv.to/watch/${encodeURIComponent(slug)}/ep-1`, ["-H", "Referer: https://anikototv.to/"]);
  const m = html.match(/id="watch-main"\s+data-id="(\d+)"/) || html.match(/data-id="(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}

export async function anikotoEpisodes(seriesId) {
  const body = await curl(`https://anikotoapi.site/series/${seriesId}`);
  const j = JSON.parse(body);
  if (!j || j.ok !== true || !j.data) throw new Error("anikotoapi invalid");
  const anime = j.data.anime ?? {};
  const eps = (j.data.episodes ?? []).map((e) => ({
    number: Number(e.number ?? e.episode ?? 0),
    title: e.title ?? null,
    embedId: e.episode_embed_id ?? null,
    dubUrl: e?.embed_url?.dub ?? null,
    subUrl: e?.embed_url?.sub ?? null,
  }));
  return { anime, eps };
}

// CLI: node anikoto-pipeline2.mjs "jujutsu kaisen 2nd season"
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv.slice(2).join(" ") || "jujutsu kaisen 2nd season";
  console.log(`filter-search: ${kw}`);
  const hits = await anikotoSearch(kw);
  console.log("hits:", hits.slice(0, 8).map((h) => `${h.slug}#${h.id}`).join("\n  "));
  const target = hits.find((h) => h.slug.includes("2nd-season")) ?? hits[0];
  if (!target) { console.log("no result"); process.exit(0); }
  console.log("target:", target.slug, "id:", target.id);
  const { anime, eps } = await anikotoEpisodes(target.id);
  console.log("anime:", JSON.stringify({ title: anime.title, native: anime.native, episodes: anime.episodes }));
  const withEmbed = eps.filter((e) => e.embedId);
  console.log("eps with embed id:", withEmbed.length, "/", eps.length);
  for (const e of withEmbed.slice(0, 3)) console.log(`  ep${e.number}: ${e.embedId} dub=${(e.dubUrl ?? "").slice(0, 90)}`);
}
