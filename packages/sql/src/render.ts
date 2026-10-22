/**
 * The generated file: the model of a database, written out as Kysely types.
 *
 * It is laid out as Prettier, and Biome set to spaces, lay out code by
 * default — two spaces, double quotes, a line of 80 — so that such a
 * formatter leaves it as it is. Where a line is too long, it is broken the
 * way they break it, for the shapes the file holds. A formatter set
 * otherwise may lay it out its own way: `tetsu-sql types:generate --check`
 * compares the code, not its layout.
 *
 * @module
 */

import type { Alias, Column, Helper, Model, Table } from "./catalog.ts";

/** The newest migration a file was built from. */
export interface Built {
  readonly name: string;

  /** The SHA-256 of its text, as the journal records it. */
  readonly checksum: string;
}

/** What the file records for the runtime. */
export interface RenderOptions {
  /** The journal table, as `migrate` was given it. */
  readonly journal: string;

  /** The newest migration, or nothing when there is none. */
  readonly migration: Built | undefined;

  /**
   * What an `int8` reads as, recorded for `database()` when it is a
   * string. A `bigint` by default.
   */
  readonly int8?: "bigint" | "string";
}

/** The width a formatter breaks lines at. */
const WIDTH = 80;

/**
 * Whether a line is too wide, measured as a formatter measures it: by the
 * columns it takes, two for a CJK character.
 */
export function tooWide(line: string): boolean {
  return Bun.stringWidth(line) > WIDTH;
}

/** The types a union of which is broken line by line when too long. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
]);

/** The helper types, in the order the file defines them, as laid out. */
const HELPERS: readonly (readonly [Helper, string])[] = [
  [
    "Generated",
    `/** A column with a default: an insert may leave it out. */
type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;`,
  ],
  [
    "GeneratedAlways",
    `/**
 * A column Postgres computes, an identity \`always\` or a generated column:
 * it is never written.
 */
type GeneratedAlways<T> =
  T extends ColumnType<infer S, unknown, unknown>
    ? ColumnType<S, never, never>
    : ColumnType<T, never, never>;`,
  ],
  [
    "Timestamp",
    `/**
 * \`timestamp\` and \`timestamptz\`: read as a \`Date\`, a \`timestamp\` as its
 * time in UTC; written as a \`Date\` or a string Postgres reads. Postgres's
 * \`'infinity'\` and \`'-infinity'\` are read as the numbers \`Infinity\` and
 * \`-Infinity\`.
 */
type Timestamp = ColumnType<Date, Date | string, Date | string>;`,
  ],
  [
    "CalendarDate",
    `/**
 * \`date\`: read as a \`Date\` at midnight UTC; written as a \`Date\`, its day
 * in UTC, or a string such as \`"2026-10-12"\`. Postgres's \`'infinity'\` and
 * \`'-infinity'\` are read as the numbers \`Infinity\` and \`-Infinity\`.
 */
type CalendarDate = ColumnType<Date, Date | string, Date | string>;`,
  ],
  [
    "Json",
    `/**
 * \`json\` and \`jsonb\`: read as Postgres parsed it; written as an object or
 * an array. A string would be stored as a JSON string, so a value already
 * passed through \`JSON.stringify\` is refused here, as Postgres refuses a
 * number or a boolean bound on its own.
 */
type Json = ColumnType<unknown, object, object>;`,
  ],
  [
    "Bytea",
    `/** \`bytea\`: read as a \`Buffer\`, written as any \`Uint8Array\`. */
type Bytea = ColumnType<Buffer, Uint8Array, Uint8Array>;`,
  ],
  [
    "Int8",
    `/**
 * \`int8\`, in types generated with \`int8: "string"\`: read as a string,
 * which JSON takes as it is; written as a string, a number or a bigint.
 */
type Int8 = ColumnType<
  string,
  string | number | bigint,
  string | number | bigint
>;`,
  ],
  [
    "ArrayOfNullable",
    `/**
 * An array whose elements may be NULL, as any array of Postgres may. A
 * check of \`array_position(column, null) is null\` makes it an \`ArrayOf\`.
 * Elements of a column type, such as \`Timestamp\`, read and are written as
 * a column of it.
 */
type ArrayOfNullable<E> = [E] extends [ColumnType<infer S, infer I, unknown>]
  ? ColumnType<(S | null)[], readonly (I | null)[], readonly (I | null)[]>
  : ColumnType<(E | null)[], readonly (E | null)[], readonly (E | null)[]>;`,
  ],
  [
    "ArrayOf",
    `/** An array a check keeps free of NULL elements. */
type ArrayOf<E> = [E] extends [ColumnType<infer S, infer I, unknown>]
  ? ColumnType<S[], readonly I[], readonly I[]>
  : ColumnType<E[], readonly E[], readonly E[]>;`,
  ],
  [
    "ArrayLiteral",
    `/**
 * An array Bun reads as its Postgres literal, such as \`"{a,b}"\`: one of
 * an enum, a domain, a composite type, a range or a multirange of one's
 * own, or an extension's type (oven-sh/bun#41040). It is written as an
 * array.
 */
type ArrayLiteral<E> = [E] extends [ColumnType<unknown, infer I, unknown>]
  ? ColumnType<string, readonly I[], readonly I[]>
  : ColumnType<string, readonly E[], readonly E[]>;`,
  ],
  [
    "Unknown",
    `/**
 * A \`not null\` column of a type the generator does not know: read as
 * \`unknown\`, written as any value but NULL.
 */
type Unknown = ColumnType<unknown, NonNullable<unknown>, NonNullable<unknown>>;`,
  ],
];

