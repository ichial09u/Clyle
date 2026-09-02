/**
 * Inspect Zoko HLS master playlists for sub vs dub:
 * lists #EXT-X-MEDIA audio groups + video renditions so we can see
 * whether a "dub" URL actually carries English audio.
 */
const ORIGIN = "https://zokoanime.video";
const KEY = "otaku-embed-v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++)
    out += String.fromCharCode(str.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length));
  return out;
}
function decode(blob) {
  return JSON.parse(decodeURIComponent(escape(xor(atob(blob)))));
}

async function payload(malId, ep, lang, server) {
  const url = `${ORIGIN}/stream/mal/${malId}/${ep}/${lang}${server === "kiwi" ? "?server=kiwi" : ""}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) return { error: "no __P" };
  const json = decode(m[1]);
  return { src: json.src, video_id: json.video_id };
}

async function inspect(malId, ep) {
  console.log(`\n########## malId ${malId} ep ${ep} ##########`);
  for (const lang of ["sub", "dub"]) {
    for (const server of ["zoko", "kiwi"]) {
      const p = await payload(malId, ep, lang, server);
      if (p.error) {
        console.log(`[${lang}/${server}] ERROR: ${p.error}`);
        continue;
      }
      let hls = "";
      try {
        const res = await fetch(p.src, {
          headers: { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/` },
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        });
        hls = res.ok ? await res.text() : `HTTP ${res.status}`;
      } catch (e) {
        hls = `FETCH FAIL ${e.message}`;
      }
      const audio = hls
        .split("\n")
        .filter((l) => l.startsWith("#EXT-X-MEDIA:TYPE=AUDIO"))
        .map((l) => l.match(/NAME="([^"]*)"/)?.[1] ?? l.slice(0, 60));
      const codecLines = hls
        .split("\n")
        .filter((l) => l.startsWith("#EXT-X-STREAM-INF"))
        .map((l) => (l.match(/CODECS="([^"]*)"/)?.[1] ?? "").slice(0, 70));
      console.log(
        `[${lang}/${server}] video_id=${p.video_id} audioGroups=${JSON.stringify(audio)} codecs=${JSON.stringify(codecLines)}`,
      );
      if (typeof hls === "string" && !hls.startsWith("#EXTM3U") && !hls.startsWith("HTTP") && !hls.startsWith("FETCH")) {
        console.log("   (non-m3u8 body:) " + hls.slice(0, 120));
      }
    }
  }
}

const targets = process.argv.slice(2);
const list = targets.length
  ? targets.map((t) => t.split(":").map(Number))
  : [[21, 1], [235, 1], [17637, 1]];
for (const [malId, ep] of list) await inspect(malId, ep);
