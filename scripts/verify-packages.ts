/**
 * Checks every package as the tarball a user would install.
 *
 * Each package is packed once — `prepack` builds it first — and the same
 * bytes go to both tools: `publint` for the manifest (`exports`, `files`,
 * fields that point at nothing), and `attw` for whether TypeScript finds
 * the types through `exports` under the resolution modes that can load an
 * ES module. The `esm-only` profile leaves out `node10` and `require()`,
 * which an ESM-only package does not serve by design. Every tarball must
 * also carry a `LICENSE`: npm packs the one in the package's own folder,
 * not the repository's, so a new package without its copy would be
 * published unlicensed.
 *
 * Then the tarballs are installed together into a fresh project outside the
 * repository — the consumer — where neither `paths` nor the workspace can
 * stand in for what was packed:
 *
 * - `bun install` takes every tarball at once. `bun pm pack` turns
 *   `workspace:*` into the bare version, and with the packages unpublished
 *   Bun looks that version up in the registry and fails; `overrides` point
 *   each of the packages' names at its tarball, as a user installing
 *   tarballs would have to.
 * - One core: `@tetsujs/core` resolves to the same file from every
 *   package, or `instanceof HttpError` and the `onMount` symbol would stop
 *   meaning anything across them.
 * - A smoke script imports every entry point and serves one request.
 * - `tsc` checks the smoke script with `skipLibCheck` off, under `bundler`
 *   and `nodenext`, so every published `.d.ts` is compiled as a user's
 *   compiler sees it. `@types/bun` is installed, because the declarations
 *   name the platform's types as they are; a `@ts-expect-error` on an
 *   undeclared path parameter fails if inference through `dist` has
 *   decayed to `any`.
 *
 * The consumer's own dependencies (`@types/bun`, peer dependencies) come
 * from the registry. Run with `bun run verify:packages`.
 *
 * `--typescript <version>` checks the consumer with that compiler instead
 * of the repository's, which is how CI holds the published declarations
 * to the oldest TypeScript the README promises. Only the check changes:
 * the packages are still built by the compiler the repository pins, as
 * they are when published.
 *
 * @module
 */

import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

type Manifest = {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = join(import.meta.dir, "..");

const { values: flags } = parseArgs({
  options: { typescript: { type: "string" } },
});

const tsc = flags.typescript
  ? ["bunx", "-p", `typescript@${flags.typescript}`, "tsc"]
  : [join(root, "node_modules", ".bin", "tsc")];

const packs = await mkdtemp(join(tmpdir(), "tetsu-packs-"));
const consumer = await mkdtemp(join(tmpdir(), "tetsu-consumer-"));

const rootManifest: Manifest = await Bun.file(
  join(root, "package.json"),
).json();

let failed = false;

try {
  const manifests: Manifest[] = [];

  for (const directory of await readdir(join(root, "packages"))) {
    const cwd = join(root, "packages", directory);

    await $`bun pm pack --destination ${packs} --quiet`.cwd(cwd).quiet();
    manifests.push(await Bun.file(join(cwd, "package.json")).json());
  }

  for (const tarball of await readdir(packs)) {
    const path = join(packs, tarball);

    const publint = await $`publint ${path} --strict`.nothrow();
    const attw =
      await $`attw ${path} --profile esm-only --format table-flipped`.nothrow();

    if (publint.exitCode !== 0 || attw.exitCode !== 0) {
      failed = true;
    }

    const contents = await $`tar -tzf ${path}`.text();

    if (!contents.split("\n").includes("package/LICENSE")) {
      console.error(`${tarball} carries no LICENSE`);

      failed = true;
    }
  }

  if (!(await verifyConsumer(manifests))) {
    failed = true;
  }
} finally {
  await rm(packs, { recursive: true, force: true });
  await rm(consumer, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}

/**
 * Installs every tarball into the consumer, then runs its checks in order;
 * `false` at the first one that fails, with that step's output printed.
 */
async function verifyConsumer(manifests: Manifest[]): Promise<boolean> {
  await writeConsumer(manifests);

  const install = await $`bun install`.cwd(consumer).nothrow().quiet();

  if (install.exitCode !== 0) {
    return report("bun install", install);
  }

  if (!(await hasOneCore(manifests))) {
    return false;
  }

  const smoke = await $`bun smoke.ts`.cwd(consumer).nothrow().quiet();

  if (smoke.exitCode !== 0) {
    return report("smoke", smoke);
  }

  for (const mode of ["bundler", "nodenext"]) {
    const check = await $`${tsc} -p tsconfig.${mode}.json`
      .cwd(consumer)
      .nothrow()
      .quiet();

    if (check.exitCode !== 0) {
      return report(`tsc (${mode})`, check);
    }
  }

  const compiler = await $`${tsc} --version`.cwd(consumer).text();

  console.log(
    `consumer: installed, one core, smoke served, clean under ${compiler.trim()}`,
  );

  return true;
}

/**
 * The consumer's manifest, one `tsconfig` per resolution mode, and the
 * smoke script that imports every entry point of every package.
 */
async function writeConsumer(manifests: Manifest[]): Promise<void> {
  const tarballs: Record<string, string> = {};
  const peers: Record<string, string> = {};

  for (const manifest of manifests) {
    const file = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;

    tarballs[manifest.name] = `file:${join(packs, file)}`;
    Object.assign(peers, manifest.peerDependencies);
  }

  for (const name of Object.keys(tarballs)) {
    delete peers[name];
  }

  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
      dependencies: { ...tarballs, ...peers },
      devDependencies: {
        "@types/bun": rootManifest.devDependencies?.["@types/bun"],
      },
      overrides: tarballs,
    }),
  );

  const modes = {
    bundler: { module: "preserve", moduleResolution: "bundler" },
    nodenext: { module: "nodenext", moduleResolution: "nodenext" },
  };

  for (const [mode, resolution] of Object.entries(modes)) {
    await Bun.write(
      join(consumer, `tsconfig.${mode}.json`),
      JSON.stringify({
        compilerOptions: {
          ...resolution,
          target: "esnext",
          lib: ["esnext"],
          types: ["bun"],
          strict: true,
          skipLibCheck: false,
          verbatimModuleSyntax: true,
          noEmit: true,
        },
        files: ["smoke.ts"],
      }),
    );
  }

  const specifiers = manifests.flatMap((manifest) =>
    Object.keys(manifest.exports).map(
      (subpath) => manifest.name + subpath.slice(1),
    ),
  );

  await Bun.write(join(consumer, "smoke.ts"), smokeScript(specifiers));
}

