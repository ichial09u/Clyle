// End-to-end local test: TVmaze title enrichment via backfillEpisodeTitles.
// This container's node fetch cannot reach api.tvmaze.com (egress quirk;
// prod/Vercel is unaffected) — route tvmaze requests through curl so the
// full lib logic still gets exercised locally.
import { execFileSync } from "node:child_process";

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("api.tvmaze.com")) {
    try {
      const args = ["-s", "--max-time", "10", url];
      if (init?.headers) {
        const h = new Headers(init.headers as HeadersInit);
        for (const [k, v] of h) args.push("-H", `${k}: ${v}`);
      }
      const body = execFileSync("curl", args, { maxBuffer: 64 * 1024 * 1024 });
      return Promise.resolve(new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "application/json" } }));
    } catch (e) {
      return Promise.resolve(new Response(null, { status: 599, statusText: String(e).slice(0, 60) }));
    }
  }
  return nativeFetch(input as Parameters<typeof nativeFetch>[0], init);
}) as typeof fetch;

const { backfillEpisodeTitles } = await import("../src/lib/sync.ts");
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

for (const malId of [21, 59193, 62513]) {
  const filled = await backfillEpisodeTitles(malId).catch((e) => {
    console.error(`malId=${malId} ERR`, String(e).slice(0, 200));
    return -1;
  });
  const eps = await db.episode.findMany({
    where: { animeId: malId, lang: "sub", number: { gte: malId === 21 ? 1174 : 9 } },
    orderBy: { number: "desc" },
    take: 8,
    select: { number: true, title: true },
  });
  console.log(`malId=${malId} filled=${filled}`);
  for (const e of eps.reverse()) console.log(`   ep ${e.number} -> ${e.title ?? "(untitled)"}`);
}
await db.$disconnect();
