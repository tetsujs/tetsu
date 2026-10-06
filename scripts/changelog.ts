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
 * The notes of a GitHub release: the version's section, and a link to
 * every commit since the version before it — the one whose section comes
 * next. The first release has nothing to compare with, and no link.
 */
export function releaseNotes(
  changelog: string,
  version: string,
  repository: string,
): string | undefined {
  const section = releaseSection(changelog, version);

  if (section === undefined) {
    return undefined;
  }

  const start = sectionStart(changelog, version);
  const after = changelog.slice(changelog.indexOf("\n", start) + 1);
  const previous = /^## (\d+\.\d+\.\d+)/m.exec(after)?.[1];
  const notes = unwrapped(section);

  if (previous === undefined) {
    return notes;
  }

  return `${notes}\n\n**Full Changelog**: ${repository}/compare/v${previous}...v${version}`;
}

/**
 * Markdown with the lines of each paragraph and list item joined into one.
 *
 * The changelog is wrapped, which Markdown reads as one paragraph: GitHub
 * shows `CHANGELOG.md` as written. The text of a release is read as a
 * comment is, where every line break is kept, and an entry wrapped over
 * three lines showed as three.
 *
 * A line is joined to the one before when it continues it. It does not if
 * it starts a block of its own (a heading, an item, a quote, a table row,
 * HTML, a rule, a link definition), or if the line before ends one (blank,
 * a heading, a table row, HTML, a rule, a break written with two spaces or
 * a backslash). A block fenced with backticks or tildes stays as it is.
 * Indented code is not told apart from the lines of an item, and the
 * changelog fences its code.
 */
export function unwrapped(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;

  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];

    if (marker !== undefined && closes(fence, marker)) {
      fence = fence === undefined ? marker : undefined;
      lines.push(line);

      continue;
    }

    const previous = lines.at(-1);

    if (
      fence === undefined &&
      previous !== undefined &&
      continues(line) &&
      takesMore(previous)
    ) {
      lines[lines.length - 1] = `${previous} ${line.trim()}`;

      continue;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Whether a fence marker opens a block, outside one, or closes the one
 * `open` began: the same character, at least as many times.
 */
function closes(open: string | undefined, marker: string): boolean {
  return (
    open === undefined ||
    (marker[0] === open[0] && marker.length >= open.length)
  );
}

/** A line that starts a block of its own. */
const blockStart =
  /^(#{1,6}(\s|$)|[|><]|([-*+]|\d+[.)])\s|\[[^\]]+\]:|(-{3,}|\*{3,}|_{3,}|={3,})$)/;

/** A line after which a block has ended. */
const blockEnd = /^(#{1,6}(\s|$)|[|<]|(-{3,}|\*{3,}|_{3,}|={3,})$|`{3,}|~{3,})/;

/** Whether a line carries on the text of the one before it. */
function continues(line: string): boolean {
  const text = line.trim();

  return text !== "" && !blockStart.test(text);
}

/** Whether the text of a line may go on in the next one. */
function takesMore(line: string): boolean {
  const text = line.trim();

  return text !== "" && !blockEnd.test(text) && !/( {2}|\\)$/.test(line);
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

/**
 * The repository's address, as the core's manifest records it —
 * `git+https://github.com/tetsujs/tetsu.git` read as the page it names.
 */
async function repositoryUrl(): Promise<string> {
  const manifest = await Bun.file(
    join(import.meta.dir, "..", "packages", "core", "package.json"),
  ).json();

  return String(manifest.repository.url)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
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

  const notes = releaseNotes(
    await Bun.file(changelogPath).text(),
    version,
    await repositoryUrl(),
  );

  if (notes === undefined) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }

  console.log(notes);
}
