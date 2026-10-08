import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lite } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/suggestions?userId=<uuid>
 *
 * "Suggested For You" — the companion rail for Continue Watching, titled
 * "Because you watched <anchor>". v2: the ranking is anchored on THAT show,
 * not on a blended genre soup of the entire history.
 *
 * Why v1 failed (Detective Conan → romcoms): it pooled the top-6 genres of
 * the whole watch history and ranked the 400 most popular catalog titles by
 * raw overlap. Ubiquitous genres (Comedy/Action/Drama appear in ~half the
 * catalog) accumulated across many shows and let any popular romcom outrank
 * the handful of actual detective series.
 *
 * v2 scoring — catalog-local only, zero upstream calls:
 *
 *   1. Genre overlap with INVERSE-POPULARITY weighting (IDF²): a shared
 *      "Mystery" (253/2141 catalog shows) weighs ~8x a shared "Action"
 *      (1027/2141). Generic genres effectively stop counting; distinctive
 *      ones carry the rail.
 *   2. Synopsis/title keyword affinity: distinctive words mined from the
 *      anchor's own text ("detective", "case", "crime", "science"…), each
 *      weighted by how rare the word is across the catalog, matched against
 *      candidate text (title hits count double). This is what surfaces
 *      detective/mystery shows even when the genre tags are blunt — and
 *      "smart science" shows for anchors like Dr. Stone.
 *   3. A small decaying echo from the other recent watches keeps the rail
 *      personal, but the anchor dominates ~4:1 (the rail names it).
 *
 * The catalog index (genres + mined keywords + document frequencies) is
 * cached in module scope — one SQLite scan per TTL window, scoring itself is
 * pure in-memory set math.
 */

const INDEX_TTL_MS = 30 * 60 * 1000;
const ECHO_SHOWS = 8; // how many non-anchor recent watches contribute
const ECHO_WEIGHT = 0.3; // first echo's weight (halves per step back)
const GENRE_PRIOR = 0.35; // boost for sharing the user's own top genres

interface IndexRow {
  malId: number;
  title: string;
  titleEnglish: string | null;
  genres: string[];
  keywords: string[];
  popularity: number;
}

interface CatalogIndex {
  at: number;
  rows: IndexRow[];
  byId: Map<number, IndexRow>;
  genreW: Map<string, number>; // genre -> IDF² weight
  kwW: Map<string, number>; // keyword -> IDF weight (capped)
  kwRe: Map<string, RegExp>; // precompiled word-boundary matcher per keyword
}

const STOP = new Set(
  `about above after again against all also always among another any anyone anything around because been before being below between both but called can cannot come comes could did does doing done during each else even ever every few find first for from further get gets getting give given goes going gone got had has have having he her here hers him his how however into isn its itself just keep kept know known least less let like made make makes many may maybe me might more most mostly much must myself near need never new next no nor not now off often once only onto other others our ours out over own people per put puts rather really said same say says see seen set several she should since so some someone something still such sure take taken takes than that the their theirs them themselves then there these they thing things this those though through thus to too took toward two under until up upon us use used uses using very want wants was way ways well went were what when where whether which while who whom whose why will with within without won would yet you your yours
   anime episode episodes series story stories season show shows manga chapter chapters source wikipedia myanimelist ann another live lives life living day days year years time times world girl girls boy boys man woman men women high school student students schoolgirl schoolmates friend friends friendship team group member members town city name named named called new old young long short big little great good best better bad worst actual actually becomes become became begin begins end ends ended ending final finally first second third around based based takes taking place set follows follow following center centers revolves tells tale plot main character characters protagonist hero heroine uses using makes made works working find finds found tries trying wants wanting goes going`
    .split(/\s+/)
    .filter(Boolean),
);

