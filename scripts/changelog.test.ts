/**
 * The changelog as a release stamps and reads it.
 *
 * @module
 */

import { expect, test } from "bun:test";
import { releaseSection, stampRelease } from "./changelog.ts";

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
