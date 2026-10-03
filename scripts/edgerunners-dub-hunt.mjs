/**
 * CYBERPUNK: EDGERUNNERS (malId 42310) — hunt ep 8 (and the series) across
 * the 4 players: Zoko, Megaplay (flikhub API + buzz mal-keyed page), AniKoto
 * embed network, SupaPlay (mapping discovery is separate — no search API).
 *
 * User: "We need dub for cyberpunk Edgerunners" +
 *       "see if u can find it on the 4 players we have available for the episode 8"
 *
 * The buzz mal-keyed page path (megaplay.buzz/stream/mal/{id}/{ep}/dub ->
 * data-id -> getSources) is the Dandadan discovery — it carries dubs the
 * flikhub mal-keyed API answers with ad-stubs. It has NEVER been tried for
 * 42310 (dub-hunt only probed the AniKoto embed network: no-dub x2).
 *
 *   node scripts/edgerunners-dub-hunt.mjs
 */
import { execFile } from "node:child_process";

const MALID = 42310;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url, extra = [], timeout = 25) {
  return new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", String(timeout), "-L", "-A", UA, "-w", "\n__STATUS__%{http_code}", ...extra, url],
      { maxBuffer: 64 * 1024 * 1024, timeout: (timeout + 5) * 1000 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ status: 0, body: "" });
        const m = stdout.match(/\n__STATUS__(\d+)\s*$/);
        resolve({ status: m ? parseInt(m[1], 10) : 0, body: m ? stdout.replace(/\n__STATUS__\d+\s*$/, "") : stdout });
      });
  });
}
const hdr = (h) => ["-H", h];

/* ---- real-segment verification (same rule as megaplay.ts fake-dub detector) */
async function verifyPlaylist(m3u8Url, referer, label) {
  const first = await curl(m3u8Url, hdr(`Referer: ${referer}`));
  if (first.status !== 200) return { ok: false, why: `master ${first.status}`, segs: 0 };
  const lines = first.body.split("\n").map((s) => s.trim());
  const variant = lines.find((l) => l && !l.startsWith("#"));
  let playlist = first.body;
  let playlistUrl = m3u8Url;
  if (variant) {
    playlistUrl = new URL(variant, m3u8Url).href;
    const vres = await curl(playlistUrl, hdr(`Referer: ${referer}`));
    if (vres.status !== 200) return { ok: false, why: `variant ${vres.status}`, segs: 0 };
    playlist = vres.body;
  }
  const segs = playlist.split("\n").filter((l) => {
    const s = l.trim();
    return s && !s.startsWith("#") && /seg-\d+-|\.ts|\.mp4/.test(s) && !/tiktokcdn\.com|adimage|advert/i.test(s);
  });
  if (segs.length < 3) return { ok: false, why: `only ${segs.length} real segments (ad-stub)`, segs: segs.length };
  // fetch a middle segment — prove REAL bytes
  const mid = segs[Math.floor(segs.length / 2)];
  const surl = new URL(mid, playlistUrl).href;
  const sres = await curl(surl, ["-o", "/tmp/edg-seg.bin", hdr(`Referer: ${referer}`), "-r", "0..200000"]);
  await sleep(100);
  const { statSync } = await import("node:fs");
  let bytes = 0;
  try { bytes = statSync("/tmp/edg-seg.bin").size; } catch { /* missing */ }
  return { ok: sres.status === 200 && bytes > 50_000, why: `seg ${sres.status}, ${bytes}B`, segs: segs.length };
}

