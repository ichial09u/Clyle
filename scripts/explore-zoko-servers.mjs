/** Explore Zoko's episode page structure to find the real Kiwi server. */
const ORIGIN = "https://zokoanime.video";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` };

// try likely episode/watch page URLs
const urls = [
  `${ORIGIN}/watch/mal/21/1`,
  `${ORIGIN}/watch/mal/21`,
  `${ORIGIN}/anime/mal/21`,
  `${ORIGIN}/mal/21`,
  `${ORIGIN}/stream/mal/21/1/sub`,
];

for (const url of urls) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const html = await res.text();
    console.log("\n===", url, "-> HTTP", res.status, "len", html.length, "final:", res.url);
    if (res.ok) {
      // find server-related markup
      const serverHints = html.match(/(kiwi|server)[^<>{}]{0,120}/gi);
      if (serverHints) console.log("hints:", [...new Set(serverHints)].slice(0, 20));
      // find iframes / embeds
      const iframes = html.match(/<iframe[^>]+src="([^"]+)"/gi);
      if (iframes) console.log("iframes:", iframes.slice(0, 5));
      // find links with 'kiwi'
      const links = html.match(/href="[^"]*kiwi[^"]*"/gi);
      if (links) console.log("kiwi links:", links.slice(0, 5));
    }
  } catch (e) {
    console.log("\n===", url, "-> ERR", e.message);
  }
}
