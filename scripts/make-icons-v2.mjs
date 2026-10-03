/**
 * Regenerate PWA icons from the user-uploaded chibi artwork (2026-09 request).
 *
 * Source: upload/7033ebc843b270774b1cb13b746a3580.jpg — 736×736 chibi
 * character on a painted background. Full-bleed for the regular icons; the
 * maskable variant keeps the whole character inside Android's ~80% safe zone
 * by floating it over a blurred, darkened copy of its own background.
 *
 * Outputs (public/):
 *   icon-192.png           regular icon, full-bleed
 *   icon-512.png           regular icon
 *   apple-touch-icon.png   180px iOS home-screen icon
 *   icon-512-maskable.png  character in safe zone over blurred self-backdrop
 */
import sharp from "sharp";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "upload", "7033ebc843b270774b1cb13b746a3580.jpg");

// full-bleed squares (source is already square; cover just normalizes)
for (const [px, name] of [
  [512, "icon-512.png"],
  [192, "icon-192.png"],
  [180, "apple-touch-icon.png"],
]) {
  await sharp(SRC).resize(px, px, { fit: "cover", position: "centre" }).png().toFile(join(ROOT, "public", name));
}

// maskable: Android may crop up to ~24% from any edge. Backdrop = the same
// art scaled to fill + blurred + slightly darkened; foreground = whole art at
// 84% so the face/ears survive any circular mask without white bars.
const FG = Math.round(512 * 0.84);
const R = Math.round(FG * 0.16);
const backdrop = await sharp(SRC)
  .resize(512, 512, { fit: "cover" })
  .blur(22)
  .modulate({ brightness: 0.62, saturation: 0.9 })
  .png()
  .toBuffer();
// rounded-corner foreground tile so circle masks crop into the blur, not the art
const rounded = Buffer.from(
  `<svg width="${FG}" height="${FG}"><rect x="0" y="0" width="${FG}" height="${FG}" rx="${R}" ry="${R}"/></svg>`,
);
const fg = await sharp(SRC)
  .resize(FG, FG, { fit: "contain", background: "rgba(0,0,0,0)" })
  .composite([{ input: rounded, blend: "dest-in" }])
  .png()
  .toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "rgba(0,0,0,1)" } })
  .composite([
    { input: backdrop, gravity: "center" },
    { input: fg, gravity: "center" },
  ])
  .png()
  .toFile(join(ROOT, "public", "icon-512-maskable.png"));

console.log("icons written: 192, 512, apple-touch-180, 512-maskable (chibi v2)");
