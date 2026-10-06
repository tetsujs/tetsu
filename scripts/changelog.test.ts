/**
 * The changelog as a release stamps and reads it.
 *
 * @module
 */

import { expect, test } from "bun:test";
import {
  releaseNotes,
  releaseSection,
  stampRelease,
  unwrapped,
} from "./changelog.ts";

const changelog = `# Changelog

Intro.

## Unreleased

- a new thing
- a fix

## 0.1.0 — 2026-09-24

First release.
`;

test("stamping turns Unreleased into the version and its date", () => {
  const stamped = stampRelease(changelog, "0.2.0", "2026-10-01");

  expect(stamped).toContain("## 0.2.0 — 2026-10-01\n\n- a new thing");
  expect(stamped).not.toContain("## Unreleased");
  expect(stamped).toContain("## 0.1.0 — 2026-09-24");
});

test("stamping refuses a changelog with nothing unreleased", () => {
  const empty = changelog.replace("- a new thing\n- a fix\n", "");

  expect(() => stampRelease(empty, "0.2.0", "2026-10-01")).toThrow(
    "no entries",
  );
  expect(() =>
    stampRelease(changelog.replace("## Unreleased", ""), "0.2.0", "2026-10-01"),
  ).toThrow("no entries");
});

test("stamping refuses a version the changelog already has", () => {
  expect(() => stampRelease(changelog, "0.1.0", "2026-10-01")).toThrow(
    "already has a section for 0.1.0",
  );
});

test("a section is its entries, without the heading or the next section", () => {
  expect(releaseSection(changelog, "Unreleased")).toBe(
    "- a new thing\n- a fix",
  );
  expect(releaseSection(changelog, "0.1.0")).toBe("First release.");
});

test("a version is matched whole", () => {
  expect(releaseSection(changelog, "0.1")).toBeUndefined();
  expect(releaseSection(changelog, "0.1.0-beta")).toBeUndefined();
  expect(releaseSection(changelog, "0x1x0")).toBeUndefined();
});

test("the notes of a release link every change since the one before", () => {
  const released = stampRelease(changelog, "0.2.0", "2026-09-25");

  expect(
    releaseNotes(released, "0.2.0", "https://github.com/tetsujs/tetsu"),
  ).toBe(
    "- a new thing\n- a fix\n\n**Full Changelog**: https://github.com/tetsujs/tetsu/compare/v0.1.0...v0.2.0",
  );
});

test("the first release has nothing before it to compare with", () => {
  expect(
    releaseNotes(changelog, "0.1.0", "https://github.com/tetsujs/tetsu"),
  ).toBe("First release.");
});

test("the notes join the lines of a wrapped entry, which a release would break", () => {
  const wrapped = `# Changelog

## 0.2.0 — 2026-10-07

### Added

- \`@tetsujs/static\`: serves the files of a directory, a built site or
  assets, inside the pipeline.
- A list inside an entry:
  - one item, wrapped
    over two lines;
  - another.

### Changed
Right under its heading.
### Fixed

A paragraph, wrapped
over two lines.

A second paragraph.

\`\`\`ts
const kept = "as it is";
  indented(code);
\`\`\`

## 0.1.0 — 2026-09-24

First release.
`;

  expect(
    releaseNotes(wrapped, "0.2.0", "https://github.com/tetsujs/tetsu"),
  ).toBe(`### Added

- \`@tetsujs/static\`: serves the files of a directory, a built site or assets, inside the pipeline.
- A list inside an entry:
  - one item, wrapped over two lines;
  - another.

### Changed
Right under its heading.
### Fixed

A paragraph, wrapped over two lines.

A second paragraph.

\`\`\`ts
const kept = "as it is";
  indented(code);
\`\`\`

**Full Changelog**: https://github.com/tetsujs/tetsu/compare/v0.1.0...v0.2.0`);
});

test("the notes leave alone the blocks a line does not join", () => {
  const blocks = [
    "~~~ts",
    "const a = 1;",
    "const b = 2;",
    "~~~",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "> one line,",
    "> and another.",
    "",
    "1) first",
    "2) second",
    "",
    "A line ends in a break\\",
    "and the next stays.",
    "",
    "A title",
    "---",
    "",
    "Fixed in the issue",
    "#42, which a line may begin with.",
  ].join("\n");

  expect(unwrapped(blocks)).toBe(blocks.replace("issue\n#42", "issue #42"));
});
