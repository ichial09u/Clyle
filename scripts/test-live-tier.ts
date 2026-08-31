/**
 * One-off: exercise the live AniSkip tier end-to-end (URL building, parsing,
 * positive + negative disk cache) against the real API. Run: bun scripts/test-live-tier.ts
 */
import { prefetchSkipTimes } from "../src/lib/skip-times";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const cachePath = (malId: number) =>
  join(
    process.cwd(),
    "db",
    "aniskip-cache",
    `${createHash("sha1").update(String(malId)).digest("hex").slice(0, 16)}.json`,
  );

async function main() {
  console.log("1) prefetch JJK ep1 + Frieren ep1 (aniskip definitely has both)...");
  const fetched = await prefetchSkipTimes(
    [
      { malId: 40748, ep: 1, lenMin: 24 },
      { malId: 52991, ep: 1, lenMin: 24 },
    ],
    4,
  );
  console.log(`   fetched (positive hits): ${fetched}`);

  let pass = false;
  for (const malId of [40748, 52991]) {
    try {
      const file = JSON.parse(await readFile(cachePath(malId), "utf8")) as Record<string, { op?: number[]; ed?: number[]; miss?: boolean }>;
      console.log(`2) cache for malId ${malId}:`, JSON.stringify(file));
      const e1 = file["1"];
      if (e1 && (e1.op || e1.ed)) pass = true;
    } catch {
      console.log(`   (no cache file for ${malId})`);
    }
  }
  if (pass) console.log("PASS: live tier fetched and cached real skip times");
  else {
    console.log("FAIL: no positive cache entry — inspect above");
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