/**
 * The names of the constraints, registered for `isViolation`: a name the
 * file does not hold is then a type error.
 */
const REGISTER = `/** Registers the names of the constraints for \`isViolation()\`. */
declare module "@tetsujs/sql" {
  interface Constraints extends Record<Constraint, true> {}
}`;

/** Writes the file of a model. */
export function render(model: Model, options: RenderOptions): string {
  const helpers = HELPERS.filter(([helper]) => model.helpers.has(helper));
  const parts = [
    header(options.migration),
    [
      'import type { Schema } from "@tetsujs/sql";',
      ...(helpers.length === 0
        ? []
        : ['import type { ColumnType } from "kysely";']),
    ].join("\n"),
    ...helpers.map(([, text]) => text),
    ...model.aliases.map(alias),
    database(model.tables),
    union("export type Constraint", model.constraints.map(stringLiteral)),
    REGISTER,
    schema(model.tables, options),
  ];

  return `${parts.join("\n\n")}\n`;
}

/** The comment at the top: what the file is, and from what. */
function header(migration: Built | undefined): string {
  const built =
    migration === undefined
      ? [
          " * The database the migrations build, as Postgres describes it: empty,",
          " * as there are no migrations yet.",
        ]
      : [
          " * The database the migrations build, as Postgres describes it, up to",
          ` * ${migration.name}.`,
        ];

  return [
    "/**",
    ...built,
    " *",
    " * Generated by `tetsu-sql types:generate`: change the migrations, not",
    " * this file, and generate it again.",
    " *",
    " * @module",
    " */",
  ].join("\n");
}

/** An enum, or the list a check allows. */
function alias(each: Alias): string {
  return union(
    `export type ${each.name}`,
    each.values.map((value) =>
      typeof value === "number" ? String(value) : stringLiteral(value),
    ),
  );
}

/**
 * A type made of members: on one line when it fits, otherwise one member
 * a line; `never` when there is none.
 */
function union(head: string, members: readonly string[]): string {
  const flat = `${head} = ${members.length === 0 ? "never" : members.join(" | ")};`;

  if (!tooWide(flat)) {
    return flat;
  }

  if (members.length === 1) {
    return `${head} =\n  ${members[0]};`;
  }

  return `${head} =\n${members.map((member) => `  | ${member}`).join("\n")};`;
}

/** The `DB` interface: one key a relation. */
function database(tables: readonly Table[]): string {
  if (tables.length === 0) {
    return "export type DB = Record<never, never>;";
  }

  const entries = tables.map((table) =>
    [
      ...doc(table.comment, "  "),
      table.columns.length === 0
        ? empty(keyOf(table.key))
        : [
            `  ${keyOf(table.key)}: {`,
            ...table.columns.flatMap((column) => [
              ...doc(column.comment, "    "),
              property(column, "    "),
            ]),
            "  };",
          ].join("\n"),
    ].join("\n"),
  );

  return `export interface DB {\n${entries.join("\n\n")}\n}`;
}

/** A relation with no column; too long, its type's arguments a line each. */
function empty(key: string): string {
  const line = `  ${key}: Record<never, never>;`;

  return tooWide(line)
    ? `  ${key}: Record<\n    never,\n    never\n  >;`
    : line;
}

/**
 * A column. A column Postgres computes is never written, NULL included, so
 * its NULL goes inside `GeneratedAlways`; any other column's goes after.
 *
 * Too long, the line is broken as a formatter breaks it. A nullable
 * keyword goes one member a line. A generic around a generic, or around a
 * nullable keyword, has its argument on a line of its own. A union of
 * NULL and a name or a generic hugs its line, as does anything else.
 */
