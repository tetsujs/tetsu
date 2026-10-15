/**
 * What the types of `@tetsujs/sql` cost: the compiler's work for a project
 * of 200 tables and N statements.
 *
 * `types.ts` measures the framework's half of an application; this one the
 * database's: the file of types the generator writes, and the code written
 * against it. Most of the bill is Kysely's: a schema costs nothing until a
 * query reads it, and a query costs more the more tables the schema has.
 * The package's part is the shape of the column types, which every query
 * of Kysely reads, and the signatures of its own functions. Those once
 * cost seconds: `atomic()`, `queryRows()` and `queryCount()` took a union
 * of Kysely's three classes, which had the compiler match each call's
 * argument with all of them, and this project cost several times what it
 * does now — `bench/README.md` has the counts.
 *
 * The files are the generator's own output, written by its `render()` and
 * `renderQueries()` from a model of a schema, so that a change to their
 * shape shows here without a server. Each table is the one
 *
 * ```sql
 * create type status as enum ('pending', 'done', 'failed');
 * create table t0 (
 *   id int8 generated always as identity primary key,
 *   owner_id int8 not null references t1 (id),
 *   name text not null,
 *   email text unique,
 *   status status not null default 'pending',
 *   amount numeric not null,
 *   tags text[] not null default '{}',
 *   data jsonb,
 *   created_at timestamptz not null default now()
 * );
 * ```
 *
 * makes. The statements take turns: a select with a join, an insert that
 * returns, an update, a delete whose violation `isViolation()` tells, a
 * unit of `atomic()` inside another, a function of a query file run in a
 * unit, one that counts the rows it updates run on the database, and a
 * unit on a controlled transaction. The package's types come from `dist`,
 * as a user's compiler reads them.
 *
 * Types and instantiations are deterministic for a given compiler, number
 * of checkers and Kysely, so `--check` holds the count of 200 statements
 * to a budget and fails CI when a change exceeds it. Much of that count is
 * paid once, for the first statement of each kind, so the budget catches
 * a type that costs more for every query or every call by far, as the
 * union did, and lets a small growth by. Memory and time are printed for
 * reading, not for gating: they move with the machine.
 *
 * Run: `bun run --cwd bench sql-types` (or `sql-types --check`)
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type {
  Column,
  Model,
  TsType,
  Values,
} from "../../packages/sql/src/catalog.ts";
import type { DescribedQuery } from "../../packages/sql/src/describe.ts";
import { parseQuery } from "../../packages/sql/src/query-files.ts";
import { render } from "../../packages/sql/src/render.ts";
import { renderQueries } from "../../packages/sql/src/render-queries.ts";

const root = join(import.meta.dir, "..", "..");
const sql = join(root, "packages", "sql");
const kysely = realpathSync(join(sql, "node_modules", "kysely"));
const tsc = join(root, "node_modules", ".bin", "tsc");

/**
 * The checkers the compiler runs in parallel: the instantiations it counts
 * change with their number, one counting far more than four, so the count
 * is held to a budget for this number rather than for the default.
 */
const checkers = 4;

/** The tables of the schema. */
const tables = 200;

/** Statement counts of the ladder. */
const ladder = [0, 200, 800] as const;

/**
 * Instantiations 200 statements may cost, on the compiler the repository
 * pins and the Kysely the package is built with.
 *
 * Set a quarter above the last measured count (636 426), which
 * leaves room for honest growth and none for the doubling a careless type
 * costs. Lower it when a change makes the types cheaper, so the room does
 * not accumulate; raising it is a decision to make on purpose, with the
 * new count in the commit message.
 */
const budget = 796_000;

interface Cost {
  readonly statements: number;
  readonly types: number;
  readonly instantiations: number;
  readonly memoryMb: number;
  readonly checkSeconds: number;
}

/** A column of a table, as the catalog reads it. */
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

