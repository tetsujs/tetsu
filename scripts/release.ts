/**
 * Prepares a release: every package's version, the changelog, the lock.
 *
 * ```bash
 * bun run release 0.2.0
 * ```
 *
 * All packages share one version, so all of them move together, published
 * or not changed: a user reads one number for the whole framework, and a
 * package that imports something new from the core cannot go out next to
 * a core that lacks it. `## Unreleased` becomes the version and today's
 * date, and `bun.lock`, which records the workspace's versions, follows.
 *
 * Nothing is committed, tagged or published here. The result is a change
 * like any other, reviewed in a pull request; the tag on its merge commit
 * is what publishes, from CI (`.github/workflows/release.yml`).
 *
 * @module
 */

import { join } from "node:path";
import { $ } from "bun";
import { changelogPath, stampRelease } from "./changelog.ts";
import { compareVersions, publishedPackages, root } from "./packages.ts";

const version = process.argv[2];

if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run release <major.minor.patch>");
  process.exit(1);
}

const packages = await publishedPackages();
const current = new Set(packages.map((pkg) => pkg.version));

if (current.size !== 1) {
  console.error(
    `the packages disagree on their version (${[...current].join(", ")}) — they are released together`,
  );
  process.exit(1);
}

const [previous = ""] = current;

if (compareVersions(version, previous) <= 0) {
  console.error(`${version} does not come after ${previous}`);
  process.exit(1);
}

const dirty = await $`git status --porcelain`.cwd(root).text();

if (dirty.trim() !== "") {
  console.error("the working tree has changes — release from a clean one");
  process.exit(1);
}

const changelog = await Bun.file(changelogPath).text();
const date = new Date().toISOString().slice(0, 10);

await Bun.write(changelogPath, stampRelease(changelog, version, date));

for (const pkg of packages) {
  const path = join(pkg.dir, "package.json");
  const manifest = await Bun.file(path).text();

  await Bun.write(
    path,
    manifest.replace(`"version": "${previous}"`, `"version": "${version}"`),
  );
}

await $`bun install`.cwd(root).quiet();

console.log(`${packages.length} packages: ${previous} → ${version}`);
console.log(`CHANGELOG.md: ## ${version} — ${date}`);
console.log(
  `next: a pull request "release ${version}"; once merged, tag its commit v${version} and push the tag`,
);