/**
 * Imports every specifier, checks each exports something, and serves once
 * with every hook package mounted the way an application mounts it — so
 * the published declarations are checked against the form users write,
 * a hook per slot, not only imported.
 */
function smokeScript(specifiers: string[]): string {
  const binding = (specifier: string) =>
    `entry_${specifier.replace(/\W/g, "_")}`;

  const imports = specifiers.map(
    (specifier) => `import * as ${binding(specifier)} from "${specifier}";`,
  );

  const entries = specifiers.map(
    (specifier) => `  ["${specifier}", ${binding(specifier)}],`,
  );

  return `${imports.join("\n")}

const entries: [string, object][] = [
${entries.join("\n")}
];

for (const [specifier, namespace] of entries) {
  if (Object.keys(namespace).length === 0) {
    throw new Error(\`\${specifier} exports nothing\`);
  }
}

const { createApp, hook, route } = entry__tetsujs_core;
const { cors } = entry__tetsujs_cors;
const { rateLimit } = entry__tetsujs_rate_limit;
const { accessLog, requestId } = entry__tetsujs_request_id;
const { secureHeaders } = entry__tetsujs_secure_headers;

const browser = cors({ origin: "https://app.example.com" });
const id = requestId();
const limit = rateLimit({ limit: 100, windowMs: 60_000, key: () => "all" });
const headers = secureHeaders();
const lines: unknown[] = [];
const log = accessLog({ write: (record) => lines.push(record) });

const scope = hook.beforeParse((ctx: entry__tetsujs_core.Requires<{ requestId: string }>) => {
  void ctx.requestId;
});

class HelloController {
  greet = route({
    method: "GET",
    path: "/hello/:name",
    handler: (ctx) => {
      // @ts-expect-error — the path declares no :id
      ctx.params.id;

      return { hello: ctx.params.name };
    },
  });
}

const server = Bun.serve({
  ...createApp({
    hooks: {
      beforeParse: [browser, id, scope, limit],
      beforeResponse: [headers],
      afterResponse: [log],
    },
    routes: new HelloController(),
  }),
  port: 0,
});

try {
  const response = await fetch(new URL("/hello/ada", server.url));
  const body = await response.text();

  if (body !== '{"hello":"ada"}') {
    throw new Error(\`unexpected response: \${response.status} \${body}\`);
  }

  if (!response.headers.get("x-request-id") || !response.headers.get("x-content-type-options")) {
    throw new Error("the mounted hooks did not run");
  }
} finally {
  server.stop(true);
}
`;
}

/**
 * Whether `@tetsujs/core` resolves to one file from the consumer and from
 * every installed package that depends on it — as a peer, which is how the
 * packages declare it, or as a dependency, which is how a second copy would
 * get in.
 */
async function hasOneCore(manifests: Manifest[]): Promise<boolean> {
  const core = "@tetsujs/core";
  const expected = await realpath(Bun.resolveSync(core, consumer));

  for (const manifest of manifests) {
    if (!manifest.peerDependencies?.[core] && !manifest.dependencies?.[core]) {
      continue;
    }

    const directory = await realpath(
      join(consumer, "node_modules", manifest.name),
    );
    const actual = await realpath(Bun.resolveSync(core, directory));

    if (actual !== expected) {
      console.error(`${manifest.name} loads a second core: ${actual}`);

      return false;
    }
  }

  return true;
}

/** Prints what a failed consumer step said, and fails the step. */
function report(step: string, output: $.ShellOutput): false {
  console.error(`consumer: ${step} failed\n`);
  console.error(output.stdout.toString());
  console.error(output.stderr.toString());

  return false;
}
