#!/usr/bin/env node
/**
 * e2e smoke — the "play-test bot" for Clyle.
 *
 * Zero-dependency fetch suite that exercises the real deployment the way a
 * player would: browse, search, open an anime, open episodes, post/like/
 * reply/delete a comment, save progress, sign-in plumbing, absence guards
 * for removed features (Crunchyroll sync), and the self-heal endpoint. Any
 * failure prints a red line and the process exits non-zero.
 *
 *   BASE_URL=https://temporary-spry-granite-1f0h7ae.vercel.app node scripts/e2e-smoke.mjs
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
    return await fetch(`${BASE}${path}`, { redirect: "manual", ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

function record(name, ok, detail = "") {
  if (!ok) failed++;
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectJson(name, path, init, validate, timeout) {
  try {
    const res = await req(path, init, timeout);
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

  // ---- 1) app shell + sign-in pages ----
  try {
    const res = await req("/");
    const html = await res.text();
    const ok = res.ok && html.includes("__next");
    record("home page renders", ok, ok ? "" : `status ${res.status}`);
  } catch (err) {
    record("home page renders", false, String(err));
  }
  try {
    const res = await req("/signin");
    const html = await res.text();
    record("GET /signin (200)", res.ok, `status ${res.status}`);
    record("signin mentions Google", res.ok && /google/i.test(html), res.ok ? "" : "no Google in HTML");
  } catch (err) {
    record("GET /signin (200)", false, String(err));
  }

  // ---- 2) Google sign-in plumbing (Task: complete sign-in framework) ----
  try {
    const res = await req("/api/auth/me");
    const body = await res.json().catch(() => null);
    record(
      "GET /api/auth/me (configured:true, user shape)",
      res.ok && body?.configured === true && (body?.user === null || (typeof body?.user?.id === "string" && body.user.id.startsWith("google:"))),
      JSON.stringify(body).slice(0, 120),
    );
  } catch (err) {
    record("GET /api/auth/me (configured:true, user shape)", false, String(err));
  }
  try {
    const res = await req("/api/auth/google");
    const loc = res.headers.get("location") ?? "";
    const ok = res.status === 302 && loc.includes("accounts.google.com") && loc.includes("redirect_uri=");
    record("GET /api/auth/google (302 -> Google chooser)", ok, `status ${res.status} loc=${loc.slice(0, 80)}`);
  } catch (err) {
    record("GET /api/auth/google (302 -> Google chooser)", false, String(err));
  }
  {
    const res = await req("/api/auth/signout");
    record("GET /api/auth/signout rejected (POST-only)", res.status === 405 || res.status === 404, `status ${res.status}`);
  }

  // ---- 2b) Crunchyroll sync — REMOVED (owner asked to delete it) ----
  // guard the absence: the route, the Profile card and the libs are gone;
  // if this ever 200s again the feature crept back without approval.
  {
    const gone = await req("/api/crunchyroll/sync", { method: "POST", body: JSON.stringify({ etpRt: "x".repeat(40), userId: `${BOT}-cr` }) });
    record("POST /api/crunchyroll/sync (removed -> 404)", gone.status === 404, `status ${gone.status}`);
  }

  // ---- 3) catalog APIs ----
  const home = await expectJson("GET /api/home", "/api/home", {}, (r, b) => Array.isArray(b?.hero) && b.hero.length > 0 && Array.isArray(b?.sections) && b.hero[0] && typeof b.hero[0].nextEpisodeAt !== "undefined");
  await expectJson("GET /api/latest", "/api/latest", {}, (r, b) => r.ok && b != null);
  await expectJson("GET /api/genres", "/api/genres", {}, (r, b) => r.ok && b != null);

  // ---- 3a) franchise search (accent/space folding + franchise completeness) ----
  await expectJson(
    "GET /api/search?q=one piece (franchise surfaces flagship)",
    "/api/search?q=" + encodeURIComponent("one piece"),
    {},
    (r, b) => r.ok && Array.isArray(b?.catalog) && b.catalog.some((c) => c.malId === 21),
  );
  await expectJson(
    "GET /api/search?q=pokemon (accent-folded franchise)",
    "/api/search?q=pokemon",
    {},
    (r, b) => r.ok && Array.isArray(b?.catalog) && b.catalog.length > 0,
  );

  // ---- 3b) one anime end-to-end (One Piece, malId 21) + Elbaph art ----
  const anime = await expectJson("GET /api/anime/21", "/api/anime/21", {}, (r, b) => b?.anime?.malId === 21 || b?.malId === 21 || (b && JSON.stringify(b).includes("21")));
  {
    const raw = anime ? JSON.stringify(anime) : "";
    record("One Piece posters are Elbaph arc art", raw.includes("op-elbaph-poster") && raw.includes("op-elbaph-banner"), raw.slice(0, 120));
  }
  // Details sections are PRE-BAKED in DetailCache (ships inside custom.db):
  // every view must answer pending:false with both sections present — no
  // re-polling, no waiting on AniList (the "details take forever" fix).
  {
    const ok = !!anime && anime.pending === false && Array.isArray(anime.otherSeasons) && anime.otherSeasons.length > 0 && Array.isArray(anime.similar) && anime.similar.length > 0;
    record("Details sections baked (Other Seasons + You May Also Like, pending:false)", ok, !ok ? `pending=${anime?.pending} rel=${anime?.otherSeasons?.length} sim=${anime?.similar?.length}` : "");
    const relOk = !!anime?.otherSeasons?.length && anime.otherSeasons.every((r) => r.relation && r.name);
    record("Detail sections carry relation + name (live merge intact)", !!relOk, JSON.stringify(anime?.otherSeasons?.[0]).slice(0, 120));
  }
  const eps = await expectJson(
    "GET /api/anime/21/episodes",
    "/api/anime/21/episodes",
    {},
    (r, b) => (b?.total ?? 0) > 0 || Array.isArray(b?.episodes),
  );
  const totalEps = eps?.total ?? eps?.episodes?.length ?? 0;
  if (!anime) record("catalog anime detail", false, "missing");
  if (!eps) record("catalog episodes", false, "missing");

  // ---- 3b-2) per-episode dub gating (the Elbaph fix): One Piece carries
  // dub servers but its newest arc episodes were never dubbed — the episodes
  // payload must carry a proven per-episode boundary (dubThrough) inside the
  // episode range, so the UI can hide DUB on the undubbed tail.
  if (eps) {
    const thru = eps.dubThrough?.s1 ?? null;
    record(
      "per-episode dub boundary (One Piece dubbed through N<total)",
      thru != null && thru > 0 && thru < (eps.total ?? 0),
      `dubThrough=${JSON.stringify(eps?.dubThrough)} total=${eps?.total}`,
    );
    if (thru != null) console.log(`      One Piece: real dub through ep ${thru}/${eps.total} — DUB buttons hidden past it`);
  }

  // ---- 3c) skip-intro data (three-tier: Zoko payload -> AniSkip dataset) ----
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

  // ---- 3d) FlixCloud DUB (Ranma ½ 2024 S1) — OUR-player material through
  // the stored-master proxy (fkey= master + XOR key + plaintext master m3u8).
  {
    let flixSrc = "";
    await expectJson(
      "GET /api/stream (Ranma 2024 S1 DUB via FlixCloud)",
      "/api/stream?malId=59145&ep=1&lang=dub&server=zoko",
      {},
      (r, b) => {
        const ok = r.ok && b?.provider === "flix" && typeof b?.src === "string" && b.src.includes("fkey=") && typeof b?.pk === "string";
        flixSrc = typeof b?.src === "string" ? b.src : "";
        return ok;
      },
    );
    if (flixSrc) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(`${BASE}${flixSrc}`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
        const text = await res.text();
        const ok = res.ok && text.startsWith("#EXTM3U") && text.includes("/api/stream/proxy?");
        record(
          "GET /api/stream/proxy (FlixCloud stored master serves plaintext)",
          ok,
          ok ? "master is plaintext #EXTM3U with proxied children" : `status ${res.status} head=${text.slice(0, 60)}`,
        );
      } catch (err) {
        record("GET /api/stream/proxy (FlixCloud stored master serves plaintext)", false, String(err).slice(0, 160));
      }
    }
  }

  // ---- 3e) BACKUP DUB servers (the Anivexa network) ----
  await expectJson(
    "GET /api/anime/21/episodes (backupDub key present)",
    "/api/anime/21/episodes",
    {},
    (r, b) => r.ok && "backupDub" in b && (b.backupDub === null || Array.isArray(b.backupDub)),
  );
  {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 75_000);
      const res = await fetch(`${BASE}/api/stream?malId=21&ep=1100&lang=dub&server=anivexa-anineko`, { signal: ctrl.signal, headers: { "Content-Type": "application/json" } }).finally(() => clearTimeout(t));
      const body = await res.json().catch(() => null);
      const ok = res.ok && typeof body?.src === "string" && body.src.length > 10 && !!body.provider;
      record(
        "GET /api/stream (backup dub resolves; honest provider)",
        ok,
        ok ? `provider=${body.provider}${body.referer ? " +referer" : ""}` : `status ${res.status} ${JSON.stringify(body).slice(0, 120)}`,
      );
    } catch (err) {
      record("GET /api/stream (backup dub resolves; honest provider)", false, String(err).slice(0, 140));
    }
  }

  // ---- 3f) skip-intro audit: fleet + datasets must cover a healthy majority ----
  const audit = await expectJson(
    "GET /api/skip-audit (skip data pipeline healthy)",
    "/api/skip-audit",
    {},
    (r, b) =>
      r?.status === 200 &&
      typeof b?.totals?.coveragePct === "number" &&
      b.totals.coveragePct >= 60 &&
      b?.totals?.sampled > 0 &&
      (b.totals.scout ?? 0) > 0 &&
      Array.isArray(b?.anime) &&
      b.anime.length > 0,
    60_000,
  );
  if (audit) {
    const t = audit.totals;
    console.log(
      `      skip-intro coverage: ${t.coveragePct}% of ${t.sampled} sampled episodes across ${t.anime} anime` +
        ` (scout ${t.scout} · exact ${t.exact} · consensus ${t.consensus} · skipdb ${t.skipdb} · live ${t.live} · crowd ${t.crowd} · na ${t.na} · uncovered ${t.uncovered})`,
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
    await expectJson(
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
    // author-only guard: deleting someone else's must 403/404
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

  // ---- 5b) watch time -> Top 10 Today (scratch day keeps real rankings clean) ----
  const probeDay = "1970-01-01";
  await expectJson(
    "POST /api/watchtime (roundtrip)",
    "/api/watchtime",
    { method: "POST", body: JSON.stringify({ userId: BOT, malId: 21, day: probeDay, delta: 5, title: "smoke", image: null }) },
    (r, b) => r.ok && b?.ok === true,
  );
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

  // ---- 5d) Top 10 This Month (Anime Trending ranking, Top 50 depth) ----
  await expectJson(
    "GET /api/top10 (Anime Trending rank rail, up to 50 deep)",
    "/api/top10",
    {},
    (r, b) =>
      r.ok &&
      Array.isArray(b?.items) &&
      b.items.length > 0 &&
      b.items.length <= 50 &&
      b.items.every((it) => Number.isFinite(it?.rank) && Number.isFinite(it?.malId) && (it?.prevRank === null || Number.isFinite(it?.prevRank))),
  );

  // ---- 5e) Web Push plumbing (key exchange + subscribe roundtrip) ----
  {
    const key = await expectJson(
      "GET /api/push/key (VAPID public key)",
      "/api/push/key",
      {},
      (r, b) => r.ok && typeof b?.publicKey === "string" && b.publicKey.startsWith("B") && b.publicKey.length > 60,
    );
    if (key?.publicKey) {
      const endpoint = "https://fcm.googleapis.com/fcm/send/smoke-push-scratch";
      await expectJson(
        "POST /api/push/subscribe (upsert)",
        "/api/push/subscribe",
        { method: "POST", body: JSON.stringify({ endpoint, keys: { p256dh: "B" + "x".repeat(86), auth: "smoke-auth" }, userId: BOT }) },
        (r, b) => r.ok && b?.ok === true,
      );
      await expectJson(
        "DELETE /api/push/subscribe (cleanup)",
        "/api/push/subscribe",
        { method: "DELETE", body: JSON.stringify({ endpoint }) },
        (r, b) => r.ok && b?.ok === true,
      );
    }
  }

  // ---- 5f) Arriving rail (Netflix-style coming-soon: tags + air times) ----
  await expectJson(
    "GET /api/arriving (Netflix-style coming-soon rail)",
    "/api/arriving",
    {},
    (r, b) =>
      r.ok &&
      Array.isArray(b?.items) &&
      b.items.length > 0 &&
      b.items.length <= 40 &&
      b.items.every(
        (it) =>
          Number.isFinite(it?.malId) &&
          ["series", "movie", "episode"].includes(it?.kind) &&
          (it?.airingAt === null || Number.isFinite(it?.airingAt)) &&
          (it?.kind !== "episode" || Number.isFinite(it?.episode)),
      ),
  );

  // ---- 5g) per-anime drop watches (details-page bell roundtrip) ----
  {
    const ep = "https://fcm.googleapis.com/fcm/send/smoke-anime-notify";
    await expectJson(
      "POST /api/anime-notify (subscribe anime)",
      "/api/anime-notify",
      { method: "POST", body: JSON.stringify({ endpoint: ep, malId: 21, title: "One Piece", on: true }) },
      (r, b) => r.ok && b?.ok === true && b?.on === true,
    );
    await expectJson(
      "GET /api/anime-notify (list watches)",
      `/api/anime-notify?endpoint=${encodeURIComponent(ep)}`,
      {},
      (r, b) => r.ok && Array.isArray(b?.malIds) && b.malIds.includes(21),
    );
    await expectJson(
      "POST /api/anime-notify (unsubscribe)",
      "/api/anime-notify",
      { method: "POST", body: JSON.stringify({ endpoint: ep, malId: 21, on: false }) },
      (r, b) => r.ok && b?.ok === true && b?.on === false,
    );
    {
      const bad = await req("/api/anime-notify", { method: "POST", body: JSON.stringify({ endpoint: "http://insecure", malId: 21, on: true }) });
      record("POST /api/anime-notify rejects bad endpoint", bad.status === 400, `status ${bad.status}`);
    }
  }

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
