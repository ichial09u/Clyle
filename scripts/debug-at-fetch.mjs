/** Debug the anitrendz fetch+parse path used by top10-month.ts */
const AT_BASE = "https://www.anitrendz.com/charts/top-anime";
const AT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main() {
  try {
    const res = await fetch(AT_BASE, {
      headers: { "User-Agent": AT_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en" },
      signal: AbortSignal.timeout(15_000),
    });
    console.log("HTTP", res.status);
    const html = await res.text();
    console.log("html length:", html.length);
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
    console.log("NEXT_DATA match:", !!m);
    if (!m) {
      // dump candidate script tags
      const tags = [...html.matchAll(/<script[^>]*id="[^"]*"[^>]*>/gi)].slice(0, 5);
      console.log("script tags with id:", tags.map((t) => t[0]));
      const anyNext = html.indexOf("__NEXT_DATA__");
      console.log("raw __NEXT_DATA__ index:", anyNext);
      console.log("context:", anyNext >= 0 ? html.slice(anyNext - 120, anyNext + 120) : "n/a");
      return;
    }
    const data = JSON.parse(m[1]);
    const charts = data?.pageProps?.charts;
    console.log("charts:", Array.isArray(charts) ? charts.length : typeof charts);
    const chart = charts?.find((c) => c.slug === "top-anime") ?? charts?.[0];
    console.log("chart:", chart?.slug, chart?.season, "week", chart?.week, "choices:", chart?.choices?.length);
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : err);
  }
}
main();
