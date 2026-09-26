// One-time data fix: One Piece (malId 21) poster/banner point at
// z-cdn.chatglm.cn image-search URLs that return 404 to BROWSER requests
// (curl sees 200 — CDN filters by client fingerprint). This broke every
// One Piece poster card: Continue Watching, rails, details.
// Replace with canonical, browser-safe CDN art:
//   poster -> cdn.myanimelist.net large cover (crisp, allowlisted)
//   banner -> s4.anilist.co banner (allowlisted)
// logoUrl is untouched — no component renders it.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const IMAGE = "https://cdn.myanimelist.net/images/anime/1244/138851l.jpg";
const BANNER = "https://s4.anilist.co/file/anilistcdn/media/anime/banner/n1011-jAlbYSBkF0BA.jpg";

const before = await db.anime.findUnique({ where: { malId: 21 }, select: { image: true, banner: true } });
console.log("before:", before);

const after = await db.anime.update({
  where: { malId: 21 },
  data: { image: IMAGE, banner: BANNER },
  select: { malId: true, image: true, banner: true },
});
console.log("after: ", after);

// sanity: also confirm no OTHER anime rows still use z-cdn for image/banner
const strays = await db.anime.findMany({
  where: { OR: [{ image: { contains: "z-cdn.chatglm.cn" } }, { banner: { contains: "z-cdn.chatglm.cn" } }] },
  select: { malId: true, title: true, image: true, banner: true },
});
console.log("remaining z-cdn image/banner rows:", JSON.stringify(strays));

await db.$disconnect();