function tokenize(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])
    .map((w) => w.replace(/['-]+$/, ""))
    .filter((w) => w.length >= 4 && w.length <= 15 && !STOP.has(w));
  return [...new Set(words)];
}

let indexCache: CatalogIndex | null = null;
let indexBuilding: Promise<CatalogIndex> | null = null;

async function buildIndex(): Promise<CatalogIndex> {
  const rows = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, titleEnglish: true, genres: true, synopsis: true, popularity: true },
  });

  const index: CatalogIndex = {
    at: Date.now(),
    rows: [],
    byId: new Map(),
    genreW: new Map(),
    kwW: new Map(),
    kwRe: new Map(),
  };

  const genreDf = new Map<string, number>();
  const kwDf = new Map<string, number>();
  const parsed: Array<{ row: IndexRow; keywords: string[] }> = [];

  for (const r of rows) {
    let genres: string[] = [];
    try {
      genres = JSON.parse(r.genres) as string[];
    } catch {
      genres = [];
    }
    for (const g of new Set(genres)) genreDf.set(g, (genreDf.get(g) ?? 0) + 1);
    // mine distinctive words from title + synopsis (title words are repeated
    // there by design — dedupe below)
    const keywords = [
      ...new Set([
        ...tokenize(r.titleEnglish ?? ""),
        ...tokenize(r.title),
        ...tokenize(r.synopsis?.slice(0, 900) ?? ""),
      ]),
    ].slice(0, 40);
    for (const k of keywords) kwDf.set(k, (kwDf.get(k) ?? 0) + 1);

    const row: IndexRow = {
      malId: r.malId,
      title: r.title,
      titleEnglish: r.titleEnglish,
      genres,
      keywords,
      popularity: r.popularity ?? Number.MAX_SAFE_INTEGER,
    };
    index.rows.push(row);
    index.byId.set(r.malId, row);
    parsed.push({ row, keywords });
  }

  const n = Math.max(1, rows.length);
  for (const [g, df] of genreDf) {
    // IDF² — rare genres dominate, ubiquitous ones fade to noise
    const w = Math.pow(Math.log(n / df), 2);
    index.genreW.set(g, Number.isFinite(w) ? Math.min(w, 8) : 0.15);
  }
  for (const [k, df] of kwDf) {
    // rare words are stronger taste signals than "school"
    index.kwW.set(k, Math.min(Math.log(1 + n / df), 3));
    // precompile the matcher once per index build (not per request per row)
    index.kwRe.set(k, new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  }

  // attach per-row keyword weights now that kwW is complete
  for (const { row, keywords } of parsed) {
    row.keywords = keywords.filter((k) => (index.kwW.get(k) ?? 0) >= 1.1);
  }

  return index;
}

async function getIndex(): Promise<CatalogIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache;
  if (!indexBuilding) {
    indexBuilding = buildIndex()
      .then((idx) => {
        indexCache = idx;
        return idx;
      })
      .finally(() => {
        indexBuilding = null;
      });
  }
  return indexBuilding;
}

/** Similarity between a candidate and one watched show (genres + keywords). */
function simTo(idx: CatalogIndex, candidate: IndexRow, cText: string, cTitle: string, show: IndexRow): number {
  let score = 0;
  for (const g of candidate.genres) {
    if (show.genres.includes(g)) score += idx.genreW.get(g) ?? 0;
  }
  // keyword affinity: the watched show's distinctive words appearing in the
  // candidate's text — title hits count double (regexes are precompiled in
  // the index; compiling thousands per request used to burn the CPU)
  let hits = 0;
  for (const k of show.keywords) {
    const w = idx.kwW.get(k) ?? 0;
    if (w < 1.1) continue;
    const re = idx.kwRe.get(k);
    if (!re) continue;
    if (re.test(cTitle)) hits += 2 * w;
    else if (re.test(cText)) hits += w;
  }
  // cap so keyword luck can't outweigh a real genre identity
  score += Math.min(hits * 0.9, 10);
  return score;
}

function textOf(row: IndexRow): string {
  return `${row.title} ${row.titleEnglish ?? ""}`.toLowerCase();
}

