/**
 * What the types cost: the compiler's work for an application of N routes.
 *
 * Every other benchmark here measures a request. This one measures the
 * other thing a user runs all day — the type checker, in `tsc` and in the
 * editor — because the framework's inference is a product, and a product
 * that takes the editor down is not one.
 *
 * It exists because that cost once went unmeasured. The context merge
 * spent about a hundred times the types it needed, the repository needed
 * 4 GB to check — at the edge of Node's heap, where the editor's language
 * server also lives — and a correctness fix doubled it without anyone
 * noticing, because nothing counted. `Merge` in `packages/core/src/stack.ts`
 * has the story.
 *
 * The application is generated: per controller — declared with
 * `controller()`, the form the README shows — a `GET` with `params`,
 * `query`, a status map and four hooks — one contributing, one reading
 * through `Requires`, and an observer and an error mapper reading an
 * optional field of the context the response and error slots see — and a
 * `POST` with a `body` and a status of its own;
 * all of it mounted by one `createApp`, either straight in or each
 * controller in a group of its own — see {@link Mounting}. It imports the core from `dist`,
 * the way a user's compiler reads it, so the core's own sources are not
 * part of the bill.
 *
 * Types and instantiations are deterministic for a given compiler, so
 * `--check` holds the 200-route count to a budget and fails CI when a
 * change exceeds it. Memory and time are printed for reading, not for
 * gating: they move with the machine.
 *
 * Run: `bun run --cwd bench types` (or `types --check`)
 *
 * @module
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..", "..");
const core = join(root, "packages", "core", "dist", "src", "index.js");
const tsc = join(root, "node_modules", ".bin", "tsc");

/** Route counts of the ladder; each controller holds two routes. */
const ladder = [2, 200, 800] as const;

/**
 * Instantiations the 200-route application may cost, on the compiler the
 * repository pins, mounted each way.
 *
 * Set a quarter above the last measured count (174 517, with controllers
 * declared by `controller()`; classes cost 198 615), which leaves room for
 * honest growth and none for the doubling a careless type costs.
 * Lower it when a change makes the types cheaper, so the room does not
 * accumulate; raising it is a decision to make on purpose, with the new
 * count in the commit message.
 *
 * `grouped` was first measured at 288 115 (2026-09-27): about 1 090
 * instantiations a group, nearly all of them the intersection `group()`
 * made of its children with the configuration's — see `GroupOptions` in
 * `packages/core/src/group.ts`. Apart, it is 187 361, about 130 a group,
 * and the budget is set the same quarter above that.
 *
 * The `GET` gained an `afterResponse` and an `onError` hook on 2026-09-29:
 * the context those slots are checked against had no budget watching it,
 * and a review found it cost four times as much on TypeScript 5.7 as on 7
 * with nobody counting. With them: 235 422 flat, 249 212 grouped — about
 * 250 instantiations a response or error hook — and both budgets set the
 * same quarter above.
 */
const budgets: Record<Mounting, number> = {
  flat: 294_000,
  grouped: 312_000,
};

interface Cost {
  readonly mounting: Mounting;
  readonly routes: number;
  readonly types: number;
  readonly instantiations: number;
  readonly memoryMb: number;
  readonly checkSeconds: number;
}

/**
 * How the controllers are mounted: all of them straight into `createApp`,
 * or each in a group of its own — a prefix and two group hooks, the second
 * reading what the first contributed. Groups have type machinery of their
 * own — prefixes joined into the route map, a group's hooks checked against
 * the context of their level — and the flat application never touches it.
 */
type Mounting = "flat" | "grouped";

