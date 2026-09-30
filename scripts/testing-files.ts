/**
 * Which of the core's test helpers are published, and whether a tarball
 * carries only those.
 *
 * `packages/core/test-utils` holds two kinds of file: the helpers
 * `@tetsujs/core/testing` exports — `serve()`, the client, `testCtx()` —
 * and the ones only this repository's tests use. The package's `files`
 * lists the first kind by name, so a helper added to the folder stays out
 * of the tarball until someone decides it is public; this module holds the
 * tarball to that list. It used to be the other way round — the folder,
 * minus three internal names — and a fourth internal helper would have
 * been published with nothing to notice.
 *
 * @module
 */

/** The helpers a package's `files` publishes, by name: `server`, `client`. */
export function listedHelpers(files: readonly string[]): Set<string> {
  const listed = new Set<string>();

  for (const entry of files) {
    const name = /^test-utils\/([\w-]+)\.ts$/.exec(entry)?.[1];

    if (name !== undefined) {
      listed.add(name);
    }
  }

  return listed;
}

/**
 * The tarball entries under `test-utils` — sources and declarations — that
 * belong to no listed helper.
 */
export function strayHelpers(
  entries: readonly string[],
  listed: ReadonlySet<string>,
): string[] {
  return entries.filter((entry) => {
    const name = /^package\/(?:dist\/)?test-utils\/([\w-]+)\./.exec(entry)?.[1];

    return name !== undefined && !listed.has(name);
  });
}

/**
 * The helpers a listed helper imports that are not listed themselves —
 * what the published `testing` entry would fail to load.
 */
export function unlistedImports(
  sources: ReadonlyMap<string, string>,
  listed: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];

  for (const [name, source] of sources) {
    for (const match of source.matchAll(/from "\.\/([\w-]+)\.ts"/g)) {
      const imported = match[1] as string;

      if (!listed.has(imported)) {
        missing.push(`${name} imports ${imported}`);
      }
    }
  }

  return missing;
}
