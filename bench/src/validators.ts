/**
 * What validation costs, per library, through the interface the framework
 * calls: `schema["~standard"].validate(value)`.
 *
 * The HTTP benchmark put a TypeBox DTO behind a hand-written check — the
 * fastest validator there can be, and not the one an application replaces
 * TypeBox with. The comparison that matters is against the libraries a
 * user would pick instead, on a schema large enough for TypeBox's compiled
 * checks to have something to compile: Zod, ArkType, Valibot.
 *
 * Three readings:
 *
 * - **validating** a small and a nested body, valid and invalid;
 * - **declaring** a schema — TypeBox compiles at declaration, so the cost
 *   it saves per request is partly paid here, once;
 * - **memory** a process pays for importing the library, each in a
 *   process of its own.
 *
 * Every validator is checked to accept the valid input and reject the
 * invalid one before anything is timed: a fast validator that answers
 * wrongly is not fast.
 *
 * Run: `bun run --cwd bench validators`
 *
 * @module
 */

import type { StandardSchemaV1 } from "@tetsujs/core";
import { Type, tb } from "@tetsujs/typebox";
import { type } from "arktype";
import { bench, do_not_optimize, run, summary } from "mitata";
import * as v from "valibot";
import { z } from "zod";

type Schema = StandardSchemaV1<unknown, unknown>;

const small = { name: "pen", qty: 3 };

const nested = {
  customer: { name: "Ada", email: "ada@example.com" },
  items: Array.from({ length: 20 }, (_, index) => ({
    sku: `sku-${index}`,
    qty: index + 1,
    price: 9.5,
  })),
  tags: ["gift", "express"],
  note: "leave at the door",
};

const nestedInvalid = {
  ...nested,
  items: [...nested.items.slice(0, 19), { sku: "sku-19", qty: 0, price: 9.5 }],
};

const smallSchemas = {
  zod: () => z.object({ name: z.string(), qty: z.number() }),
  arktype: () => type({ name: "string", qty: "number" }),
  valibot: () => v.object({ name: v.string(), qty: v.number() }),
  typebox: () => tb(Type.Object({ name: Type.String(), qty: Type.Number() })),
} satisfies Record<string, () => unknown>;

const nestedSchemas = {
  zod: () =>
    z.object({
      customer: z.object({ name: z.string(), email: z.string() }),
      items: z.array(
        z.object({
          sku: z.string(),
          qty: z.number().int().min(1),
          price: z.number(),
        }),
      ),
      tags: z.array(z.string()),
      note: z.string().optional(),
    }),
  arktype: () =>
    type({
      customer: { name: "string", email: "string" },
      items: type({
        sku: "string",
        qty: "number.integer >= 1",
        price: "number",
      }).array(),
      tags: "string[]",
      "note?": "string",
    }),
  valibot: () =>
    v.object({
      customer: v.object({ name: v.string(), email: v.string() }),
      items: v.array(
        v.object({
          sku: v.string(),
          qty: v.pipe(v.number(), v.integer(), v.minValue(1)),
          price: v.number(),
        }),
      ),
      tags: v.array(v.string()),
      note: v.optional(v.string()),
    }),
  typebox: () =>
    tb(
      Type.Object({
        customer: Type.Object({ name: Type.String(), email: Type.String() }),
        items: Type.Array(
          Type.Object({
            sku: Type.String(),
            qty: Type.Integer({ minimum: 1 }),
            price: Type.Number(),
          }),
        ),
        tags: Type.Array(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    ),
} satisfies Record<keyof typeof smallSchemas, () => unknown>;

type Library = keyof typeof smallSchemas;

const libraries = Object.keys(smallSchemas) as Library[];

function validate(schema: Schema, value: unknown): unknown {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error("an asynchronous validator cannot be timed here");
  }

  return result;
}

function assertAnswers(
  name: string,
  schema: Schema,
  valid: unknown,
  invalid: unknown,
): void {
  const accepted = validate(schema, valid) as { issues?: unknown };
  const rejected = validate(schema, invalid) as { issues?: unknown };

  if (accepted.issues !== undefined || rejected.issues === undefined) {
    throw new Error(`${name} answers wrongly; nothing it does is worth timing`);
  }
}

const built = Object.fromEntries(
  libraries.map((library) => [
    library,
    {
      small: smallSchemas[library]() as Schema,
      nested: nestedSchemas[library]() as Schema,
    },
  ]),
) as Record<Library, { small: Schema; nested: Schema }>;

for (const library of libraries) {
  assertAnswers(library, built[library].small, small, { name: "pen" });
  assertAnswers(library, built[library].nested, nested, nestedInvalid);
}

for (const [label, pick, value] of [
  ["small body, valid", "small", small],
  ["nested body, valid", "nested", nested],
  ["nested body, one invalid item", "nested", nestedInvalid],
] as const) {
  summary(() => {
    for (const library of libraries) {
      const schema = built[library][pick];

      bench(`${label}: ${library}`, () =>
        do_not_optimize(validate(schema, value)),
      );
    }
  });
}

/**
 * TypeBox's error path without the walk: `issues: "summary"` reports one
 * failure for the whole value instead of asking `Errors()` where it is.
 */
const summarized = tb(nestedSchemas.typebox(), { issues: "summary" });

assertAnswers("typebox, summary", summarized, nested, nestedInvalid);

summary(() => {
  bench("nested body, one invalid item: typebox, detailed", () =>
    do_not_optimize(validate(built.typebox.nested, nestedInvalid)),
  );
  bench("nested body, one invalid item: typebox, summary", () =>
    do_not_optimize(validate(summarized, nestedInvalid)),
  );
});

summary(() => {
  for (const library of libraries) {
    bench(`declare the nested schema: ${library}`, () =>
      do_not_optimize(nestedSchemas[library]()),
    );
  }
});

await run();

const imports: Record<Library | "nothing", string> = {
  nothing: "",
  zod: 'import "zod";',
  arktype: 'import "arktype";',
  valibot: 'import "valibot";',
  typebox: 'import "@tetsujs/typebox";',
};

console.log("\nresident memory after importing, in a fresh process:");

for (const [library, statement] of Object.entries(imports)) {
  const readings: number[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const child = Bun.spawn(
      [
        "bun",
        "--eval",
        `${statement} Bun.gc(true); console.log(process.memoryUsage().rss);`,
      ],
      { cwd: import.meta.dir, stdout: "pipe" },
    );

    readings.push(Number(await new Response(child.stdout).text()));
  }

  readings.sort((a, b) => a - b);

  console.log(
    `  ${library.padEnd(8)} ${((readings[1] ?? 0) / 1_048_576).toFixed(1)} MB`,
  );
}
