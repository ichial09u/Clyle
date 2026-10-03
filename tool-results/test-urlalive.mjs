const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const url = "https://www.animegg.org/play/476769/video.mp4?for=101790996145562";
const referer = "https://www.animegg.org/embed/135315";
async function timed(name, fn) { const t = Date.now(); try { const r = await fn(); console.log(`${name}: ok=${r} in ${Date.now() - t}ms`); } catch (e) { console.log(`${name}: THROW ${String(e.message || e)} in ${Date.now() - t}ms`); } }
await timed("HEAD follow (exact urlAlive)", async () => {
  const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA, Accept: "*/*", Referer: referer }, redirect: "follow", signal: AbortSignal.timeout(6000) });
  return res.ok;
});
await timed("ranged GET follow", async () => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", Referer: referer, Range: "bytes=0-1880" }, redirect: "follow", signal: AbortSignal.timeout(6000) });
  return res.ok || res.status === 206;
});
await timed("GET NO-redirect (see first hop)", async () => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", Referer: referer }, redirect: "manual", signal: AbortSignal.timeout(6000) });
  console.log("  first hop status:", res.status, "location:", res.headers.get("location")?.slice(0, 90));
  return true;
});
