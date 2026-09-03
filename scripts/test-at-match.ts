/**
 * Calibration: how well do Anime Trending "Top Anime" chart titles map onto
 * our catalog (title / titleEnglish) with season-aware normalization?
 * Run: npx tsx scripts/test-at-match.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ datasources: { db: { url: "file:" + process.cwd() + "/db/custom.db" } } });

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** strip season/sequel markers so "…S3" == "…Season 3" == "…II" == base */
function stripSeason(s: string): string {
  return s
    .replace(/[\s:—–-]*\b(2nd|3rd|4th|5th)\s+season\b/gi, "")
    .replace(/[\s:—–-]*\bseason\s+\d+\b/gi, "")
    .replace(/[\s:—–-]*\bpart\s+\d+\b/gi, "")
    .replace(/[\s:—–-]*\bS\d{1,2}\b$/i, "")
    .replace(/[\s:—–-]+\b(?:II|III|IV|V|VI|VII|VIII|IX|X)\b$/i, "")
    .replace(/[\s:—–-]+\d+$/i, "");
}

function keys(s: string): string[] {
  const out = new Set<string>();
  const n = norm(s);
  if (n) out.add(n);
  const b = norm(stripSeason(s));
  if (b) out.add(b);
  return [...out];
}

interface AtChoice {
  name: string;
  nameAlt?: string | null;
  unranked?: boolean;
  position?: number;
}

async function main() {
  const data = JSON.parse(readFileSync("scripts/anitrendz-data.json", "utf8"));
  const chart = data.pageProps.charts[0];
  const choices: AtChoice[] = chart.choices
    .filter((c: AtChoice) => !c.unranked)
    .sort((a: AtChoice, b: AtChoice) => (a.position ?? 99) - (b.position ?? 99));

  const catalog = await db.anime.findMany({
    where: { inCatalog: true },
    select: { malId: true, title: true, titleEnglish: true },
  });

  const byFull = new Map<string, number>();
  const byBase = new Map<string, number>();
  for (const a of catalog) {
    for (const t of [a.title, a.titleEnglish]) {
      if (!t) continue;
      for (const k of keys(t)) {
        if (!byFull.has(k)) byFull.set(k, a.malId);
        const b = norm(stripSeason(t));
        if (b && !byBase.has(b)) byBase.set(b, a.malId);
      }
    }
  }

  let hit = 0;
  const misses: string[] = [];
  for (const c of choices.slice(0, 20)) {
    let malId: number | null = null;
    let how = "";
    for (const src of [c.name, c.nameAlt ?? ""]) {
      if (!src || malId != null) continue;
      const ks = keys(src);
      if (ks.some((k) => byFull.has(k))) {
        malId = byFull.get(ks.find((k) => byFull.has(k))!)!;
        how = "full";
      } else if (ks.some((k) => byBase.has(k))) {
        malId = byBase.get(ks.find((k) => byBase.has(k))!)!;
        how = "base";
      }
    }
    const pos = c.position ?? "?";
    if (malId != null) {
      hit++;
      const cat = catalog.find((a) => a.malId === malId);
      console.log(`#${pos} HIT(${how}) ${c.name}  =>  ${malId} ${cat?.titleEnglish || cat?.title}`);
    } else {
      misses.push(`#${pos} MISS ${c.name}${c.nameAlt ? ` (alt: ${c.nameAlt})` : ""}`);
    }
  }
  console.log(`\nhits: ${hit}/20`);
  console.log(misses.join("\n"));
}

main().finally(() => db.$disconnect());