function property(column: Column, indent: string): string {
  const key = keyOf(column.name);
  const nullable = column.nullable && column.type !== "unknown";
  const [outer, inner, after] =
    column.generated === "always"
      ? ["GeneratedAlways", `${column.type}${nullable ? " | null" : ""}`, ""]
      : column.generated === "default"
        ? ["Generated", column.type, nullable ? " | null" : ""]
        : [undefined, column.type, nullable ? " | null" : ""];
  const type = outer === undefined ? inner : `${outer}<${inner}>`;
  const line = `${indent}${key}: ${type}${after};`;

  if (!tooWide(line)) {
    return line;
  }

  if (outer === undefined && after !== "" && KEYWORDS.has(inner)) {
    return `${indent}${key}:\n${indent}  | ${inner}\n${indent}  | null;`;
  }

  const breaks = inner.endsWith(" | null")
    ? KEYWORDS.has(column.type)
    : inner.includes("<");

  if (outer !== undefined && breaks) {
    return `${indent}${key}: ${outer}<\n${indent}  ${inner}\n${indent}>${after};`;
  }

  return line;
}

/** The `schema` the runtime reads. */
function schema(tables: readonly Table[], options: RenderOptions): string {
  const { migration } = options;

  return [
    "export const schema: Schema<DB, Constraint> = {",
    stringProperty("journal", options.journal, "  "),
    ...(migration === undefined
      ? ["  migration: null,"]
      : [
          "  migration: {",
          stringProperty("name", migration.name, "    "),
          stringProperty("checksum", migration.checksum, "    "),
          "  },",
        ]),
    ...(options.int8 === "string" ? ['  int8: "string",'] : []),
    ...arrays(tables),
    "};",
  ].join("\n");
}

/**
 * The columns that hold arrays, by relation, each with how its literal is
 * written.
 * A relation whose key is too long for its line has its columns on the
 * lines after it, as a formatter breaks an object after a long key.
 */
function arrays(tables: readonly Table[]): string[] {
  const relations = tables.flatMap((table) => {
    const columns = table.columns.flatMap((column) =>
      column.literal === undefined
        ? []
        : [{ key: propertyKeyOf(column.name), literal: column.literal }],
    );

    if (columns.length === 0) {
      return [];
    }

    const key = propertyKeyOf(table.key);
    const head = `    ${key}: {`;
    const [open, indent, close] = tooWide(head)
      ? [`    ${key}:\n      {`, "        ", "      },"]
      : [head, "      ", "    },"];

    return [
      [
        open,
        ...columns.map((column) =>
          stringProperty(column.key, column.literal, indent),
        ),
        close,
      ].join("\n"),
    ];
  });

  return relations.length === 0
    ? ["  arrays: {},"]
    : ["  arrays: {", ...relations, "  },"];
}

/**
 * A property of a string. Too long, the string goes on a line of its own,
 * unless the key is shorter than five columns, which a formatter never
 * breaks after.
 */
function stringProperty(key: string, value: string, indent: string): string {
  const text = stringLiteral(value);
  const flat = `${indent}${key}: ${text},`;

  return !tooWide(flat) || Bun.stringWidth(key) < 5
    ? flat
    : `${indent}${key}:\n${indent}  ${text},`;
}

/** A TSDoc comment, on one line when it fits and has one. */
export function doc(text: string | undefined, indent: string): string[] {
  if (text === undefined) {
    return [];
  }

  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("*/", "*\\/")
    .split("\n")
    .map((line) => line.trimEnd());
  const one = `${indent}/** ${lines[0]} */`;

  if (lines.length === 1 && !tooWide(one)) {
    return [one];
  }

  return [
    `${indent}/**`,
    ...lines.map((line) =>
      line === "" ? `${indent} *` : `${indent} * ${line}`,
    ),
    `${indent} */`,
  ];
}

/**
 * A key of an object: as {@link keyOf} writes it, but for `__proto__`, which
 * as a key of an object literal would set its prototype instead.
 */
function propertyKeyOf(name: string): string {
  return name === "__proto__" ? '["__proto__"]' : keyOf(name);
}

/** A key: as it is when it is an identifier, otherwise quoted. */
export function keyOf(name: string): string {
  return /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(name)
    ? name
    : stringLiteral(name);
}

/**
 * A string, in double quotes unless it holds more of them than of single
 * ones, which is how Prettier and Biome choose.
 */
export function stringLiteral(value: string): string {
  const json = JSON.stringify(value);
  const doubles = value.split('"').length - 1;
  const singles = value.split("'").length - 1;

  if (doubles <= singles) {
    return json;
  }

  let inner = "";

  for (let index = 1; index < json.length - 1; index += 1) {
    const char = json[index];

    if (char === "\\") {
      const next = json[index + 1];

      inner += next === '"' ? '"' : `\\${next}`;
      index += 1;
    } else {
      inner += char === "'" ? "\\'" : char;
    }
  }

  return `'${inner}'`;
}