/** The schema: `tables` tables, each the one this module's comment shows. */
function schema(): Model {
  const keys = Array.from({ length: tables }, (_, index) => `t${index}`);

  return {
    tables: keys.map((key) => ({
      key,
      comment: undefined,
      columns: [
        column("id", "bigint", { generated: "always" }),
        column("owner_id", "bigint"),
        column("name", "string"),
        column("email", "string", { nullable: true }),
        column("status", "Status", { generated: "default" }),
        column("amount", "string"),
        column("tags", "ArrayOfNullable<string>", {
          generated: "default",
          literal: ",",
        }),
        column("data", "Json", { nullable: true }),
        column("created_at", "Timestamp", { generated: "default" }),
      ],
    })),
    aliases: [{ name: "Status", values: ["pending", "done", "failed"] }],
    helpers: new Set([
      "Generated",
      "GeneratedAlways",
      "Timestamp",
      "Json",
      "ArrayOfNullable",
    ]),
    constraints: keys
      .flatMap((key) => [
        `${key}_email_key`,
        `${key}_owner_id_fkey`,
        `${key}_pkey`,
      ])
      .toSorted(),
  };
}

const keyword = (name: string): TsType => ({ kind: "keyword", name });
const same = (type: TsType): Values => ({ reads: type, writes: type });

/**
 * A query file named `name`, as Postgres describes `source`: the type of
 * each parameter, by its name, and the columns of the rows it returns, or
 * `null` for a statement that returns none.
 */
function described(
  name: string,
  source: string,
  parameters: Readonly<Record<string, TsType>>,
  fields: readonly (readonly [string, TsType])[] | null,
): DescribedQuery {
  const file = parseQuery(`/app/queries/${name}.sql`, name, source);

  return {
    file,
    parameters: file.parameters.map((parameter) => {
      const type = parameters[parameter.name];

      if (type === undefined) {
        throw new Error(`no type for :${parameter.name} of ${name}`);
      }

      return { ...parameter, values: same(type), literal: undefined };
    }),
    fields:
      fields === null
        ? null
        : fields.map(([field, type]) => ({
            name: field,
            values: same(type),
            nullable: false,
          })),
  };
}

/** A statement of the project, and the query file it calls, if any. */
interface Statement {
  /** Its code, given the table it reads, another it joins, and its turn. */
  readonly code: (table: string, other: string, turn: number) => string;

  /** The query file it calls, given its turn and its table. */
  readonly file?: (turn: number, table: string) => DescribedQuery;
}

/**
 * The statements, taking turns, each kind on tables of its own, so that 200
 * statements read every table once: a statement on a table read before
 * costs less, as the compiler has its types.
 */
const statements: readonly Statement[] = [
  {
    code: (table, other) =>
      `out.push(await db.selectFrom("${table}").innerJoin("${other}", "${other}.id", "${table}.owner_id").select(["${table}.id", "${table}.name", "${other}.email"]).where("${table}.status", "=", "done").execute());`,
  },
  {
    code: (table) =>
      `out.push(await db.insertInto("${table}").values({ owner_id: 1n, name: "a", amount: "1.50", data: { a: 1 } }).returning(["id", "created_at"]).executeTakeFirstOrThrow());`,
  },
  {
    code: (table) =>
      `out.push(await db.updateTable("${table}").set({ name: "b", tags: ["x"], status: "failed" }).where("id", "=", 1n).executeTakeFirst());`,
  },
  {
    code: (table) =>
      `try { out.push(await db.deleteFrom("${table}").where("id", "=", 1n).execute()); } catch (error) { if (!isViolation(error, "${table}_owner_id_fkey")) throw error; out.push(error.constraint); }`,
  },
  {
    code: (table) =>
      `out.push(await atomic(db, (trx) => atomic(trx, async (inner) => { const row = await inner.selectFrom("${table}").select(["id", "amount"]).where("email", "is not", null).executeTakeFirstOrThrow(); await inner.updateTable("${table}").set({ amount: row.amount }).where("id", "=", row.id).execute(); return row; })));`,
  },
  {
    code: (_, __, turn) =>
      `out.push(await atomic(db, (trx) => queries.read${turn}(trx, { id: 1n })));`,
    file: (turn, table) =>
      described(
        `read${turn}`,
        `select id, name, status from ${table} where id = :id`,
        { id: keyword("bigint") },
        [
          ["id", keyword("bigint")],
          ["name", keyword("string")],
          ["status", { kind: "alias", name: "Status" }],
        ],
      ),
  },
  {
    code: (_, __, turn) =>
      `out.push(await queries.rename${turn}(db, { id: 1n, name: "c" }));`,
    file: (turn, table) =>
      described(
        `rename${turn}`,
        `update ${table} set name = :name where id = :id`,
        { name: keyword("string"), id: keyword("bigint") },
        null,
      ),
  },
  {
    code: (table) =>
      `{ const controlled = await db.startTransaction().execute(); out.push(await atomic(controlled, (trx) => trx.selectFrom("${table}").select("id").execute())); await controlled.commit().execute(); }`,
  },
];

