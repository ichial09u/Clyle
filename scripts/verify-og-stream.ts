import { resolveStream } from "../src/lib/zoko-stream";
import { backfillEpisodeTitles } from "../src/lib/sync";
async function main() {
  const t = await backfillEpisodeTitles(64340).catch((e) => { console.log("backfill err:", String(e)); return -1; });
  console.log("title backfill filled:", t);
  const s = await resolveStream(64340, 1, "sub", "zoko");
  if (!s) { console.log("STREAM: null (zoko has nothing for 64340 ep1)"); return; }
  console.log("STREAM src:", s.src.slice(0, 90));
  console.log("subtitles:", s.subtitles.length);
  const res = await fetch(s.src, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" }, signal: AbortSignal.timeout(15000) });
  const text = await res.text().catch(() => "");
  console.log("playlist:", res.status, text.includes("#EXTM3U") ? "#EXTM3U ok" : "NO EXTM3U", "| variants:", text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", String(e)); process.exit(1); });
