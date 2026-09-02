/** Validate TMDB keyword "anime" TV browse: ordering + coverage of known anime. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://www.themoviedb.org/keyword/210024-anime/tv?language=en-US";

async function page(p) {
  const res = await fetch(p === 1 ? BASE : `${BASE}&page=${p}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en", "X-Requested-With": "XMLHttpRequest", Referer: BASE },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // cards: href="/tv/{id}(-slug)?language=en-US" + <img alt="Title"
  const items = [];
  const re = /href="\/tv\/(\d+)(-[a-z0-9-]+)?\?language=en-US"[^>]*>[\s\S]{0,600}?<img[^>]+alt="([^"]*)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, slug: m[2] || "", title: m[3] });
  }
  if (items.length === 0) {
    // fallback: href + alt pairs anywhere
    const re2 = /href="\/tv\/(\d+)(-[a-z0-9-]+)?\?language=en-US"/g;
    while ((m = re2.exec(html))) {
      const id = Number(m[1]);
      if (!seen.has(id)) { seen.add(id); items.push({ id, slug: m[2] || "", title: "" }); }
    }
  }
  return items;
}

const KNOWN = { 37854: "One Piece", 139117: "Dan Da Dan", 209867: "Frieren", 95479: "JJK", 114410: "Blue Lock", 131251: "Sakamoto Days" };
const all = [];
for (let p = 1; p <= 5; p++) {
  try {
    const items = await page(p);
    console.log(`page ${p}: ${items.length} cards`);
    all.push(...items);
    if (items.length < 5) break;
  } catch (e) {
    console.log(`page ${p}: ERR ${e.message}`);
    break;
  }
}
console.log("\nFirst 30:");
all.slice(0, 30).forEach((it, i) => console.log(`${String(i + 1).padStart(3)} ${it.id} ${it.title || it.slug}`));
console.log("\nKnown-anime positions:");
for (const [id, name] of Object.entries(KNOWN)) {
  const idx = all.findIndex((a) => a.id === Number(id));
  console.log(`  ${name}: ${idx === -1 ? "NOT in top " + all.length : "#" + (idx + 1)}`);
}
