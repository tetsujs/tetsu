/**
 * The core's README is the repository's, with links that work from its
 * folder.
 *
 * @module
 */

import { expect, test } from "bun:test";
import { coreReadme, coreReadmePath } from "./readme.ts";

test("the core's README matches the root README — run `bun run readme`", async () => {
  expect(await Bun.file(coreReadmePath).text()).toBe(await coreReadme());
});

test("no link in it is relative to a folder it is not in", async () => {
  const relative = [...(await coreReadme()).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^([a-z]+:|#)/i.test(target));

  expect(relative).toEqual([]);
});