function application(routes: number, mounting: Mounting): string {
  const controllers = routes / 2;
  const lines = [
    `import { controller, createApp, group, hook, route, type Requires, type StandardSchemaV1 } from ${JSON.stringify(core)};`,
    "declare const Params: StandardSchemaV1<unknown, { id: number }>;",
    "declare const Query: StandardSchemaV1<unknown, { page?: number }>;",
    "declare const Body: StandardSchemaV1<unknown, { name: string; qty: number }>;",
    "declare const Item: StandardSchemaV1<unknown, { id: number; name: string; qty: number }>;",
    "declare const NotFound: StandardSchemaV1<unknown, { code: string }>;",
    'const auth = hook.beforeParse(() => ({ user: { id: "u" } }));',
    "const owner = hook.beforeHandle((ctx: Requires<{ user: { id: string }; params: { id: number } }>) => ({ owner: ctx.user.id + ctx.params.id }));",
    'const zone = hook.beforeParse(() => ({ tenant: "t" }));',
    "const scope = hook.beforeParse((ctx: Requires<{ tenant: string }>) => ({ scope: ctx.tenant }));",
    "const audit = hook.afterResponse((ctx: Requires<{ user?: { id: string } }>) => { void ctx.user; });",
    "const mapError = hook.onError((ctx: Requires<{ user?: { id: string } }>) => (ctx.user ? undefined : new Response(null, { status: 401 })));",
  ];

  for (let index = 0; index < controllers; index += 1) {
    lines.push(`const c${index} = controller("C${index}", () => ({
  get: route({
    method: "GET",
    path: "/r${index}/:id",
    schema: { params: Params, query: Query, response: { 200: Item, 404: NotFound } },
    hooks: { beforeParse: [auth], beforeHandle: [owner], afterResponse: [audit], onError: [mapError] },
    handler: (ctx) => ({ id: ctx.params.id, name: ctx.owner, qty: ctx.query.page ?? 1 }),
  }),

  create: route({
    method: "POST",
    path: "/r${index}",
    schema: { body: Body, response: { 201: Item } },
    hooks: { beforeParse: [auth] },
    handler: (ctx) => {
      ctx.out.status = 201;

      return { id: 1, name: ctx.body.name + ctx.user.id, qty: ctx.body.qty };
    },
  }),
}));`);
  }

  const mounted = Array.from({ length: controllers }, (_, index) =>
    mounting === "flat"
      ? `c${index}()`
      : `group("/g${index}", { hooks: { beforeParse: [zone, scope] }, children: [c${index}()] })`,
  );

  lines.push(
    `export const app = createApp({ routes: [${mounted.join(", ")}] });`,
  );

  return `${lines.join("\n")}\n`;
}

const compilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: "ESNext",
  lib: ["ESNext"],
  module: "Preserve",
  moduleResolution: "bundler",
  types: ["bun"],
  typeRoots: [join(root, "node_modules", "@types")],
};

function field(output: string, name: string): number {
  const match = output.match(new RegExp(`^${name}:\\s+([\\d.]+)`, "m"));

  if (!match?.[1]) {
    throw new Error(`tsc printed no "${name}" line:\n${output}`);
  }

  return Number(match[1]);
}

async function measure(routes: number, mounting: Mounting): Promise<Cost> {
  const directory = await mkdtemp(join(tmpdir(), "tetsu-types-"));

  try {
    await Bun.write(join(directory, "app.ts"), application(routes, mounting));
    await Bun.write(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions, files: ["app.ts"] }),
    );

    const result = await $`${tsc} -p ${directory} --extendedDiagnostics`
      .nothrow()
      .quiet();
    const output = result.stdout.toString();

    if (result.exitCode !== 0) {
      throw new Error(`the generated application does not compile:\n${output}`);
    }

    return {
      mounting,
      routes,
      types: field(output, "Types"),
      instantiations: field(output, "Instantiations"),
      memoryMb: Math.round(field(output, "Memory used") / 1024),
      checkSeconds: field(output, "Check time"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await $`bun run build`.cwd(root).quiet();

const costs: Cost[] = [];

for (const mounting of ["flat", "grouped"] as const) {
  for (const routes of ladder) {
    costs.push(await measure(routes, mounting));
  }
}

console.table(costs);

if (process.argv.includes("--check")) {
  let over = false;

  for (const mounting of ["flat", "grouped"] as const) {
    const budget = budgets[mounting];
    const gated = costs.find(
      (cost) => cost.routes === 200 && cost.mounting === mounting,
    );

    if (gated === undefined || gated.instantiations > budget) {
      console.error(
        `200 routes, ${mounting}, cost ${gated?.instantiations} instantiations, over the budget of ${budget}. If the growth is deliberate, raise the budget in bench/src/types.ts and say why.`,
      );
      over = true;

      continue;
    }

    console.log(
      `200 routes, ${mounting}: ${gated.instantiations} of ${budget} instantiations`,
    );
  }

  if (over) {
    process.exit(1);
  }
}
