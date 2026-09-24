/**
 * Publishes every package at one version, in dependency order.
 *
 * ```bash
 * bun run scripts/publish.ts 0.2.0            # what the release workflow runs
 * bun run scripts/publish.ts 0.2.0 --dry-run  # everything but the upload
 * ```
 *
 * Written for the release workflow, which authenticates to npm through
 * trusted publishing — an OIDC token GitHub issues to that one workflow,
 * so no npm token exists anywhere to leak — and gets provenance for every
 * version with it. That is npm's feature, and only its CLI speaks it:
 * `bun publish` authenticates with a token alone. So each package is
 * packed by Bun, which turns `workspace:^` into the version range a user
 * installs, and the tarball is published by npm.
 *
 * Safe to run again. A package already in the registry at this version is
 * skipped, so a release that failed half-way — the registry refused one
 * package, the runner died — is finished by re-running the workflow, not
 * repaired by hand.
 *
 * @module
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { changelogPath, releaseSection } from "./changelog.ts";
import { compareVersions, publishedPackages, root } from "./packages.ts";

/** Trusted publishing needs this npm or later. */
const minimumNpm = "11.5.1";

const version = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run scripts/publish.ts <version> [--dry-run]");
  process.exit(1);
}

const packages = await publishedPackages();
const mismatched = packages.filter((pkg) => pkg.version !== version);

if (mismatched.length > 0) {
  console.error(
    `not at ${version}: ${mismatched.map((pkg) => `${pkg.name} ${pkg.version}`).join(", ")} — run \`bun run release ${version}\` first`,
  );
  process.exit(1);
}

if (
  releaseSection(await Bun.file(changelogPath).text(), version) === undefined
) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

const npm = (await $`npm --version`.text()).trim();

if (compareVersions(npm, minimumNpm) < 0) {
  console.error(
    `npm ${npm} cannot publish through trusted publishing; ${minimumNpm} or later can`,
  );
  process.exit(1);
}

await $`bun run build`.cwd(root);

const packs = await mkdtemp(join(tmpdir(), "tetsu-publish-"));

try {
  for (const pkg of packages) {
    if (await isPublished(pkg.name, version)) {
      console.log(`${pkg.name}@${version}: already published, skipped`);

      continue;
    }

    const packed =
      await $`bun pm pack --ignore-scripts --destination ${packs} --quiet`
        .cwd(pkg.dir)
        .text();
    const tarball = packed.trim().split("\n").at(-1) ?? "";

    const flags = dryRun ? ["--dry-run"] : [];

    await $`npm publish ${tarball} --access public ${flags}`.cwd(pkg.dir);

    console.log(
      `${pkg.name}@${version}: ${dryRun ? "would be published" : "published"}`,
    );
  }
} finally {
  await rm(packs, { recursive: true, force: true });
}

/**
 * Whether the registry already has this version. `npm view` fails for a
 * version it does not know, and for a package it does not know.
 */
async function isPublished(name: string, at: string): Promise<boolean> {
  const view = await $`npm view ${`${name}@${at}`} version`.nothrow().quiet();

  return view.exitCode === 0 && view.stdout.toString().trim() === at;
}
