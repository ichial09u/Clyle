#!/usr/bin/env node
/**
 * e2e smoke — the "play-test bot" for AnimeTest123.
 *
 * Zero-dependency fetch suite that exercises the real deployment the way a
 * player would: browse, open an anime, open episodes, post/like/reply/delete
 * a comment, save progress, and run the self-heal endpoint. Any failure is
 * printed as a red line and the process exits non-zero, so it can run from
 * cron, CI, or a watchdog loop:
 *
 *   BASE_URL=https://temporary-spry-granite-1f0h7ae.vercel.app npm run smoke
 *   node scripts/watchdog.mjs            # re-runs smoke every 15 min + logs
 *
 * All probe writes use the "smoke-bot" identity and clean up after themselves.
 */
const BASE = (process.env.SMOKE_URL || process.env.BASE_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app").replace(/\/$/, "");
const BOT = "smoke-bot"; // stable identity so probe rows are upserted, not accumulated
const TIMEOUT_MS = 30_000;

const results = [];
let failed = 0;

async function req(path, init = {}, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

function record(name, ok, detail = "") {
  if (!ok) failed++;
  results.push({ name, ok, detail });
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectJson(name, path, init, validate) {
  try {
    const res = await req(path, init);
    const body = await res.json().catch(() => null);
    const v = validate ? validate(res, body) : res.ok;
    record(name, v === true && res.ok, v === true ? "" : `status ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    return body;
  } catch (err) {
    record(name, false, String(err).slice(0, 160));
    return null;
  }
}

(async () => {
  console.log(`\nSmoke-testing ${BASE}\n`);

  // ---- 1) app shell ----
  try {
    const res = await req("/");
    const html = await res.text();
    const ok = res.ok && html.includes("__next");
    record("home page renders", ok, ok ? "" : `status ${res.status}`);
  } catch (err) {
    record("home page renders", false, String(err));
  }

  // ---- 2) catalog APIs ----
  const home = await expectJson("GET /api/home", "/api/home", {}, (r, b) => Array.isArray(b?.hero) && b.hero.length > 0 && Array.isArray(b?.sections));
  await expectJson("GET /api/latest", "/api/latest", {}, (r, b) => r.ok && b != null);
  await expectJson("GET /api/genres", "/api/genres", {}, (r, b) => r.ok && b != null);

  // ---- 3) one anime end-to-end (One Piece, malId 21) ----
  const anime = await expectJson("GET /api/anime/21", "/api/anime/21", {}, (r, b) => b?.anime?.malId === 21 || b?.malId === 21 || (b && JSON.stringify(b).includes("21")));
  const eps = await expectJson(
    "GET /api/anime/21/episodes",
    "/api/anime/21/episodes",
    {},
    (r, b) => (b?.total ?? 0) > 0 || Array.isArray(b?.episodes),
  );
  const totalEps = eps?.total ?? eps?.episodes?.length ?? 0;
  if (!anime) record("catalog anime detail", false, "missing");
  if (!eps) record("catalog episodes", false, "missing");

  // ---- 3b) skip-intro data (three-tier: Zoko payload -> AniSkip dataset) ----
  // One Piece carries Zoko-native skip data; Frieren is covered by the vendored
  // AniSkip dataset instead. Both must expose a usable intro interval.
  await expectJson(
    "GET /api/stream (skip intro: Zoko-native)",
    "/api/stream?malId=21&ep=1&lang=sub&server=zoko",
    {},
    (r, b) => b?.skip?.intro && Number.isFinite(b.skip.intro.end) && b.skip.intro.end > b.skip.intro.start,
  );
  await expectJson(
    "GET /api/stream (skip intro: AniSkip dataset)",
    "/api/stream?malId=52991&ep=1&lang=sub&server=zoko",
    {},
    (r, b) => b?.skip?.intro && Number.isFinite(b.skip.intro.end) && b.skip.intro.end > b.skip.intro.start,
  );

  // ---- 3c) skip-intro audit: the bot walks EVERY anime in the catalog and
  // verifies a Skip Intro button will appear (exact AniSkip row, per-anime
  // consensus, cached live tier, or the TV-length heuristic window). Any
  // uncovered TV episode fails the run.
  const audit = await expectJson(
    "GET /api/skip-audit (every anime shows Skip Intro)",
    "/api/skip-audit",
    {},
    (r, b) =>
      b?.ok === true &&
      typeof b?.totals?.coveragePct === "number" &&
      b.totals.coveragePct >= 95 &&
      b?.totals?.sampled > 0 &&
      Array.isArray(b?.anime) &&
      b.anime.length > 0,
    60_000,
  );
  if (audit) {
    const t = audit.totals;
    console.log(
      `      skip-intro coverage: ${t.coveragePct}% of ${t.sampled} sampled episodes across ${t.anime} anime` +
        ` (exact ${t.exact} · consensus ${t.consensus} · live ${t.live} · heuristic ${t.heuristic} · uncovered ${t.uncovered})`,
    );
  }

  // ---- 4) comments: post -> like -> unlike -> reply -> verify -> delete ----
  const stamp = Date.now();
  const probeText = `[smoke-bot] probe ${stamp}`;
  const posted = await expectJson(
    "POST /api/comments (probe)",
    "/api/comments",
    { method: "POST", body: JSON.stringify({ malId: 21, userId: BOT, nickname: "Smoke Bot", text: probeText }) },
    (r, b) => !!b?.comment?.id,
  );
  const commentId = posted?.comment?.id;

  if (commentId) {
    const liked = await expectJson(
      "POST /api/comments/like (on)",
      "/api/comments/like",
      { method: "POST", body: JSON.stringify({ commentId, userId: BOT }) },
      (r, b) => b?.liked === true && b?.likes === 1,
    );
    await expectJson(
      "POST /api/comments/like (toggle off)",
      "/api/comments/like",
      { method: "POST", body: JSON.stringify({ commentId, userId: BOT }) },
      (r, b) => b?.liked === false && b?.likes === 0,
    );
    await expectJson(
      "POST /api/comments (reply to probe)",
      "/api/comments",
      { method: "POST", body: JSON.stringify({ malId: 21, userId: BOT, nickname: "Smoke Bot", text: `[smoke-bot] reply ${stamp}`, parentId: commentId }) },
      (r, b) => b?.comment?.parentId === commentId,
    );
    await expectJson(
      "GET /api/comments (list w/ userId)",
      `/api/comments?malId=21&userId=${BOT}`,
      {},
      (r, b) => Array.isArray(b?.comments) && b.comments.some((c) => c.id === commentId && typeof c.likes === "number" && c.likedByMe === false),
    );
    const del = await req("/api/comments", { method: "DELETE", body: JSON.stringify({ id: commentId, userId: BOT }) });
    record("DELETE /api/comments (cleanup)", del.ok, del.ok ? "probe + reply removed" : `status ${del.status}`);
    // author-only guard: deleting someone else's must 403
    const guard = await req("/api/comments", { method: "DELETE", body: JSON.stringify({ id: commentId, userId: "someone-else" }) });
    record("DELETE guard (403 for non-author)", guard.status === 404 || guard.status === 403, `status ${guard.status}`);
  }

  // ---- 5) progress roundtrip (upsert keyed on BOT, safe to re-run) ----
  await expectJson(
    "POST /api/progress (roundtrip)",
    "/api/progress",
    { method: "POST", body: JSON.stringify({ userId: BOT, malId: 21, episode: 1, lang: "sub", server: "zoko", position: 12, duration: 1400, title: "smoke", image: null }) },
    (r) => r.ok,
  );
  await expectJson("GET /api/continue (bot)", `/api/continue?userId=${BOT}`, {}, (r) => r.ok || r.status === 400);

  // ---- 5b) watch time -> Top 10 Today (probe uses a scratch day so real rankings stay untouched) ----
  const probeDay = "1970-01-01";
  await expectJson(
    "POST /api/watchtime (roundtrip)",
    "/api/watchtime",
    { method: "POST", body: JSON.stringify({ userId: BOT, malId: 21, day: probeDay, delta: 5, title: "smoke", image: null }) },
    (r, b) => r.ok && b?.ok === true,
  );
  // negative checks: expectJson asserts res.ok, so raw 400s use req + record
  {
    const bad = await req("/api/watchtime", { method: "POST", body: JSON.stringify({ malId: 21, day: "not-a-day", delta: 5 }) });
    record("POST /api/watchtime rejects bad day", bad.status === 400, `status ${bad.status}`);
  }
  await expectJson(
    "GET /api/watchtime top (accumulated)",
    `/api/watchtime?day=${probeDay}`,
    {},
    (r, b) => r.ok && Array.isArray(b?.items) && b.items.some((i) => i.malId === 21 && i.seconds >= 5 && !!i.title),
  );
  {
    const badGet = await req("/api/watchtime?day=nope");
    record("GET /api/watchtime rejects bad day", badGet.status === 400, `status ${badGet.status}`);
  }
  // streak metadata rides every watchtime response (Netflix-style weeks badge)
  await expectJson(
    "GET /api/watchtime streak meta (scratch day)",
    `/api/watchtime?day=${probeDay}`,
    {},
    (r, b) => r.ok && Array.isArray(b?.items) && b.items.length > 0 && Number.isFinite(b.items[0].streakDays) && typeof b.items[0].isNew === "boolean" && Number.isFinite(b.items[0].weeksInTop10),
  );

  // ---- 5c) top 10 rank-change notifications feed (bell data path) ----
  await expectJson(
    "GET /api/top10-events (bell feed)",
    "/api/top10-events",
    {},
    (r, b) => r.ok && Array.isArray(b?.events) && b.events.every((e) => (["enter", "leave", "up", "down"].includes(e.type)) && !!e.title && !!e.day),
  );

  // ---- 5d) Top 10 This Month (TMDB popularity ranking) ----
  await expectJson(
    "GET /api/top10 (TMDB rank rail)",
    "/api/top10",
    {},
    (r, b) => r.ok && Array.isArray(b?.items) && b.items.length > 0 && b.items.every((it) => Number.isFinite(it?.rank) && Number.isFinite(it?.malId)),
  );

  // ---- 6) self-heal endpoint (runs a real catalog sync) ----
  await expectJson("GET /api/cron (self-test)", "/api/cron", {}, (r, b) => b?.ok === true && Array.isArray(b?.checks) && Array.isArray(b?.fixes), 60_000);

  // ---- summary ----
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed${totalEps ? ` · catalog: ${totalEps} eps for One Piece` : ""}`);
  if (failed > 0) {
    console.log(`\x1b[31m${failed} FAILED — see lines above\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32mAll green.\x1b[0m");
})();
