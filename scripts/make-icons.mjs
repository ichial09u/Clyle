/**
 * Generate PWA icons from public/logo.svg with sharp (already a dependency).
 * Outputs: public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png
 * (apple-touch-icon is a 180px iOS home-screen icon on a black rounded tile)
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const svg = readFileSync(join(ROOT, "public", "logo.svg"), "utf8");

// Pad the 30x30 logo onto a black tile so maskable/home-screen crops look right
const tile = (px, padRatio = 0.16) => {
  const pad = Math.round(px * padRatio);
  const inner = px - pad * 2;
  return Buffer.from(
    `<svg width="${px}" height="${px}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${px}" height="${px}" fill="#000000"/>
       <g transform="translate(${pad},${pad}) scale(${inner / 30})">${svg.replace(/<\?xml[^>]*\?>/, "")}</g>
     </svg>`,
  );
};

await sharp(tile(192)).png().toFile(join(ROOT, "public", "icon-192.png"));
await sharp(tile(512)).png().toFile(join(ROOT, "public", "icon-512.png"));
await sharp(tile(180)).png().toFile(join(ROOT, "public", "apple-touch-icon.png"));
console.log("icons written: 192, 512, apple-touch-180");
