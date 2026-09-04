/**
 * Map supaplay multi-season subjects: for a given detailPath, list every
 * season (se) with its maxEp, then probe episode coverage per season
 * (which eps actually return streams = which eps have dub).
 */
import { execFile } from "node:child_process";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** curl-transport JSON GET — Cloudflare 403s undici's TLS fingerprint (same as src/lib/supaplay.ts). */
function curlJson(url, referer) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "-H", `Referer: ${referer}`, "-H", "Accept: application/json", url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 25000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
  });
}

export async function aoneroomDetail(detailPath) {
  const body = await curlJson(`https://h5-api.aoneroom.com/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`, "https://h5-api.aoneroom.com/");
  return JSON.parse(body);
}

export async function subjectIdFor(detailPath) {
  const d = await aoneroomDetail(detailPath);
  return d?.data?.subject?.subjectId ?? d?.subject?.subjectId ?? null;
}

export async function seasonsOf(detailPath) {
  const d = await aoneroomDetail(detailPath);
  const seasons = d?.data?.resource?.seasons ?? [];
  return seasons.map((s) => ({ se: s.se, maxEp: s.maxEp, allEp: s.allEp }));
}

export async function hasStreams(detailPath, subjectId, se, ep) {
  try {
    const url = `https://hacker.moviewatchtv.fun/fetchVideo?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(detailPath)}&proxy=1`;
    const body = await curlJson(url, "https://supaplay.fun/");
    const j = JSON.parse(body);
    if (j.code !== undefined && Number(j.code) !== 0) return j.message || "rejected";
    const streams = j?.data?.streams ?? j?.streams ?? [];
    return streams.filter((s) => typeof s.url === "string" && s.url).length;
  } catch (e) {
    return `err:${String(e).slice(0, 30)}`;
  }
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  const se = parseInt(process.argv[3] ?? "2", 10);
  if (!path) { console.log("usage: node supaplay-seasons.mjs <detailPath> [se]"); process.exit(0); }
  const sid = await subjectIdFor(path);
  console.log("subjectId:", sid);
  const seasons = await seasonsOf(path);
  console.log("seasons:", JSON.stringify(seasons));
  // probe eps of the requested season: 1, mid, last, plus a few
  const maxEp = seasons.find((s) => s.se === se)?.maxEp ?? 24;
  const eps = [...new Set([1, 2, Math.floor(maxEp / 2), maxEp - 2, maxEp - 1, maxEp])].filter((e) => e >= 1 && e <= maxEp);
  for (const ep of eps) {
    const n = await hasStreams(path, sid, se, ep);
    console.log(`se${se} ep${ep}: ${n} streams`);
  }
}
