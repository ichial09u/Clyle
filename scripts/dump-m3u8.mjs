const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function xor(str) { let o=""; for (let i=0;i<str.length;i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(blob) { return JSON.parse(decodeURIComponent(escape(xor(atob(blob))))); }
async function payload(malId, ep, lang) {
  const url = `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  return m ? decode(m[1]) : null;
}
const [malId, ep] = [parseInt(process.argv[2]), parseInt(process.argv[3] || "1")];
for (const lang of ["sub", "dub"]) {
  const p = await payload(malId, ep, lang);
  if (!p) { console.log(`== ${lang}: no payload ==`); continue; }
  console.log(`\n===== ${lang} video_id=${p.video_id} =====`);
  console.log("MASTER:", p.src.slice(0, 110));
  const mres = await fetch(p.src, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20000) });
  const mtext = await mres.text();
  console.log(mtext.split("\n").slice(0, 14).join("\n"));
  // follow first variant
  const firstVar = mtext.split("\n").filter(l => l && !l.startsWith("#"))[0];
  if (firstVar) {
    const vurl = new URL(firstVar, p.src).href;
    const vres = await fetch(vurl, { headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(20000) });
    const vtext = await vres.text();
    console.log("--- first variant:", firstVar.slice(0, 80));
    console.log(vtext.split("\n").filter(l => l.startsWith("#")).slice(0, 8).join("\n"));
  }
}
