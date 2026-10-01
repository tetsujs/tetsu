/**
 * Draws the social preview image, `public/og.png`, from the logo's own
 * files: the mark, the wordmark in curves, and the line under them.
 *
 * ```sh
 * bun scripts/og.ts
 * ```
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import sharp from "sharp";

const width = 1200;
const height = 630;

const inner = async (path: string) => {
  const svg = await Bun.file(new URL(path, import.meta.url)).text();
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");

  return { viewBox, body };
};

const mark = await inner("../src/assets/logo/tetsu-mark.svg");
const wordmark = await inner("../src/assets/logo/tetsu-wordmark-dark.svg");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#131418"/>
  <rect x="0" y="${height - 12}" width="${width}" height="12" fill="#CE0B18"/>
  <svg x="90" y="135" width="340" height="340" viewBox="${mark.viewBox}">${mark.body}</svg>
  <svg x="490" y="190" width="560" height="150" viewBox="${wordmark.viewBox}" preserveAspectRatio="xMinYMid meet">${wordmark.body}</svg>
  <text x="496" y="410" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="52" font-weight="700" fill="#F0F3F6">No magic. Just iron.</text>
  <text x="498" y="470" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" fill="#9AA0AA">HTTP framework for Bun</text>
</svg>`;

await sharp(Buffer.from(svg))
  .png()
  .toFile(fileURLToPath(new URL("../public/og.png", import.meta.url)));

console.log("public/og.png");
