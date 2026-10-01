/**
 * Draws the home-screen icon, `public/apple-touch-icon.png`, from the
 * logo's mark: the whole oni with its club on the dark background of the
 * social preview. iOS rounds the corners itself and fills transparency with
 * black, so the background is solid.
 *
 * ```sh
 * bun scripts/touch-icon.ts
 * ```
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import sharp from "sharp";

const size = 180;
const art = size * 0.86;
const offset = (size - art) / 2;

const mark = await Bun.file(
  new URL("../src/assets/logo/tetsu-mark.svg", import.meta.url),
).text();
const viewBox = /viewBox="([^"]+)"/.exec(mark)?.[1];
const body = mark.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#131418"/>
  <svg x="${offset}" y="${offset}" width="${art}" height="${art}" viewBox="${viewBox}">${body}</svg>
</svg>`;

await sharp(Buffer.from(svg))
  .png()
  .toFile(
    fileURLToPath(new URL("../public/apple-touch-icon.png", import.meta.url)),
  );

console.log("public/apple-touch-icon.png");
