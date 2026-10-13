/**
 * Writing the generated file: each shape a line takes, and the whole file
 * held to Biome with the repository's settings — Prettier's defaults —
 * which must leave it as it is and find nothing to lint.
 *
 * @module
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Column, Helper, Model } from "./catalog.ts";
import { render } from "./render.ts";

const root = join(import.meta.dir, "../../..");
const biome = join(root, "node_modules/.bin/biome");

/**
 * A directory in the package, so that the repository's settings hold for
 * it: Biome checks a file there as it checks the package's own. Git
 * ignores it, in case a run ends before it is removed.
 */
const scratch = await mkdtemp(join(import.meta.dir, "../test-utils/render-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** What `biome check` says of a source, kept in a file of the package. */
async function check(source: string) {
  const path = join(scratch, `${Bun.randomUUIDv7()}.ts`);

  await Bun.write(path, source);

  const result = Bun.spawnSync(
    [biome, "check", "--vcs-use-ignore-file=false", path],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

const helpers: ReadonlySet<Helper> = new Set<Helper>([
  "Generated",
  "GeneratedAlways",
  "Timestamp",
  "CalendarDate",
  "Json",
  "Bytea",
  "ArrayOfNullable",
  "ArrayOf",
  "ArrayLiteral",
]);

/** A column, by its shape. */
function column(
  name: string,
  type: string,
  shape: Partial<Omit<Column, "name" | "type">> = {},
): Column {
  return {
    name,
    type,
    nullable: false,
    generated: "no",
    comment: undefined,
    literal: undefined,
    ...shape,
  };
}

/** A model of one table with these columns. */
function table(columns: readonly Column[]): Model {
  return {
    tables: [{ key: "t", comment: undefined, columns }],
    aliases: [],
    helpers,
    constraints: [],
  };
}

/** The line of a column's property, from a file of one table. */
function propertyOf(each: Column): string {
  const file = render(table([each]), {
    journal: "migrations",
    migration: undefined,
  });
  const start = file.indexOf("  t: {\n") + "  t: {\n".length;

  return file.slice(start, file.indexOf("\n  };", start));
}

const long = "a_column_name_long_enough_to_push_the_line_past_the_width_xyz";

describe("a column", () => {
  test.each([
    [column("id", "bigint"), "    id: bigint;"],
    [column("note", "string", { nullable: true }), "    note: string | null;"],
    [
      column("id", "bigint", { generated: "always" }),
      "    id: GeneratedAlways<bigint>;",
    ],
    [
      column("at", "Timestamp", { generated: "default", nullable: true }),
      "    at: Generated<Timestamp> | null;",
    ],
    [
      column("total", "string", { generated: "always", nullable: true }),
      "    total: GeneratedAlways<string | null>;",
    ],
    [column("doc", "unknown", { nullable: true }), "    doc: unknown;"],
    [column("Mixed Case", "string"), '    "Mixed Case": string;'],
    [column("2fa", "boolean"), '    "2fa": boolean;'],
    [column('say "hi"', "string"), "    'say \"hi\"': string;"],
    [column("café", "string"), "    café: string;"],
    [column("select", "string"), "    select: string;"],
  ])("%j is written %j", (each, line) => {
    expect(propertyOf(each)).toBe(line);
  });

  test("of a keyword and NULL, too long, is broken one member a line", () => {
    expect(propertyOf(column(long, "string", { nullable: true }))).toBe(
      `    ${long}:\n      | string\n      | null;`,
    );
  });

  test("of a generic around a generic or a nullable keyword, too long, has its argument on a line of its own", () => {
    expect(
      propertyOf(
        column(long, "string", { generated: "always", nullable: true }),
      ),
    ).toBe(`    ${long}: GeneratedAlways<\n      string | null\n    >;`);
    expect(
      propertyOf(column(long, "ArrayOf<string>", { generated: "default" })),
    ).toBe(`    ${long}: Generated<\n      ArrayOf<string>\n    >;`);
    expect(
      propertyOf(
        column(long, "ArrayOf<string>", {
          generated: "default",
          nullable: true,
        }),
      ),
    ).toBe(`    ${long}: Generated<\n      ArrayOf<string>\n    > | null;`);
  });

  test.each([
    ["an alias and NULL", column(long, "Timestamp", { nullable: true })],
    ["a generic of a keyword", column(long, "bigint", { generated: "always" })],
    [
      "a generic of a keyword and NULL",
      column(long, "ArrayOfNullable<number>", { nullable: true }),
    ],
    [
      "a computed alias and NULL",
      column(long, "Timestamp", { generated: "always", nullable: true }),
    ],
    [
      "a computed generic and NULL",
      column(long, "ArrayOfNullable<number>", {
        generated: "always",
        nullable: true,
      }),
    ],
  ])("of %s, too long, stays on its line", (_, each) => {
    expect(propertyOf(each)).not.toContain("\n");
  });

  test("with a comment has it above, ended safely", () => {
    expect(
      propertyOf(
        column("status", "string", { comment: "Where it is: */ ends it." }),
      ),
    ).toBe("    /** Where it is: *\\/ ends it. */\n    status: string;");
    expect(
      propertyOf(
        column("status", "string", { comment: "One line.\n\nTwo.  " }),
      ),
    ).toBe(
      "    /**\n     * One line.\n     *\n     * Two.\n     */\n    status: string;",
    );
  });
});

describe("a union", () => {
  const model = (values: readonly (string | number)[]): Model => ({
    tables: [],
    aliases: [{ name: "Kind", values }],
    helpers: new Set(),
    constraints: [],
  });
  const aliasOf = (values: readonly (string | number)[]) => {
    const file = render(model(values), {
      journal: "migrations",
      migration: undefined,
    });
    const start = file.indexOf("export type Kind");

    return file.slice(start, file.indexOf(";", start) + 1);
  };

  test.each([
    [["retail", "bulk"], 'export type Kind = "retail" | "bulk";'],
    [[1, 2, -3], "export type Kind = 1 | 2 | -3;"],
    [[], "export type Kind = never;"],
    [["it's", 'say "hi"'], 'export type Kind = "it\'s" | \'say "hi"\';'],
    [
      ["back\\slash", "a \"b\" 'c'"],
      'export type Kind = "back\\\\slash" | "a \\"b\\" \'c\'";',
    ],
  ])("of %j is written %s", (values, text) => {
    expect(aliasOf(values)).toBe(text);
  });

  test("too long is broken one member a line, and one member alone after =", () => {
    const many = [
      "aaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccc",
    ];
    const one = [
      "a single value long enough to run past the width of a line, x",
    ];

    expect(aliasOf(many)).toBe(
      `export type Kind =\n${many.map((value) => `  | "${value}"`).join("\n")};`,
    );
    expect(aliasOf(one)).toBe(`export type Kind =\n  "${one[0]}";`);
  });
});

describe("a file", () => {
  test("of nothing has no table, no constraint, no migration and no Kysely", () => {
    const file = render(
      { tables: [], aliases: [], helpers: new Set(), constraints: [] },
      { journal: "migrations", migration: undefined },
    );

    expect(file).toContain("as there are no migrations yet");
    expect(file).not.toContain("kysely");
    expect(file).toContain("export type DB = Record<never, never>;");
    expect(file).toContain("export type Constraint = never;");
    expect(file).toContain("  migration: null,\n");
  });

  test("records the newest migration, with a checksum too long to share its line", () => {
    const file = render(table([column("id", "bigint")]), {
      journal: "migrations",
      migration: {
        name: "20261012153000_add_orders.sql",
        checksum: "f".repeat(64),
      },
    });

    expect(file).toContain(" * 20261012153000_add_orders.sql.\n");
    expect(file).toContain(
      `  migration: {\n    name: "20261012153000_add_orders.sql",\n    checksum:\n      "${"f".repeat(64)}",\n  },`,
    );
  });

  test("defines only the helpers its columns use", () => {
    const file = render(
      {
        ...table([column("at", "Timestamp")]),
        helpers: new Set(["Timestamp"]),
      },
      { journal: "migrations", migration: undefined },
    );

    expect(file).toContain("type Timestamp =");
    expect(file).not.toContain("type Json =");
    expect(file).not.toContain("type Generated<");
  });
});

describe("the columns of arrays", () => {
  /** The `arrays` of a file of these tables. */
  const arraysOf = (tables: Model["tables"]): string => {
    const file = render(
      { tables, aliases: [], helpers, constraints: [] },
      { journal: "migrations", migration: undefined },
    );
    const start = file.indexOf("  arrays:");

    return file.slice(start, file.lastIndexOf("\n};"));
  };

  test("of a file with none are an empty object", () => {
    expect(
      arraysOf([
        { key: "t", comment: undefined, columns: [column("id", "bigint")] },
      ]),
    ).toBe("  arrays: {},");
  });

  test("are listed by relation, each with how its literal is written, keys as DB names them", () => {
    expect(
      arraysOf([
        {
          key: "orders",
          comment: undefined,
          columns: [
            column("id", "bigint"),
            column("tags", "ArrayOf<string>", { literal: "," }),
            column("Mixed Case", "ArrayOfNullable<string>", {
              literal: ",",
            }),
            column("boxes", "ArrayOfNullable<string>", { literal: ";" }),
            column("documents", "ArrayOfNullable<Json>", { literal: "json" }),
          ],
        },
        { key: "empty", comment: undefined, columns: [] },
        {
          key: "billing.invoices",
          comment: undefined,
          columns: [column("codes", "ArrayLiteral<string>", { literal: "," })],
        },
      ]),
    ).toBe(
      [
        "  arrays: {",
        "    orders: {",
        '      tags: ",",',
        '      "Mixed Case": ",",',
        '      boxes: ";",',
        '      documents: "json",',
        "    },",
        '    "billing.invoices": {',
        '      codes: ",",',
        "    },",
        "  },",
      ].join("\n"),
    );
  });

  test("of a relation or a column named __proto__ keep it as their key, not as a prototype", () => {
    expect(
      arraysOf([
        {
          key: "__proto__",
          comment: undefined,
          columns: [column("__proto__", "ArrayOf<string>", { literal: "," })],
        },
      ]),
    ).toBe(
      [
        "  arrays: {",
        '    ["__proto__"]: {',
        '      ["__proto__"]: ",",',
        "    },",
        "  },",
      ].join("\n"),
    );
  });

  test("of a relation whose key is too long for its line are on the lines after it", () => {
    const key = `reporting.${"t".repeat(70)}`;

    expect(
      arraysOf([
        {
          key,
          comment: undefined,
          columns: [column("a", "ArrayOf<string>", { literal: "," })],
        },
      ]),
    ).toBe(
      [
        "  arrays: {",
        `    "${key}":`,
        "      {",
        '        a: ",",',
        "      },",
        "  },",
      ].join("\n"),
    );
  });

  test("whose key is too long for its line has its value on the next", () => {
    const name = `${long}_and_then_some`;

    expect(
      arraysOf([
        {
          key: "t",
          comment: undefined,
          columns: [column(name, "ArrayOf<string>", { literal: "," })],
        },
      ]),
    ).toBe(
      [
        "  arrays: {",
        "    t: {",
        `      ${name}:`,
        '        ",",',
        "    },",
        "  },",
      ].join("\n"),
    );
  });
});

describe("Biome, set as the repository is", () => {
  const model: Model = {
    tables: [
      {
        key: "orders",
        comment:
          "A comment long enough to need a block of its own, as it runs past the width of a line.",
        columns: [
          column(`${long}_1`, "string", { nullable: true }),
          column(`${long}_2`, "ArrayOf<string>", {
            generated: "default",
            nullable: true,
          }),
          column(`${long}_3`, "ArrayOfNullable<number>", {
            generated: "always",
          }),
          column(`${long}_4`, "Timestamp", { nullable: true }),
          column(`${long}_5`, "bigint", { generated: "always" }),
          column(`${long}_6`, "ArrayOfNullable<number>", { nullable: true }),
          column(`${long}_7`, "boolean", {
            generated: "default",
            nullable: true,
          }),
          column(`${long}_8`, "ArrayLiteral<OrderStatus>", { nullable: true }),
          column(`${long}_9`, "string", {
            generated: "always",
            nullable: true,
          }),
          column(`${long}_a`, "ArrayOfNullable<number>", {
            generated: "always",
            nullable: true,
          }),
          column(`${long}_b`, "ArrayOfNullable<Timestamp>", {
            nullable: true,
            literal: ",",
          }),
          column(`${long}_c`, "ArrayOf<Json>", {
            generated: "default",
            literal: ",",
          }),
          column(`${long}_d`, "ArrayOfNullable<Bytea>", {
            generated: "always",
            nullable: true,
            literal: ",",
          }),
          column(`${long}_e`, "ArrayLiteral<CalendarDate>", {
            nullable: true,
            literal: ",",
          }),
          column(
            `${long}_and_then_some_more_to_break_after_its_key`,
            "ArrayOfNullable<string>",
            {
              nullable: true,
              literal: ";",
            },
          ),
          column("boxes", "ArrayOfNullable<string>", { literal: ";" }),
          column("total", "Timestamp", { generated: "always", nullable: true }),
          column("Mixed Case", "string"),
          column("café", "Json", {
            comment: "`json` on its own.\n\nWith a paragraph.",
          }),
          column("2fa", "Bytea", { nullable: true }),
          column("doc", "unknown", {
            comment: "`vector`: a type the generator does not know.",
          }),
          column("placed_on", "CalendarDate", { generated: "default" }),
        ],
      },
      { key: "billing.empty", comment: undefined, columns: [] },
      {
        key: "__proto__",
        comment: undefined,
        columns: [
          column("__proto__", "ArrayOfNullable<string>", {
            nullable: true,
            literal: ",",
          }),
        ],
      },
      { key: `reporting.${"t".repeat(50)}`, comment: undefined, columns: [] },
      {
        key: `reporting.${"u".repeat(70)}`,
        comment: undefined,
        columns: [
          column("codes", "ArrayLiteral<string>", {
            nullable: true,
            literal: ",",
          }),
        ],
      },
      {
        key: "注文",
        comment: undefined,
        columns: [
          column(
            "注文の状態と配送の状況を記録しておくための列で長い名前",
            "string",
            {
              nullable: true,
            },
          ),
          column("attributes", "Unknown"),
          column(
            "注文の状態と配送の状況を記録しておくための配列の列で長い名前",
            "ArrayOf<string>",
            {
              literal: ",",
            },
          ),
        ],
      },
    ],
    aliases: [
      { name: "OrderStatus", values: ["new", "paid", "shipped"] },
      {
        name: "Long",
        values: [
          "aaaaaaaaaaaaaaaaaaaa",
          "bbbbbbbbbbbbbbbbbbbb",
          "cccccccccccccccccccc",
        ],
      },
      {
        name: "One",
        values: ["a single value long enough to run past the width of a line"],
      },
      { name: "Numbers", values: [1, 2, -3] },
      { name: "Quotes", values: ["it's", 'say "hi"', "back\\slash"] },
      { name: "Nothing", values: [] },
      {
        name: "Kanji",
        values: [
          "注文を受け付けました",
          "支払いが完了しました",
          "発送しました",
          "配達が完了しました",
        ],
      },
    ],
    helpers,
    constraints: [
      "orders_pkey",
      "orders_status_check",
      "orders_email_key",
      `${long}_check`,
    ],
  };

  const migrations = [
    ["a migration", "20261012153000_add_orders.sql"],
    [
      "a migration whose name is too long for its line",
      "20261012153000_add_shipping_address_and_billing_details_to_orders.sql",
    ],
    [
      "a migration whose name would not fit on a line of its own",
      `20261012153000_${"x".repeat(62)}.sql`,
    ],
    ["no migration", undefined],
  ] as const;
  const journals = [
    ["a journal", "migrations"],
    [
      "a journal whose name is long",
      "a_journal_whose_name_is_long_enough_to_go_on_its_own_line",
    ],
    ["a journal whose name would not fit on a line of its own", "j".repeat(75)],
  ] as const;

  test.each(
    migrations.flatMap(([migration, name]) =>
      journals.map(([journal, table]) => [
        `${migration} and ${journal}`,
        name,
        table,
      ]),
    ),
  )(
    "leaves a file with %s as it is, and finds nothing to lint",
    async (_, name, journal) => {
      const file = render(model, {
        journal,
        migration:
          name === undefined ? undefined : { name, checksum: "a".repeat(64) },
      });
      const result = await check(file);

      expect(result.output).not.toContain("×");
      expect(result.exitCode).toBe(0);
    },
  );
});
