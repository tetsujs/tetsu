/**
 * The published packages, in the order they can be published.
 *
 * A package goes out after every package of this repository it depends on
 * — through `dependencies` or `peerDependencies` — so that nothing is ever
 * in the registry pointing at a version that is not there yet: the core
 * first, `@tetsujs/openapi` before `@tetsujs/rate-limit`, which depends on
 * it.
 *
 * @module
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const root = join(import.meta.dir, "..");

/** What a release needs to know about a package. */
export interface Package {
  /** The package's folder, absolute. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;

  /** The packages of this repository it needs published before it. */
  readonly needs: readonly string[];
}

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** Every package under `packages/` that is published, in publish order. */
export async function publishedPackages(): Promise<Package[]> {
  const found: Package[] = [];

  for (const folder of (await readdir(join(root, "packages"))).sort()) {
    const dir = join(root, "packages", folder);
    const manifest: Manifest = await Bun.file(join(dir, "package.json")).json();

    if (manifest.private) {
      continue;
    }

    found.push({
      dir,
      name: manifest.name,
      version: manifest.version,
      needs: Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      }),
    });
  }

  return inPublishOrder(found);
}

/**
 * Orders packages so each comes after the ones it needs, keeping the given
 * order otherwise. A cycle cannot be published in any order, so it is an
 * error rather than a guess.
 */
export function inPublishOrder(packages: readonly Package[]): Package[] {
  const names = new Set(packages.map((pkg) => pkg.name));
  const placed = new Set<string>();
  const ordered: Package[] = [];

  while (ordered.length < packages.length) {
    const next = packages.find(
      (pkg) =>
        !placed.has(pkg.name) &&
        pkg.needs.every((need) => !names.has(need) || placed.has(need)),
    );

    if (next === undefined) {
      const left = packages.filter((pkg) => !placed.has(pkg.name));

      throw new Error(
        `these packages depend on each other in a cycle: ${left.map((pkg) => pkg.name).join(", ")}`,
      );
    }

    placed.add(next.name);
    ordered.push(next);
  }

  return ordered;
}

/**
 * Compares two `major.minor.patch` versions: negative when `a` comes
 * first, positive when it comes after, zero when they are the same.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
