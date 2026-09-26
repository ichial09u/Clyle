// One-time data fix: restore the ORIGINAL One Piece (malId 21) key visual —
// the Elbaf-arc poster the user calls the "elbaph poster".
//
// History: e41aee4ea replaced the poster+banner (z-cdn.chatglm.cn URLs, which
// 404 for BROWSER requests) with MAL/AniList CDN art to fix the CW dark-card
// bug. That fixed the cards but ALSO swapped the hero backdrop — the user
// wants the original Elbaf poster back ("the one piece wasn't the problem").
//
// Robust restore: the z-cdn original still serves SERVER-side (curl 200), so
// we already downloaded it once into public/art/onepiece-elbaph.jpg (1200x1690,
// 568KB). Pointing image+banner at that SELF-HOSTED copy gives us:
//   - the exact old hero look (pre-fix DB had BOTH fields = this poster)
//   - same-origin loading — immune to the browser-side CDN filtering that
//     killed the original URL, so the CW dark-card bug cannot come back
// logoUrl stays untouched (no component renders it).
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const ART = "/art/onepiece-elbaph.jpg";

const before = await db.anime.findUnique({ where: { malId: 21 }, select: { image: true, banner: true } });
console.log("before:", before);

const after = await db.anime.update({
  where: { malId: 21 },
  data: { image: ART, banner: ART },
  select: { malId: true, title: true, image: true, banner: true },
});
console.log("after: ", after);

// sanity: no OTHER anime rows may still reference z-cdn for image/banner
const strays = await db.anime.findMany({
  where: { OR: [{ image: { contains: "z-cdn.chatglm.cn" } }, { banner: { contains: "z-cdn.chatglm.cn" } }] },
  select: { malId: true, title: true, image: true, banner: true },
});
console.log("remaining z-cdn image/banner rows:", JSON.stringify(strays));

await db.$disconnect();
