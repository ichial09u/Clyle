/**
 * Probe Zoko stream payloads for Fullmetal Alchemist: Brotherhood (5114).
 * Prints the RAW subtitle arrays for sub+dub / zoko+kiwi so we can see what
 * tracks exist and in what order (the app currently plays subtitles[0]).
 *
 * Usage: node scripts/probe-fma-subs.mjs [malId] [ep]
 */
const KEY = "otaku-embed-v1";
const ORIGIN = "https://zokoanime.video";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++)
    out += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length));
  return out;
}

function decode(blob) {
  try {
    return JSON.parse(decodeURIComponent(escape(xor(atob(blob)))));
  } catch (e) {
    return { __decodeError: String(e) };
  }
}

function pageUrl(malId, ep, lang, server) {
  return `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}${server === "kiwi" ? "?server=kiwi" : ""}`;
}

async function probe(malId, ep, lang, server) {
  const url = pageUrl(malId, ep, lang, server);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/`, Accept: "text/html" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`\n== ${lang}/${server}: HTTP ${res.status}`);
      return;
    }
    const html = await res.text();
    const m = html.match(/window\.__P="([^"]+)"/);
    if (!m) {
      console.log(`\n== ${lang}/${server}: no __P payload`);
      return;
    }
    const json = decode(m[1]);
    console.log(`\n== ${lang}/${server} ==`);
    console.log("  src:", (json.src || "").slice(0, 90));
    console.log("  video_id:", json.video_id);
    console.log("  skip:", JSON.stringify(json.skip));
    console.log("  subtitles:", JSON.stringify(json.subtitles, null, 2));
  } catch (e) {
    console.log(`\n== ${lang}/${server}: FETCH FAIL ${e.message}`);
  }
}

const malId = parseInt(process.argv[2] || "5114", 10);
const ep = parseInt(process.argv[3] || "1", 10);
console.log(`Probing malId=${malId} ep=${ep}`);
await probe(malId, ep, "sub", "zoko");
await probe(malId, ep, "dub", "zoko");
await probe(malId, ep, "sub", "kiwi");
await probe(malId, ep, "dub", "kiwi");