/** The files of a project of `count` statements, by name. */
function project(count: number): Record<string, string> {
  const files: DescribedQuery[] = [];
  const lines = [
    'import { atomic, database, isViolation } from "@tetsujs/sql";',
    'import { schema } from "./db.generated.ts";',
    'import * as queries from "./queries.generated.ts";',
    "",
    'const db = database(schema, { url: "postgres://localhost/app" });',
    "",
    "export async function run(): Promise<unknown[]> {",
    "  const out: unknown[] = [];",
  ];

  for (let index = 0; index < count; index += 1) {
    const kind = index % statements.length;
    const statement = statements[kind] as Statement;
    const turn = Math.floor(index / statements.length);
    const place =
      (turn + kind * Math.floor(tables / statements.length)) % tables;
    const table = `t${place}`;
    const other = `t${(place * 7 + 1) % tables}`;
    const file = statement.file?.(turn, table);

    if (file !== undefined) {
      files.push(file);
    }

    lines.push(`  ${statement.code(table, other, turn)}`);
  }

  lines.push("  return out;", "}");

  return {
    "db.generated.ts": render(schema(), {
      journal: "migrations",
      migration: {
        name: "20261015000000_schema.sql",
        checksum: "0".repeat(64),
      },
    }),
    "queries.generated.ts": renderQueries(files, {
      base: "/app/src",
      types: "/app/src/db.generated.ts",
    }),
    "app.ts": `${lines.join("\n")}\n`,
  };
}

const compilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: "ESNext",
  lib: ["ESNext"],
  module: "Preserve",
  moduleResolution: "bundler",
  allowImportingTsExtensions: true,
  types: ["bun"],
  typeRoots: [join(root, "node_modules", "@types")],
  paths: {
    "@tetsujs/sql": [join(sql, "dist", "src", "index.d.ts")],
    kysely: [join(kysely, "dist", "index.d.ts")],
  },
};

function field(output: string, name: string): number {
  const match = output.match(new RegExp(`^${name}:\\s+([\\d.]+)`, "m"));

  if (!match?.[1]) {
    throw new Error(`tsc printed no "${name}" line:\n${output}`);
  }

  return Number(match[1]);
}

async function measure(count: number): Promise<Cost> {
  const directory = await mkdtemp(join(tmpdir(), "tetsu-sql-types-"));

  try {
    for (const [name, text] of Object.entries(project(count))) {
      await Bun.write(join(directory, name), text);
    }

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
      throw new Error(`the generated project does not compile:\n${output}`);
    }

    return {
      statements: count,
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

for (const count of ladder) {
  costs.push(await measure(count));
}

console.table(costs);

if (process.argv.includes("--check")) {
  const gated = costs.find((cost) => cost.statements === 200);

  if (gated === undefined || gated.instantiations > budget) {
    console.error(
      `${tables} tables and 200 statements cost ${gated?.instantiations} instantiations, over the budget of ${budget}. If the growth is deliberate, raise the budget in bench/src/sql-types.ts and say why.`,
    );
    process.exit(1);
  }

  console.log(
    `${tables} tables and 200 statements: ${gated.instantiations} of ${budget} instantiations`,
  );
}
