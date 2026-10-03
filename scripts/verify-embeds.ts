/**
 * Verify every embedded playback source the app can serve.
 *
 * Run:  npx tsx scripts/verify-embeds.ts
 *
 * For each provider in the /api/stream chain this resolves a real stream
 * for real catalog episodes, then fetches the resolved HLS master playlist
 * the same way the playback proxy would (right Referer per host) and
 * requires it to answer 200 + #EXTM3U. Exit code 1 if anything failed.
 */
import { resolveStream } from "../src/lib/zoko-stream";
import { supaplayDub } from "../src/lib/supaplay";
import { megaplayDub, verifyRealMegaplayDub } from "../src/lib/megaplay";
import { anikotoDub, verifyRealAnikotoDub } from "../src/lib/anikoto";
import { anivexaDubStream } from "../src/lib/anivexa";
import { ANIVEXA_PROVIDERS } from "../src/lib/backup-servers";
import { refererForHost, ZOKO_REFERER, MEGAPLAY_REFERER } from "../src/lib/stream-proxy-registry";
import { db } from "../src/lib/db";
import { mediaByMal } from "../src/lib/anilist";
import { airedEpisodeCount } from "../src/lib/anilist";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface CheckResult {
  provider: string;
  subject: string;
  status: "PASS" | "FAIL" | "SKIP" | "N/A";
  detail: string;
}

const results: CheckResult[] = [];

function report(provider: string, subject: string, status: CheckResult["status"], detail: string) {
  results.push({ provider, subject, status, detail });
  console.log(`  [${status.padEnd(4)}] ${provider.padEnd(22)} ${subject.padEnd(34)} ${detail}`);
}

/** Fetch an HLS master playlist like the playback proxy would. */
async function playlistOk(src: string, refererHint?: string | null): Promise<string> {
  let referer = refererHint ?? undefined;
  try {
    const host = new URL(src).hostname;
    const viaRegistry = refererForHost(host);
    referer = viaRegistry !== undefined ? viaRegistry : refererHint ?? undefined;
  } catch {
    /* not a URL — let the fetch fail below */
  }
  const headers: Record<string, string> = { "User-Agent": UA };
  if (referer) {
    headers["Referer"] = referer;
    try {
      headers["Origin"] = new URL(referer).origin;
    } catch {
      /* keep headers minimal */
    }
  }
  const res = await fetch(src, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000), redirect: "follow" });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
  if (!text.includes("#EXTM3U")) throw new Error("no #EXTM3U (not a playlist)");
  return text;
}

/** Is a resolved src plausibly playable (URL shape + reachable playlist). */
async function verifyPlayable(src: string, refererHint?: string | null): Promise<string> {
  const master = await playlistOk(src, refererHint);
  const variants = master.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
  return `${variants} variant(s)`;
}

async function latestEp(malId: number): Promise<number> {
  const m = await mediaByMal(malId);
  return airedEpisodeCount(m) ?? 1;
}

