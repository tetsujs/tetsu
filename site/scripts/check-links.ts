/**
 * Checks every link inside the built site: the page it points at exists,
 * and so does the heading its anchor names. Runs after `astro build`.
 *
 * @module
 */

import { Glob } from "bun";

const dist = new URL("../dist/", import.meta.url).pathname;

const pages = new Map<string, Set<string>>();

for await (const file of new Glob("**/*.html").scan(dist)) {
  const html = await Bun.file(dist + file).text();
  const ids = new Set(
    [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
  const path = `/${file.replace(/index\.html$/, "").replace(/\.html$/, "/")}`;

  pages.set(path, ids);
}

const exists = async (path: string) =>
  pages.has(path) || (await Bun.file(dist + path.slice(1)).exists());

const broken: string[] = [];

for (const page of pages.keys()) {
  const file = page === "/404/" ? "404.html" : `${page.slice(1)}index.html`;
  const html = await Bun.file(dist + file).text();

  for (const [, href = ""] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (!href.startsWith("/") || href.startsWith("//")) continue;

    const [target = "", anchor] = href.split("#");
    const path = target.split("?")[0] ?? "";

    if (!(await exists(path))) {
      broken.push(`${page} → ${href} (no page)`);
    } else if (
      anchor &&
      pages.has(path) &&
      !pages.get(path)?.has(decodeURIComponent(anchor))
    ) {
      broken.push(`${page} → ${href} (no heading)`);
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
