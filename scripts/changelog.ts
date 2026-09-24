/**
 * The changelog as a release reads and writes it.
 *
 * Changes are written under `## Unreleased` in the pull request that makes
 * them. A release turns that heading into the version and its date, and
 * the GitHub release carries the same section, word for word — one text,
 * written once, where the change was made.
 *
 * Run `bun run scripts/changelog.ts 0.2.0` to print a released version's
 * section, which is how the release workflow gets its notes.
 *
 * @module
 */

import { join } from "node:path";

export const changelogPath = join(import.meta.dir, "..", "CHANGELOG.md");

const unreleased = "## Unreleased";

/**
 * Turns `## Unreleased` into `## <version> — <date>`.
 *
 * Refuses a changelog with nothing unreleased — a release with no entry is
 * either a mistake or a release nobody can read about — and a version the
 * changelog already has.
 */
export function stampRelease(
  changelog: string,
  version: string,
  date: string,
): string {
  if (sectionStart(changelog, version) !== -1) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }

  const body = releaseSection(changelog, "Unreleased");

  if (body === undefined || body === "") {
    throw new Error(
      `CHANGELOG.md has no entries under "${unreleased}" — write them before releasing`,
    );
  }

  return changelog.replace(unreleased, `## ${version} — ${date}`);
}

/**
 * The entries of one section, without its heading: everything between the
 * version's heading and the next one. `undefined` when there is none.
 */
export function releaseSection(
  changelog: string,
  version: string,
): string | undefined {
  const start = sectionStart(changelog, version);

  if (start === -1) {
    return undefined;
  }

  const afterHeading = changelog.indexOf("\n", start) + 1;
  const next = changelog.indexOf("\n## ", afterHeading);
  const end = next === -1 ? changelog.length : next;

  return changelog.slice(afterHeading, end).trim();
}

/**
 * Where a version's heading starts. A released heading is followed by a
 * date, `Unreleased` by nothing; both are matched whole, so `0.1.0` does
 * not find `0.1.0-beta`.
 */
function sectionStart(changelog: string, version: string): number {
  const heading = new RegExp(`^## ${literal(version)}( — .*)?$`, "m");

  return changelog.search(heading);
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.main) {
  const version = process.argv[2];

  if (version === undefined) {
    console.error("usage: bun run scripts/changelog.ts <version>");
    process.exit(1);
  }

  const section = releaseSection(await Bun.file(changelogPath).text(), version);

  if (section === undefined) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }

  console.log(section);
}
