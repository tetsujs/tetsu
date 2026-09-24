/**
 * The order packages are published in, and the version arithmetic a
 * release relies on.
 *
 * @module
 */

import { expect, test } from "bun:test";
import type { Package } from "./packages.ts";
import {
  compareVersions,
  inPublishOrder,
  publishedPackages,
} from "./packages.ts";

const pkg = (name: string, needs: string[] = []): Package => ({
  dir: `/packages/${name}`,
  name,
  version: "0.1.0",
  needs,
});

test("a package comes after the packages it needs", () => {
  const ordered = inPublishOrder([
    pkg("rate-limit", ["core", "openapi"]),
    pkg("openapi", ["core"]),
    pkg("cors", ["core"]),
    pkg("core"),
  ]);

  expect(ordered.map((p) => p.name)).toEqual([
    "core",
    "openapi",
    "rate-limit",
    "cors",
  ]);
});

test("a dependency from outside the repository does not hold a package back", () => {
  const ordered = inPublishOrder([
    pkg("typebox", ["core", "typebox-runtime"]),
    pkg("core"),
  ]);

  expect(ordered.map((p) => p.name)).toEqual(["core", "typebox"]);
});

test("a cycle is refused rather than guessed", () => {
  expect(() => inPublishOrder([pkg("a", ["b"]), pkg("b", ["a"])])).toThrow(
    "cycle: a, b",
  );
});

test("this repository publishes the core first and openapi before rate-limit", async () => {
  const names = (await publishedPackages()).map((p) => p.name);

  expect(names[0]).toBe("@tetsujs/core");
  expect(names.indexOf("@tetsujs/openapi")).toBeLessThan(
    names.indexOf("@tetsujs/rate-limit"),
  );
  expect(names).toHaveLength(9);
});

test("every published package shares one version", async () => {
  const versions = new Set((await publishedPackages()).map((p) => p.version));

  expect(versions.size).toBe(1);
});

test("versions compare part by part, as numbers", () => {
  expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
  expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("11.5.0", "11.5.1")).toBeLessThan(0);
});