async function main() {
  console.log("== Embedded playback source verification ==\n");

  // ---------------- subjects ----------------
  const ONEPIECE = 21;
  const OP_LATEST = await latestEp(ONEPIECE);
  const FRIEREN = 54818; // sub + real dub on Zoko
  const JJK = 40748; // wide dub coverage on backfills

  // ---- 1) Zoko SUB (main chain) ----
  console.log("Zoko SUB (main):");
  {
    const s = await resolveStream(ONEPIECE, OP_LATEST, "sub", "zoko").catch((e) => {
      report("zoko-sub", `One Piece ep${OP_LATEST}`, "FAIL", String(e));
      return null;
    });
    if (s) {
      try {
        const v = await verifyPlayable(s.src, ZOKO_REFERER);
        report("zoko-sub", `One Piece ep${OP_LATEST}`, "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("zoko-sub", `One Piece ep${OP_LATEST}`, "FAIL", String(e));
      }
    }
    const s2 = await resolveStream(FRIEREN, 1, "sub", "zoko").catch(() => null);
    if (s2) {
      try {
        const v = await verifyPlayable(s2.src, ZOKO_REFERER);
        report("zoko-sub", "Frieren ep1", "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("zoko-sub", "Frieren ep1", "FAIL", String(e));
      }
    } else report("zoko-sub", "Frieren ep1", "FAIL", "no stream");
  }

  // ---- 2) Kiwi SUB ----
  {
    const s = await resolveStream(ONEPIECE, OP_LATEST, "sub", "kiwi").catch(() => null);
    if (s) {
      try {
        const v = await verifyPlayable(s.src, ZOKO_REFERER);
        report("kiwi-sub", `One Piece ep${OP_LATEST}`, "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("kiwi-sub", `One Piece ep${OP_LATEST}`, "FAIL", String(e));
      }
    } else report("kiwi-sub", `One Piece ep${OP_LATEST}`, "FAIL", "no stream");
  }

  // ---- 3) Zoko DUB (verdict-gated) ----
  {
    const s = await resolveStream(FRIEREN, 1, "dub", "zoko").catch(() => null);
    if (s) {
      try {
        const v = await verifyPlayable(s.src, ZOKO_REFERER);
        report("zoko-dub", "Frieren ep1 dub", "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("zoko-dub", "Frieren ep1 dub", "FAIL", String(e));
      }
    } else report("zoko-dub", "Frieren ep1 dub", "FAIL", "verdict-gated null (fake/missing or hiccup)");
  }

  // ---- 4) SupaPlay (dub backfill, supaplayPath-mapped titles) ----
  {
    const mapped = await db.anime.findMany({
      where: { supaplayPath: { not: null } },
      select: { malId: true, title: true, supaplayPath: true, totalEpisodes: true },
      take: 3,
      orderBy: { popularity: "asc" },
    });
    if (mapped.length === 0) {
      report("supaplay", "(mapping table)", "SKIP", "no supaplayPath rows in DB");
    }
    for (const a of mapped) {
      const ep = Math.min(1, a.totalEpisodes || 1);
      const s = await supaplayDub(a.malId, ep).catch(() => null);
      if (s) {
        try {
          const v = await verifyPlayable(s.src);
          report("supaplay", `${a.title} ep${ep}`, "PASS", `playlist ok (${v})`);
        } catch (e) {
          report("supaplay", `${a.title} ep${ep}`, "FAIL", String(e));
        }
      } else {
        report("supaplay", `${a.title} ep${ep}`, "FAIL", "resolver returned null (mapped path dead?)");
      }
    }
  }

  // ---- 5) Megaplay / yenime (dub backfill) ----
  {
    const verdict = await verifyRealMegaplayDub(FRIEREN, 1);
    const s = verdict === false ? null : await megaplayDub(FRIEREN, 1).catch(() => null);
    if (s) {
      try {
        const v = await verifyPlayable(s.src, MEGAPLAY_REFERER);
        report("yenime(megaplay)", "Frieren ep1 dub", "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("yenime(megaplay)", "Frieren ep1 dub", "FAIL", String(e));
      }
    } else {
      report("yenime(megaplay)", "Frieren ep1 dub", verdict === false ? "N/A" : "FAIL", verdict === false ? "verdict: no dub there" : "resolver null");
    }
  }

  // ---- 6) Megaplay-embed / AniKoto (dub backfill) ----
  {
    const verdict = await verifyRealAnikotoDub(FRIEREN, 1);
    const s = verdict === false ? null : await anikotoDub(FRIEREN, 1).catch(() => null);
    if (s) {
      try {
        const v = await verifyPlayable(s.src, MEGAPLAY_REFERER);
        report("megaplay-embed(anikoto)", "Frieren ep1 dub", "PASS", `playlist ok (${v})`);
      } catch (e) {
        report("megaplay-embed(anikoto)", "Frieren ep1 dub", "FAIL", String(e));
      }
    } else {
      report("megaplay-embed(anikoto)", "Frieren ep1 dub", verdict === false ? "N/A" : "FAIL", verdict === false ? "verdict: no dub there" : "resolver null");
    }
  }

  // ---- 7) Anivexa backup network — every provider ----
  console.log("\nAnivexa backup DUB network (JJK / Frieren):");
  for (const provider of ANIVEXA_PROVIDERS) {
    const attempts = [
      { malId: JJK, ep: 1, label: "JJK ep1 dub" },
      { malId: FRIEREN, ep: 1, label: "Frieren ep1 dub" },
    ];
    let hit = false;
    let lastDetail = "no attempt";
    for (const t of attempts) {
      const s = await anivexaDubStream(t.malId, t.ep, { prefer: provider, maxAttempts: 1 }).catch(() => null);
      if (s?.src) {
        try {
          await verifyPlayable(s.src, s.referer ?? undefined);
          report(`anivexa-${provider}`, t.label, "PASS", "playlist ok");
          hit = true;
          break;
        } catch (e) {
          lastDetail = `resolved but playlist dead: ${String(e)}`;
        }
      } else if (s === null) {
        lastDetail = "provider answered empty";
      }
    }
    if (!hit) report(`anivexa-${provider}`, "JJK/Frieren dub", "FAIL", lastDetail);
  }

  // ---- summary ----
  console.log("\n== Summary ==");
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP" || r.status === "N/A").length;
  console.log(`PASS ${pass} / FAIL ${fail} / SKIP ${skip}`);
  if (fail > 0) {
    console.log("\nFailed providers:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  - ${r.provider} [${r.subject}]: ${r.detail}`);
    }
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error("verify-embeds crashed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
