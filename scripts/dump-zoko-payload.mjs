/** Dump the FULL decoded __P payload for a stream page (all fields, not just src). */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

function xor(str) { let o = ""; for (let i = 0; i < str.length; i++) o += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length)); return o; }
function decode(b) { return JSON.parse(decodeURIComponent(escape(xor(atob(b))))); }

const [malId, lang, server] = process.argv.slice(2);
const url = server === "kiwi"
  ? `${ORIGIN}/stream/mal/${malId}/1/${lang || "sub"}?server=kiwi`
  : `${ORIGIN}/stream/mal/${malId}/1/${lang || "sub"}`;

const res = await fetch(url, { headers: HEADERS, cache: "no-store", redirect: "follow" });
console.log("HTTP", res.status, res.url);
const html = await res.text();
const m = html.match(/window\.__P="([^"]+)"/);
if (!m) { console.log("no __P. page length:", html.length); process.exit(0); }
const json = decode(m[1]);
console.log(JSON.stringify(json, null, 2).slice(0, 3000));
// look for server hints in raw html
const hints = html.match(/kiwi[^"']{0,80}/gi);
console.log("kiwi mentions in page:", hints ? hints.slice(0, 10) : "none");
