/**
 * Test scraping TMDB's public discover page (no API key needed):
 *   /discover/tv?with_genres=16&original_language=ja&sort_by=popularity.desc
 * = TMDB's popularity-ranked Japanese animation shows.
 * Extract rank-ordered TMDB ids + titles from the result cards.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

async function discoverPage(page) {
  const url = `https://www.themoviedb.org/discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=${page}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // result cards: <a href="/tv/37854-one-piece" ...> or div.card with data id
  const cards = [...html.matchAll(/\/tv\/(\d+)-([a-z0-9-]+)/gi)].map((m) => ({ id: Number(m[1]), slug: m[2] }));
  // dedupe preserving order
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return { count: out.length, items: out, htmlLen: html.length };
}

for (const p of [1, 2]) {
  try {
    const r = await discoverPage(p);
    console.log(`page ${p}: ${r.count} unique shows (html ${r.htmlLen})`);
    for (const it of r.items.slice(0, 25)) console.log(`  ${it.id}  ${it.slug}`);
  } catch (e) {
    console.log(`page ${p}: ERR ${e.message}`);
  }
}
