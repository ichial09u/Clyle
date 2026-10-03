// One-off probe: how deep does Anime Trending's top-anime chart actually go?
const res = await fetch("https://www.anitrendz.com/charts/top-anime", {
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", Accept: "text/html" },
  signal: AbortSignal.timeout(15000),
});
const html = await res.text();
const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
if (!m) { console.log("NO __NEXT_DATA__"); process.exit(1); }
const data = JSON.parse(m[1]);
const pp = data.props?.pageProps ?? data.pageProps;
const chart = pp?.charts?.find((c) => c.slug === "top-anime") ?? pp?.charts?.[0];
console.log("chart name:", chart?.name, "| season:", chart?.season, "| week:", chart?.week);
console.log("choices:", chart?.choices?.length);
const ranked = (chart?.choices ?? []).filter((c) => (c.name ?? "").trim() && !c.unranked);
console.log("ranked titles:", ranked.length);
console.log("first 3:", ranked.slice(0, 3).map((c) => `${c.position}. ${c.name}`));
console.log("last 3:", ranked.slice(-3).map((c) => `${c.position}. ${c.name}`));
