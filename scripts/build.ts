/**
 * Bundles each package's JavaScript into one file per entry point.
 *
 * `tsc -b` writes the declarations; this writes the code. One file instead
 * of a module per source file because Bun's loader costs about a quarter
 * of a megabyte resident per module: the core as twenty modules took
 * 18–20 MB idle, bundled 13.5 MB, and imported half a millisecond faster.
 *
 * A package's entry points are bundled in one call with code splitting, so
 * what they share lands in one chunk they both import. Built apart, the
 * core's `testing` entry would carry a second copy of the core — its own
 * route brand, its own classes — and nothing built with one copy would be
 * recognized by the other.
 *
 * Every other package is external: `@tetsujs/core` in `cors` stays an
 * import of the core, and TypeBox stays the application's. `@tetsujs/*`
 * is named outright, because `packages: "external"` alone does not hold
 * here: the repository's `paths` resolve those imports to source files,
 * which the bundler then inlines — and a `typebox` carrying its own copy
 * of the core's `ValidationError` throws errors the core does not
 * recognize.
 *
 * Run through `bun run build`, after `tsc -b`.
 *
 * @module
 */

import { readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Glob } from "bun";

const root = join(import.meta.dir, "..");
const packages = join(root, "packages");

/** Entry points per package, relative to the package directory. */
function entries(name: string): string[] {
  return name === "core"
    ? ["src/index.ts", "test-utils/index.ts"]
    : ["src/index.ts"];
}

/**
 * Removes the JavaScript an earlier build left behind — a module-per-file
 * emit would otherwise be packed next to the bundle — and keeps the
 * declarations `tsc -b` just wrote.
 */
async function clearJavaScript(dist: string): Promise<void> {
  for await (const file of new Glob("**/*.{js,js.map}").scan(dist)) {
    await rm(join(dist, file));
  }
}

/**
 * The source files a package's bundles were built from that lie outside
 * the package, read from the source maps — each one a copy of another
 * package's code, which the `external` list exists to prevent.
 *
 * Bun writes a map's `sources` relative to the output directory, not to
 * the map itself, so that is what they are resolved against.
 */
async function foreignSources(directory: string): Promise<string[]> {
  const dist = join(directory, "dist");
  const foreign: string[] = [];

  for await (const file of new Glob("**/*.js.map").scan(dist)) {
    const map = (await Bun.file(join(dist, file)).json()) as {
      sources: string[];
    };

    for (const source of map.sources) {
      const path = resolve(dist, source);

      if (!path.startsWith(directory + sep)) {
        foreign.push(path);
      }
    }
  }

  return foreign;
}

let failed = false;

for (const name of await readdir(packages)) {
  const directory = join(packages, name);
  const dist = join(directory, "dist");

  await clearJavaScript(dist);

  const result = await Bun.build({
    entrypoints: entries(name).map((entry) => join(directory, entry)),
    root: directory,
    outdir: dist,
    target: "bun",
    format: "esm",
    splitting: true,
    packages: "external",
    external: ["@tetsujs/*"],
    sourcemap: "linked",
    naming: {
      entry: "[dir]/[name].[ext]",
      chunk: "[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    failed = true;
    console.error(`packages/${name}:`, ...result.logs);

    continue;
  }

  const foreign = await foreignSources(directory);

  if (foreign.length > 0) {
    failed = true;
    console.error(
      `packages/${name} bundles code that is not its own:\n  ${foreign.join("\n  ")}`,
    );
  }
}

if (failed) {
  process.exit(1);
}
