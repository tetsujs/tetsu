/**
 * Checks every link inside the built site: the page or file it points at
 * exists, and so does the heading its anchor names — on another page or on
 * the same one. Runs after `astro build`.
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import { Glob } from "bun";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
// The site's own address: an absolute link to it, like the canonical one, is
// checked as well.
const origin = "https://tetsujs.com";

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const pages = new Map<string, { html: string; ids: Set<string> }>();

for await (const file of new Glob("**/*.html").scan(dist)) {
  const html = await Bun.file(dist + file).text();
  const ids = new Set(
    [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
  const path = `/${file.replace(/index\.html$/, "").replace(/\.html$/, "/")}`;

  pages.set(path, { html, ids });
}

if (!pages.size) {
  console.log(`no pages in ${dist}: build the site first`);
  process.exit(1);
}

const exists = async (path: string) =>
  pages.has(path) || (await Bun.file(dist + path.slice(1)).exists());

const broken: string[] = [];

for (const [page, { html }] of pages) {
  for (const [, attribute, link = ""] of html.matchAll(
    /\s(href|src)="([^"]+)"/g,
  )) {
    const url = new URL(link.replaceAll("&amp;", "&"), origin + page);

    if (url.origin !== origin) continue;

    const path = decode(url.pathname);
    const anchor = attribute === "href" ? decode(url.hash.slice(1)) : "";

    if (!(await exists(path))) {
      broken.push(`${page} → ${link} (no page)`);
    } else if (anchor && pages.has(path) && !pages.get(path)?.ids.has(anchor)) {
      broken.push(`${page} → ${link} (no heading)`);
    }
  }
}

for (const line of new Set(broken)) console.log(line);

console.log(
  broken.length
    ? `\n${new Set(broken).size} broken link(s)`
    : "all links resolve",
);
process.exit(broken.length ? 1 : 0);