async function main() {
  console.log(`# EDGERUNNERS (42310) 4-player hunt — focus ep 8\n`);

  /* ---------- PLAYER 1: ZOKO ---------- */
  console.log("== PLAYER 1: Zoko ==");
  for (const ep of [8, 1]) {
    const page = await curl(`https://zokoanime.video/stream/mal/${MALID}/${ep}/dub`, hdr("Referer: https://zokoanime.video/"));
    console.log(`  zoko dub ep${ep} page: HTTP ${page.status}, ${page.body.length}B`);
    if (page.status === 200 && page.body.length > 5000) {
      // look for player payload hints
      const hasPlayer = /data-id|player|iframe|m3u8|sources/i.test(page.body);
      console.log(`    player payload hints: ${hasPlayer}`);
      const m = page.body.match(/data-id="(\d+)"/);
      if (m) console.log(`    data-id: ${m[1]}`);
    }
    if (ep === 8) await sleep(500);
  }

  /* ---------- PLAYER 2: MEGAPLAY buzz mal-keyed (Dandadan path) ---------- */
  console.log("\n== PLAYER 2: Megaplay buzz mal-keyed page ==");
  for (const ep of [8, 1]) {
    const page = await curl(`https://megaplay.buzz/stream/mal/${MALID}/${ep}/dub`, hdr("Referer: https://megaplay.buzz/"));
    const m = page.body.match(/data-id="(\d+)"/);
    console.log(`  buzz dub ep${ep} page: HTTP ${page.status}, data-id=${m ? m[1] : "none"}`);
    if (m) {
      const src = await curl(`https://megaplay.buzz/stream/getSources?id=${m[1]}&type=dub`, hdr("Referer: https://megaplay.buzz/"));
      try {
        const j = JSON.parse(src.body);
        const url = j?.source || j?.sources?.[0]?.file || j?.player?.source || null;
        const srcStr = JSON.stringify(j).slice(0, 300);
        console.log(`    getSources: HTTP ${src.status} -> ${url ? url.slice(0, 120) : "no url"}`);
        if (!url) console.log(`    body: ${srcStr}`);
        if (url && /\.m3u8/.test(url)) {
          const v = await verifyPlaylist(url, "https://megaplay.buzz/", `buzz-ep${ep}`);
          console.log(`    VERIFY: ${v.ok ? "REAL DUB ✔" : "fake/miss ✘"} (${v.why}, ${v.segs} segs)`);
        } else if (url) {
          console.log(`    non-m3u8 source: ${url.slice(0, 160)}`);
        }
      } catch (e) {
        console.log(`    getSources parse fail: HTTP ${src.status}, ${src.body.slice(0, 150)}`);
      }
    }
    await sleep(800);
  }

  /* ---------- PLAYER 2b: flikhub mal-keyed API ---------- */
  console.log("\n== PLAYER 2b: flikhub mal-keyed API ==");
  for (const ep of [8, 1]) {
    const r = await curl(`https://api.flikhub.net/megaplay?mal=${MALID}&ep=${ep}&type=dub`, hdr("Referer: https://megaplay.buzz/"));
    let summary = r.body.slice(0, 200);
    try {
      const j = JSON.parse(r.body);
      const u = j?.source || j?.url || j?.sources?.[0]?.file || j?.stream || null;
      summary = u ? `url=${String(u).slice(0, 120)}` : JSON.stringify(j).slice(0, 200);
      if (u && /\.m3u8/.test(String(u))) {
        const v = await verifyPlaylist(String(u), "https://megaplay.buzz/", `flikhub-ep${ep}`);
        console.log(`  flikhub dub ep${ep}: HTTP ${r.status}, ${summary} -> ${v.ok ? "REAL ✔" : "fake ✘"} (${v.why})`);
        continue;
      }
    } catch { /* raw */ }
    console.log(`  flikhub dub ep${ep}: HTTP ${r.status}, ${summary}`);
    await sleep(600);
  }

  /* ---------- PLAYER 3: ANIKOTO embed network ---------- */
  console.log("\n== PLAYER 3: AniKoto embed network (series 5789) ==");
  const ser = await curl("https://anikotoapi.site/series/5789", hdr("Referer: https://anikototv.to/"));
  try {
    const j = JSON.parse(ser.body);
    const eps = j?.data?.episodes || j?.data?.episodesList || j?.episodes || [];
    const ep8 = (Array.isArray(eps) ? eps : []).find((e) => Number(e.number ?? e.ep) === 8);
    const embed = ep8 ? (ep8.embedId ?? ep8.id ?? null) : null;
    console.log(`  series API: HTTP ${ser.status}, eps=${Array.isArray(eps) ? eps.length : "?"}, ep8 embed=${embed}`);
    if (embed) {
      const src = await curl(`https://megaplay.buzz/stream/getSources?id=${embed}&type=dub`, hdr("Referer: https://megaplay.buzz/"));
      try {
        const sj = JSON.parse(src.body);
        const u = sj?.source || sj?.sources?.[0]?.file || null;
        console.log(`  ep8 getSources(dub): HTTP ${src.status} -> ${u ? String(u).slice(0, 120) : "none"}`);
        if (u && /\.m3u8/.test(String(u))) {
          const v = await verifyPlaylist(String(u), "https://megaplay.buzz/", "koto-ep8");
          console.log(`  VERIFY: ${v.ok ? "REAL DUB ✔" : "fake/miss ✘"} (${v.why}, ${v.segs} segs)`);
        }
      } catch { console.log(`  getSources unparsable: ${src.body.slice(0, 120)}`); }
    }
  } catch {
    console.log(`  series API parse fail: HTTP ${ser.status}, ${ser.body.slice(0, 150)}`);
  }

  /* ---------- PLAYER 4: SUPAPLAY (mapping probe attempts) ---------- */
  console.log("\n== PLAYER 4: SupaPlay (no search API — guess common slugs) ==");
  for (const slug of ["cyberpunk-edgerunners-english", "cyberpunk-edgerunners"]) {
    const r = await curl(`https://h5-api.aoneroom.com/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(slug)}`, hdr("Referer: https://supaplay.fun/"));
    let hit = false;
    try {
      const j = JSON.parse(r.body);
      hit = !!j?.data?.subject?.subjectId;
      if (hit) console.log(`  HIT ${slug} -> subjectId ${j.data.subject.subjectId}`);
    } catch { /* not json */ }
    console.log(`  ${slug}: HTTP ${r.status}, ${hit ? "SUBJECT FOUND" : "no subject"}`);
    await sleep(400);
  }

  console.log("\n# hunt done");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
