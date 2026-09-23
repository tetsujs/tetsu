/**
 * Writes the core's README from the repository's.
 *
 * `@tetsujs/core` is the framework, so its page on npm should carry the
 * whole guide — and the guide lives in the repository's README, where
 * GitHub shows it first. One text, kept in one place: the core's copy is
 * generated, and a test fails when the committed copy has fallen behind.
 *
 * The copy cannot be verbatim. The root README links to `packages/sse`,
 * `bench` and `LICENSE` relative to the root; read from `packages/core`,
 * on GitHub or on npm, those links point at nothing. Every relative link
 * is rewritten to its address on GitHub; anchors within the page stay as
 * they are.
 *
 * Run with `bun run readme` after editing the root README.
 *
 * @module
 */

import { statSync } from "node:fs";
import { join } from "node:path";

const repository = "https://github.com/tetsujs/tetsu";

const root = join(import.meta.dir, "..");

/** Where the generated copy is written. */
export const coreReadmePath = join(root, "packages", "core", "README.md");

/** The core's README, as generated from the root README right now. */
export async function coreReadme(): Promise<string> {
  const source = await Bun.file(join(root, "README.md")).text();

  const linked = source.replace(
    /\]\(([^)\s]+)\)/g,
    (_match, target: string) => `](${absolute(target) ?? target})`,
  );

  return `<!-- Generated from the repository's README.md by scripts/readme.ts: edit that one. -->\n\n${linked}`;
}

/**
 * A relative link's address on GitHub, or `undefined` for a link that is
 * already absolute or points within the page.
 *
 * GitHub serves a file under `blob` and a folder under `tree`; the path is
 * checked on disk to tell which.
 */
function absolute(target: string): string | undefined {
  if (/^([a-z]+:|#)/i.test(target)) {
    return undefined;
  }

  const [path = "", anchor] = target.split("#");
  const clean = path.replace(/^\.\//, "").replace(/\/$/, "");
  const kind = statSync(join(root, clean)).isDirectory() ? "tree" : "blob";

  return `${repository}/${kind}/main/${clean}${anchor ? `#${anchor}` : ""}`;
}

if (import.meta.main) {
  await Bun.write(coreReadmePath, await coreReadme());
}
