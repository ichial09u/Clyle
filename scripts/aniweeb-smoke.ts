/** Smoke-test the Aniweeb extractor logic against the live endpoints. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function serversJson(malId: number, ep: number) {
  const res = await fetch(`https://aniweeb.net/watch/${malId}/servers?ep=${ep}&lang=sub`, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://aniweeb.net/" },
  });
  return res.json();
}

async function aniweebApi(malId: number, ep: number, lang: string, serverNo: number) {
  const res = await fetch(
    `https://api.aniweeb.net/embed/ani/${malId}/${ep}?track=${lang}&server=${serverNo}&nav=0`,
    { headers: { "User-Agent": UA, Accept: "text/html", Referer: "https://aniweeb.net/" } },
  );
  const html = await res.text();
  const m =
    html.match(/window\.__ANIWEEB_PLAYER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/) ??
    html.match(/window\.__ANIWEEB_PLAYER\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return { ok: false, why: "no cfg" };
  const cfg = JSON.parse(m[1]);
  let src: string | null = null;
  if (cfg.hls && cfg.hls.includes("u=")) {
    const u = new URL(cfg.hls, "https://api.aniweeb.net").searchParams.get("u");
    if (u) src = u;
  }
  if (!src && cfg.hls) src = new URL(cfg.hls, "https://api.aniweeb.net").toString();
  if (!src) return { ok: false, why: "no src", cfg: Object.keys(cfg) };
  const probe = await fetch(src, {
    headers: { "User-Agent": UA, Referer: "https://play.echovideo.ru/" },
  }).catch((e) => null);
  const head = probe ? (await probe.text()).slice(0, 60) : "FETCH FAIL";
  return { ok: head.includes("#EXTM3U"), src: src.slice(0, 90), head };
}

async function vidcloud(malId: number, ep: number, lang: string, serverNo: number) {
  const res = await fetch(
    `https://vidcloud.sbs/embed-2/v3/e-1/getSources?id=${malId}-${ep}-${serverNo}-${lang}`,
    { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://vidcloud.sbs/" } },
  );
  const json = await res.json().catch(() => null);
  const file = json?.sources?.[0]?.file;
  if (!file) return { ok: false, json: JSON.stringify(json).slice(0, 120) };
  const probe = await fetch(file, { headers: { "User-Agent": UA } }).catch(() => null);
  const head = probe ? (await probe.text()).slice(0, 40) : "FETCH FAIL";
  return { ok: head.includes("#EXTM3U"), file: file.slice(0, 80), tracks: json?.tracks?.length ?? 0, head };
}

(async () => {
  // JJK (113415) ep 1 — dub known good; One Piece (21) ep 1100 — long-runner sub
  console.log("=== servers JSON (113415 ep1) ===");
  const sj = await serversJson(113415, 1);
  for (const s of sj.servers ?? []) console.log(" ", s.label, "| dub:", (s.urls?.dub || "").slice(0, 70), "| sub:", (s.urls?.sub || "").slice(0, 55));
  console.log("=== api.aniweeb server=2 DUB ===", JSON.stringify(await aniweebApi(113415, 1, "dub", 2)).slice(0, 220));
  console.log("=== api.aniweeb server=1 SUB ===", JSON.stringify(await aniweebApi(113415, 1, "sub", 1)).slice(0, 220));
  console.log("=== vidcloud DUB ===", JSON.stringify(await vidcloud(113415, 1, "dub", 1)).slice(0, 220));
  console.log("=== vidcloud SUB ===", JSON.stringify(await vidcloud(113415, 1, "sub", 1)).slice(0, 200));
  console.log("=== One Piece ep1100 SUB via vidcloud ===", JSON.stringify(await vidcloud(21, 1100, "sub", 1)).slice(0, 200));
})();