export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ items: [] }, { status: 400 });

  // what the user is watching right now (one entry per anime, freshest first)
  const progressRows = await db.watchProgress.findMany({
    where: { userId, position: { gt: 5 } },
    orderBy: { updatedAt: "desc" },
    take: 60,
  });
  const seen = new Set<number>();
  const watchingIds: number[] = [];
  for (const r of progressRows) {
    if (!seen.has(r.malId)) {
      seen.add(r.malId);
      watchingIds.push(r.malId);
    }
  }

  if (!watchingIds.length) {
    // nothing to infer from yet — surface the catalog's most popular titles
    const popular = await db.anime.findMany({
      where: { inCatalog: true },
      orderBy: { popularity: "asc" },
      take: 12,
    });
    return NextResponse.json({ items: popular.map(lite), becauseOf: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const idx = await getIndex();

  // anchor = the show the rail names ("Because you watched X") — the most
  // recently watched one that still exists in the catalog
  let anchor: IndexRow | null = null;
  for (const id of watchingIds) {
    const row = idx.byId.get(id);
    if (row) {
      anchor = row;
      break;
    }
  }
  if (!anchor) {
    const popular = await db.anime.findMany({
      where: { inCatalog: true, malId: { notIn: watchingIds } },
      orderBy: { popularity: "asc" },
      take: 12,
    });
    return NextResponse.json({ items: popular.map(lite), becauseOf: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const anchorTitle = anchor.titleEnglish?.trim() || anchor.title;
  const echoes = watchingIds
    .filter((id) => id !== anchor.malId)
    .slice(0, ECHO_SHOWS)
    .map((id, i) => ({ row: idx.byId.get(id), w: ECHO_WEIGHT * Math.pow(0.5, i) }))
    .filter((e): e is { row: IndexRow; w: number } => !!e.row);

  // the user's OWN genre fingerprint: every recent watch votes its genres,
  // weighted by recency — the "goes off what you watch" signal. Distinctive
  // genres already carry big IDF² weights; the prior keeps candidates that
  // share the viewer's actual genre mix afloat even when the anchor alone
  // would rank them out.
  const genrePrior = new Map<string, number>();
  watchingIds.slice(0, 20).forEach((id, i) => {
    const row = idx.byId.get(id);
    if (!row) return;
    const w = 1 / (1 + i * 0.5);
    for (const g of row.genres) genrePrior.set(g, (genrePrior.get(g) ?? 0) + w);
  });
  const topGenres = new Set(
    [...genrePrior.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([g]) => g),
  );

  const candidates = idx.rows.filter((r) => !watchingIds.includes(r.malId));
  const scored = candidates
    .map((c) => {
      const text = textOf(c);
      let score = simTo(idx, c, text, c.title.toLowerCase(), anchor!);
      for (const e of echoes) score += e.w * simTo(idx, c, text, c.title.toLowerCase(), e.row);
      // personal genre prior: share the viewer's own top genre mix
      const shared = c.genres.filter((g) => topGenres.has(g)).length;
      if (shared) score += GENRE_PRIOR * Math.min(shared, 3);
      return { c, score };
    })
    .filter((s) => s.score > 0.5)
    .sort((x, y) => y.score - x.score || x.c.popularity - y.c.popularity)
    .slice(0, 12);

  let items = scored.map((s) => s.c.malId);
  // thin result (very small overlap with the catalog)? top up with popular
  // titles the user hasn't started
  if (items.length < 6) {
    const extra = await db.anime.findMany({
      where: { inCatalog: true, malId: { notIn: [...watchingIds, ...items] } },
      orderBy: { popularity: "asc" },
      take: 12 - items.length,
    });
    items = [...items, ...extra.map((e) => e.malId)];
  }

  const full = items.length
    ? await db.anime.findMany({ where: { malId: { in: items } } })
    : [];
  const byId = new Map(full.map((a) => [a.malId, a]));
  const ordered = items.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);

  return NextResponse.json(
    { items: ordered.map(lite), becauseOf: anchorTitle },
    { headers: { "Cache-Control": "no-store" } },
  );
}
