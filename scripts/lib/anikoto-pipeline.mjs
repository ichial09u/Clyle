/**
 * AniKoto discovery pipeline: title -> anikoto search -> watch page series id
 * -> anikotoapi episodes (embed ids) -> dub embed availability.
 * This is how we find which anime HAVE dub on the megaplay/supaplay embed
 * network (per-episode embed ids), beyond flikhub's malId-keyed API.
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
  // the site's own form uses `+` for spaces; %20 returns an unrelated feed
  const html = await curl(`https://anikototv.to/search?keyword=${keyword.replace(/ /g, "+")}`);
  const seen = new Set();
  const out = [];
  const re = /\/watch\/([a-zA-Z0-9-]+?)\s*"/g;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (!seen.has(slug)) { seen.add(slug); out.push(slug); }
  }
  return out;
}

export async function anikotoSeriesId(slug) {
  const html = await curl(`https://anikototv.to/watch/${encodeURIComponent(slug)}/ep-1`, ["-H", `Referer: https://anikototv.to/`]);
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

// CLI: node anikoto-pipeline.mjs "jujutsu kaisen 2nd season"
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv.slice(2).join(" ") || "jujutsu kaisen 2nd season";
  console.log(`searching anikoto: ${kw}`);
  const slugs = await anikotoSearch(kw);
  console.log("slugs:", slugs.slice(0, 10));
  const target = slugs.find((s) => s.includes("2nd-season")) ?? slugs[0];
  if (!target) { console.log("no result"); process.exit(0); }
  console.log("target slug:", target);
  const sid = await anikotoSeriesId(target);
  console.log("series id:", sid);
  if (!sid) process.exit(0);
  const { anime, eps } = await anikotoEpisodes(sid);
  console.log("anime:", JSON.stringify({ title: anime.title, native: anime.native, episodes: anime.episodes }));
  console.log("eps with dub embed:", eps.filter((e) => e.embedId || e.dubUrl).length, "/", eps.length);
  for (const e of eps.slice(0, 4)) console.log(`  ep${e.number}: embedId=${e.embedId} dub=${(e.dubUrl ?? "").slice(0, 80)}`);
}
