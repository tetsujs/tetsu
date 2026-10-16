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
 * The `client` scenario is the flat application read by
 * `@tetsujs/client` straight off `typeof app`, with a call of every route
 * that narrows its result by status — what a test suite or a Bun service
 * calling another one pays on top of the application. The `query`
 * scenario reads it through `@tetsujs/client/tanstack` instead: a query
 * and a mutation of every route.
 *
 * Types and instantiations are deterministic for a given compiler and
 * number of checkers, so `--check` holds the 200-route count to a budget
 * and fails CI when a change exceeds it. Memory and time are printed for reading, not for
 * gating: they move with the machine. So is the time of `bun check`, on a
 * Bun that has it: it counts nothing, and its limits are not the
 * compiler's — it passes types that `tsc` refuses as too deep.
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
const client = join(root, "packages", "client", "dist", "src", "index.js");
const tanstack = join(root, "packages", "client", "dist", "src", "tanstack.js");
const tsc = join(root, "node_modules", ".bin", "tsc");

/**
 * The checkers the compiler runs in parallel: the instantiations it counts
 * change with their number, one counting far more than four, so the count
 * is held to a budget for this number rather than for the default.
 */
const checkers = 4;

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
 *
 * `client` was first measured at 352 529 (2026-10-16): the flat
 * application's 236 549, and about 580 instantiations a call. The budget
 * is the same quarter above. A client that kept its contract in the type
 * of its methods walked the whole contract at every call — 1.76 million
 * at 200 routes, and too deep to compile at 1 600; one that worked out
 * the options of a route at each call cost 558 884.
 *
 * `query` was first measured at 375 529 (2026-10-16): about 695
 * instantiations a call. Options that kept the contract in the type of
 * their methods, as the client's once did, cost 574 232, and 4.6 million
 * at 800 routes.
 */
const budgets: Record<Scenario, number> = {
  flat: 294_000,
  grouped: 312_000,
  client: 441_000,
  query: 470_000,
};

/**
 * Instantiations a client may add to the flat application at 200 routes:
 * the scenario less `flat`. The budget of the scenario holds the sum, in
 * which the application is two thirds — a client that cost twice as much
 * would still fit under it. These hold the client's own share, set the
 * same quarter above its count: 115 980 calling, 138 980 through the
 * options of TanStack Query (2026-10-16).
 */
const shares = { client: 145_000, query: 174_000 } as const;

interface Cost {
  readonly scenario: Scenario;
  readonly routes: number;
  readonly types: number;
  readonly instantiations: number;
  readonly memoryMb: number;
  readonly checkSeconds: number;
  readonly bunCheckSeconds: number | undefined;
}

/**
 * How the controllers are mounted: all of them straight into `createApp`,
 * or each in a group of its own — a prefix and two group hooks, the second
 * reading what the first contributed. Groups have type machinery of their
 * own — prefixes joined into the route map, a group's hooks checked against
 * the context of their level — and the flat application never touches it.
 */
type Mounting = "flat" | "grouped";

/**
 * A way of mounting the application, or the flat one read by a client —
 * calling it, or through the options of TanStack Query.
 */
type Scenario = Mounting | "client" | "query";

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

/**
 * The flat application and a client over it: per controller, a `GET` that
 * narrows to the `200` and the declared `404`, and a `POST` with its body.
 */
function withClient(routes: number): string {
  const lines = [
    application(routes, "flat"),
    `import { createClient } from ${JSON.stringify(client)};`,
    'const api = createClient<typeof app>({ baseUrl: "https://api.example.com" });',
    "export async function calls() {",
  ];

  for (let index = 0; index < routes / 2; index += 1) {
    lines.push(`  {
    const res = await api.get("/r${index}/:id", { params: { id: ${index} }, query: { page: 1 } });

    if (res.ok) res.data.name satisfies string;
    else if (res.status === 404) res.error.code satisfies string;
  }
  {
    const res = await api.post("/r${index}", { body: { name: "n", qty: 1 } });

    if (res.ok) res.data.qty satisfies number;
  }`);
  }

  lines.push("}");

  return `${lines.join("\n")}\n`;
}

/**
 * The flat application, a client over it, and TanStack Query options for
 * each route: per controller, a query whose data and narrowed error are
 * read as a query library infers them, and a mutation.
 */
