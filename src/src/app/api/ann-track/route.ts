import { NextResponse } from "next/server";

/**
 * ANN Tracking — server proxy for the AnimeNewsNetwork Encyclopedia API.
 *
 * The tracking button on the details page asks this route for a show's ANN
 * record: the encyclopedia search report (reports.xml id=155) finds the title,
 * then api.xml returns its full entry (type, vintage/air dates, every listed
 * episode). Parsed into a small JSON shape the button panel can render.
 *
 * Server-side for three reasons: ANN blocks browser CORS, the XML is fiddly
 * to parse twice on every client, and responses are cacheable per title
 * (ANN data moves at most daily — 6h in-memory TTL per warm instance).
 *
 * ANN occasionally bot-walls datacenter IPs with an HTML "security check"
 * page; any such response simply parses to found:false and the panel says
 * the title couldn't be found right now — the route never throws.
 */

export const dynamic = "force-dynamic";

type AnnMatch = {
  annId: number;
  name: string;
  type: string | null;
  precision: string | null;
  vintage: string | null;
  /** how many <episode> entries ANN lists (≈ episodes aired so far) */
  episodesListed: number | null;
  /** highest episode number seen (covers skipped/patchy numbering) */
  highestEpisode: number | null;
  /** ANN's own total, when the entry carries an episodes-count info line */
  totalEps: number | null;
  url: string;
};

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; payload: AnnApiPayload }>();

type AnnApiPayload = { found: boolean; match?: AnnMatch; error?: string };

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));

/** loose comparable form: case/fold/punct-insensitive */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function annFetch(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ClyleApp/1.0 (anime tracker panel)",
        Accept: "application/xml, text/xml, */*",
      },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();
    // bot-wall pages announce themselves as HTML — treat as a miss
    return text.includes("<anime ") || text.includes("<item>") || text.includes("<report") ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** search report items — tolerate both field-element and attribute shapes */
function parseSearchItems(xml: string): Array<{ id: number; name: string; type: string | null; precision: string | null }> {
  const items: Array<{ id: number; name: string; type: string | null; precision: string | null }> = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  for (const b of blocks) {
    const id = Number(b.match(/<id>(\d+)<\/id>/)?.[1] ?? b.match(/\bid="(\d+)"/)?.[1] ?? NaN);
    if (!Number.isFinite(id)) continue;
    const name = b.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? b.match(/\bname="([^"]*)"/)?.[1] ?? "";
    const type = b.match(/<type>([^<]*)<\/type>/)?.[1] ?? b.match(/\btype="([^"]*)"/)?.[1] ?? null;
    const precision = b.match(/<precision>([^<]*)<\/precision>/)?.[1] ?? null;
    items.push({ id, name: decode(name).trim(), type: type ? decode(type) : null, precision: precision ? decode(precision) : null });
  }
  return items;
}

function pickBest(items: ReturnType<typeof parseSearchItems>, q: string) {
  if (!items.length) return null;
  const target = norm(q);
  const scored = items.map((it) => {
    const n = norm(it.name);
    let score = 0;
    if (n === target) score = 100;
    else if (n.startsWith(target) || target.startsWith(n)) score = 80;
    else if (n.includes(target) || target.includes(n)) score = 60;
    // prefer TV series over movies/specials when otherwise tied
    if (/tv/i.test(it.type ?? it.precision ?? "")) score += 4;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].it : items[0]; // total no-match: first result is still a useful guess
}

function parseDetail(xml: string, annId: number, fallbackName: string, type: string | null, precision: string | null): AnnMatch {
  const head = xml.match(/<anime\b([^>]*)>/)?.[1] ?? "";
  const name = decode(head.match(/\bname="([^"]*)"/)?.[1] ?? "").trim() || fallbackName;
  const epNums = Array.from(xml.matchAll(/<episode\s+[^>]*\bnum="(\d+)"/g)).map((m) => Number(m[1]));
  const vintageTag = xml.match(/<info\b[^>]*type="Vintage"[^>]*>([\s\S]*?)<\/info>/)?.[1] ?? null;
  const totalRaw = xml.match(/<info\b[^>]*type="(?:Number of episodes|Episodes)"[^>]*>([^<]*)</)?.[1]?.trim() ?? null;
  const totalEps = totalRaw && /^\d+$/.test(totalRaw) ? Number(totalRaw) : null;
  return {
    annId,
    name,
    type: type ?? head.match(/\btype="([^"]*)"/)?.[1] ?? null,
    precision: precision ?? null,
    vintage: vintageTag ? decode(vintageTag).trim() : null,
    episodesListed: epNums.length ? epNums.length : null,
    highestEpisode: epNums.length ? Math.max(...epNums) : null,
    totalEps,
    url: `https://www.animenewsnetwork.com/encyclopedia/anime.php?id=${annId}`,
  };
}

async function resolve(q: string): Promise<AnnApiPayload> {
  const searchXml = await annFetch(
    `https://cdn.animenewsnetwork.com/encyclopedia/reports.xml?id=155&q=${encodeURIComponent(q)}&n=6`,
  );
  if (!searchXml) return { found: false, error: "ANN search unavailable" };
  const best = pickBest(parseSearchItems(searchXml), q);
  if (!best) return { found: false };

  const detailXml = await annFetch(`https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=${best.id}`);
  if (!detailXml) return { found: false, error: "ANN detail unavailable" };
  const match = parseDetail(detailXml, best.id, best.name, best.type, best.precision);
  return { found: true, match };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ found: false, error: "missing q" }, { status: 400 });

  const key = norm(q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json(hit.payload, { headers: { "Cache-Control": "public, max-age=600" } });
  }

  const payload = await resolve(q);
  // only cache definitive answers; bot-wall misses retry on the next request
  if (payload.found || payload.error === undefined) cache.set(key, { at: Date.now(), payload });
  return NextResponse.json(payload, { headers: { "Cache-Control": "public, max-age=600" } });
}
