/**
 * The core's published test helpers against its `files`.
 *
 * @module
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { root } from "./packages.ts";
import {
  listedHelpers,
  strayHelpers,
  unlistedImports,
} from "./testing-files.ts";

test("a helper nobody listed is reported, whatever it is called", () => {
  const listed = listedHelpers(["dist/src", "test-utils/index.ts"]);

  expect(
    strayHelpers(
      [
        "package/test-utils/index.ts",
        "package/dist/test-utils/index.d.ts",
        "package/test-utils/fixtures.ts",
        "package/dist/test-utils/fixtures.d.ts.map",
        "package/src/index.ts",
      ],
      listed,
    ),
  ).toEqual([
    "package/test-utils/fixtures.ts",
    "package/dist/test-utils/fixtures.d.ts.map",
  ]);
});

test("a listed helper importing an unlisted one is reported", () => {
  const listed = new Set(["index", "server"]);

  expect(
    unlistedImports(
      new Map([
        ["index", 'export { serve } from "./server.ts";'],
        ["server", 'import { jar } from "./cookies.ts";'],
      ]),
      listed,
    ),
  ).toEqual(["server imports cookies"]);
});

test("the core lists what its testing entry needs, and only that", async () => {
  const core = join(root, "packages", "core");
  const manifest = (await Bun.file(join(core, "package.json")).json()) as {
    files: string[];
  };
  const listed = listedHelpers(manifest.files);
  const sources = new Map<string, string>();

  for (const name of listed) {
    sources.set(
      name,
      await Bun.file(join(core, "test-utils", `${name}.ts`)).text(),
    );
  }

  expect(listed.has("index")).toBe(true);
  expect(unlistedImports(sources, listed)).toEqual([]);
  expect(listed.has("types") || listed.has("socket")).toBe(false);
});