function withQueries(routes: number): string {
  const lines = [
    application(routes, "flat"),
    `import { createClient } from ${JSON.stringify(client)};`,
    `import { queryUtils } from ${JSON.stringify(tanstack)};`,
    'const q = queryUtils(createClient<typeof app>({ baseUrl: "https://api.example.com" }));',
    "declare function errorOf<E>(options: { throwOnError?: (error: E) => boolean }): E;",
    "const signal = new AbortController().signal;",
    "export async function queries() {",
  ];

  for (let index = 0; index < routes / 2; index += 1) {
    lines.push(`  {
    const options = q.get("/r${index}/:id").queryOptions({ params: { id: ${index} }, query: { page: 1 } });
    const data = await options.queryFn({ signal });
    const error = errorOf(options);

    data.name satisfies string;
    if (error.status === 404) error.body.code satisfies string;
  }
  {
    const options = q.post("/r${index}").mutationOptions();
    const data = await options.mutationFn({ body: { name: "n", qty: 1 } });

    data.qty satisfies number;
  }`);
  }

  lines.push("}");

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

/** Whether this Bun has `bun check`, which came in 1.4.3. */
const bunChecks = Bun.semver.satisfies(Bun.version, ">=1.4.3");

async function measure(routes: number, scenario: Scenario): Promise<Cost> {
  const directory = await mkdtemp(join(tmpdir(), "tetsu-types-"));

  try {
    await Bun.write(
      join(directory, "app.ts"),
      scenario === "client"
        ? withClient(routes)
        : scenario === "query"
          ? withQueries(routes)
          : application(routes, scenario),
    );
    await Bun.write(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions, files: ["app.ts"] }),
    );

    const result =
      await $`${tsc} -p ${directory} --extendedDiagnostics --checkers ${checkers}`
        .nothrow()
        .quiet();
    const output = result.stdout.toString();

    if (result.exitCode !== 0) {
      throw new Error(`the generated application does not compile:\n${output}`);
    }

    return {
      scenario,
      routes,
      types: field(output, "Types"),
      instantiations: field(output, "Instantiations"),
      memoryMb: Math.round(field(output, "Memory used") / 1024),
      checkSeconds: field(output, "Check time"),
      bunCheckSeconds: bunChecks ? await bunCheck(directory) : undefined,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Seconds `bun check` takes over the directory, which `tsc` passed. */
async function bunCheck(directory: string): Promise<number> {
  const started = performance.now();
  const result = await $`bun check`.cwd(directory).nothrow().quiet();

  if (result.exitCode !== 0) {
    throw new Error(
      `bun check refused what tsc passed:\n${result.stdout}${result.stderr}`,
    );
  }

  return Math.round(performance.now() - started) / 1000;
}

await $`bun run build`.cwd(root).quiet();

const costs: Cost[] = [];

const scenarios = ["flat", "grouped", "client", "query"] as const;

for (const scenario of scenarios) {
  for (const routes of ladder) {
    costs.push(await measure(routes, scenario));
  }
}

console.table(costs);

if (process.argv.includes("--check")) {
  let over = false;

  for (const scenario of scenarios) {
    const budget = budgets[scenario];
    const gated = costs.find(
      (cost) => cost.routes === 200 && cost.scenario === scenario,
    );

    if (gated === undefined || gated.instantiations > budget) {
      console.error(
        `200 routes, ${scenario}, cost ${gated?.instantiations} instantiations, over the budget of ${budget}. If the growth is deliberate, raise the budget in bench/src/types.ts and say why.`,
      );
      over = true;

      continue;
    }

    console.log(
      `200 routes, ${scenario}: ${gated.instantiations} of ${budget} instantiations`,
    );
  }

  const flat = costs.find(
    (cost) => cost.routes === 200 && cost.scenario === "flat",
  );

  for (const [scenario, budget] of Object.entries(shares)) {
    const read = costs.find(
      (cost) => cost.routes === 200 && cost.scenario === scenario,
    );
    const share =
      flat === undefined || read === undefined
        ? undefined
        : read.instantiations - flat.instantiations;

    if (share === undefined || share > budget) {
      console.error(
        `200 routes, the ${scenario} share cost ${share} instantiations, over the budget of ${budget}. If the growth is deliberate, raise the budget in bench/src/types.ts and say why.`,
      );
      over = true;

      continue;
    }

    console.log(
      `200 routes, the ${scenario} share: ${share} of ${budget} instantiations`,
    );
  }

  if (over) {
    process.exit(1);
  }
}
