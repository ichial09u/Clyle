/**
 * Regenerate PWA icons from the user-uploaded logo (rose-in-C mark).
 *
 * Source: scripts/pwa-src/master.png — the PDF's embedded 4000×4000 image
 * with its smask applied and flattened onto white (the mark is a BLACK "C",
 * so the tile must stay light or the glyph vanishes).
 *
 * Outputs (public/):
 *   icon-192.png           regular icon, full-bleed like the original artwork
 *   icon-512.png           regular icon
 *   apple-touch-icon.png   180px iOS home-screen icon
 *   icon-512-maskable.png  mark scaled into Android's ~80% safe zone
 */
import sharp from "sharp";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "scripts", "pwa-src", "master.png");

// master.png is square content; normalize to exact square just in case
const square = async (px) =>
  sharp(SRC)
    .resize(px, px, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();

const base512 = await square(512);
await sharp(base512).resize(192, 192).png().toFile(join(ROOT, "public", "icon-192.png"));
await sharp(base512).png().toFile(join(ROOT, "public", "icon-512.png"));
await sharp(base512).resize(180, 180).png().toFile(join(ROOT, "public", "apple-touch-icon.png"));

// maskable: Android may crop up to ~24% from any edge — shrink the mark so
// the rose + C survive the circle mask, centered on the same white tile
const inner = Math.round(512 * 0.74);
const mark = await sharp(SRC).resize(inner, inner, { fit: "contain", background: "#ffffff" }).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 3, background: "#ffffff" } })
  .composite([{ input: mark, gravity: "center" }])
  .png()
  .toFile(join(ROOT, "public", "icon-512-maskable.png"));

console.log("icons written: 192, 512, apple-touch-180, 512-maskable");
