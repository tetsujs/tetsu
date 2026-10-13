/**
 * `generate()` against a real Postgres: the files of the fixture
 * migrations and queries are the ones checked in beside them, on Postgres
 * 14 and 18 alike, and the scratch database they are built on is gone
 * afterwards, when the migrations or the queries fail as well.
 *
 * The files checked in are type-checked with the repository; the types
 * are held to Kysely by `generate.test-d.ts`, and the queries are run by
 * `queries.test.ts`.
 *
 * @module
 */

import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import { MigrationError } from "./errors.ts";
import { generate } from "./generate.ts";
import { migrate } from "./migrate.ts";
import { QueryFileError } from "./query-files.ts";

const fixtures = join(import.meta.dir, "../test-utils/fixtures/schema");
const golden = await Bun.file(join(fixtures, "db.generated.ts")).text();
const goldenQueries = await Bun.file(
  join(fixtures, "queries.generated.ts"),
).text();

/** Where the fixture's files go, as `generate` is given them. */
const queries = {
  dir: join(fixtures, "queries"),
  out: join(fixtures, "queries.generated.ts"),
  types: join(fixtures, "db.generated.ts"),
};
const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-generate-"));
setDefaultTimeout(DATABASE_MS);

const { url } = testDatabase();
const sql = new SQL(url);

afterAll(async () => {
  await sql.close();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Runs `use` and returns the names of the scratch databases it made: each
 * is named by a UUIDv7 of `Bun.randomUUIDv7()`, which is watched while it
 * runs. Other runs on the same server make databases of their own, which a
 * list of the server's would count.
 */
async function scratchMadeBy(use: () => Promise<unknown>): Promise<string[]> {
  const made: string[] = [];
  const original = Bun.randomUUIDv7.bind(Bun);
  const watched = spyOn(Bun, "randomUUIDv7").mockImplementation(((
    ...args: Parameters<typeof Bun.randomUUIDv7>
  ) => {
    const uuid = original(...args);

    made.push(`tetsu_sql_${String(uuid).replaceAll("-", "")}`);

    return uuid;
  }) as typeof Bun.randomUUIDv7);

  try {
    await use();
  } finally {
    watched.mockRestore();
  }

  return made;
}

/** Which of these databases are on the server. */
async function existing(names: readonly string[]): Promise<string[]> {
  const rows: { name: string }[] = await sql`
    select datname as name from pg_database where datname = any(${sql.array([...names], "text")})`;

  return rows.map((row) => row.name);
}

/** A directory of its own holding these migrations. */
async function directory(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(scratch, "dir-"));

  for (const [name, text] of Object.entries(files)) {
    await Bun.write(join(dir, name), text);
  }

  return dir;
}

describe("the types of the fixture migrations", () => {
  test("are the file checked in beside them, each time, and leave no database", async () => {
    const dir = join(fixtures, "migrations");
    const made = await scratchMadeBy(async () => {
      expect((await generate({ url, dir })).types).toBe(golden);
      expect((await generate({ url, dir })).types).toBe(golden);
    });

    expect(made).toHaveLength(2);
    expect(await existing(made)).toEqual([]);
  });

  test("are built on a database of their own, not the client's", async () => {
    await generate({ url, dir: join(fixtures, "migrations") });

    const [row] = await sql`
      select count(*)::int as tables from pg_tables where schemaname = 'public'`;

    expect(row.tables).toBe(0);
  });
});

describe("the functions of the fixture queries", () => {
  test("are the file checked in beside them, with the same types, each time, and leave no database", async () => {
    const dir = join(fixtures, "migrations");
    const made = await scratchMadeBy(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await generate({ url, dir, queries })).toEqual({
          types: golden,
          queries: goldenQueries,
        });
      }
    });

    expect(made).toHaveLength(2);
    expect(await existing(made)).toEqual([]);
  });

  test("are none when no queries are asked for", async () => {
    expect(
      await generate({ url, dir: join(fixtures, "migrations") }),
    ).toMatchObject({ queries: undefined });
  });

  test("that Postgres refuses fail the run, each told, and leave no database", async () => {
    const dir = await directory({
      "20260101000000_t.sql": "create table t (id int8 primary key);",
    });
    const files = await directory({
      "fine.sql": "select id from t",
      "wrong.sql": "select qqqqqq from t",
      "worse.sql": "select id,\n  :x from t where id = $1",
    });
    const made = await scratchMadeBy(async () => {
      const error = await generate({
        url,
        dir,
        queries: {
          dir: files,
          out: join(files, "q.ts"),
          types: join(files, "t.ts"),
        },
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(QueryFileError);
      expect((error as Error).message).toBe(
        `${join(files, "worse.sql")}:2:24: takes parameters by name, as :id, not by number, as $1`,
      );
    });

    expect(made).toEqual([]);

    const described = await scratchMadeBy(async () => {
      await Bun.write(join(files, "worse.sql"), "select :x::int8 as x");

      const error = await generate({
        url,
        dir,
        queries: {
          dir: files,
          out: join(files, "q.ts"),
          types: join(files, "t.ts"),
        },
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(QueryFileError);
      expect((error as Error).message).toBe(
        `${join(files, "wrong.sql")}:1:8: column "qqqqqq" does not exist`,
      );
    });

    expect(described).toHaveLength(1);
    expect(await existing(described)).toEqual([]);
  });
});

describe("the journal", () => {
  test("in a schema of its own is created with its schema, and left out of DB", async () => {
    const dir = await directory({
      "20261010120000_first.sql": "create table orders (id int4 primary key);",
    });
    const { types: source } = await generate({
      url,
      dir,
      table: "ops.migrations",
    });

    expect(source).toContain('  journal: "ops.migrations",\n');
    expect(source).not.toContain('"ops.migrations": {');
    expect(source).toContain("  orders: {\n");
  });

  test("is the table it was before the migrations ran, not one they made earlier in the search_path", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        do $$
        begin
          execute format('create schema %I', current_user);
          execute format(
            'create table %I.migrations (batch int4 primary key)',
            current_user
          );
        end
        $$;
        create table orders (id int4 primary key);`,
    });
    const { types: source } = await generate({ url, dir });
    const [role] = await sql`select current_user as name`;

    expect(source).toContain(
      `  "${role.name}.migrations": {\n    batch: number;\n  };`,
    );
    expect(source).toContain(
      'export type Constraint = "migrations_pkey" | "orders_pkey";',
    );
    expect(source).not.toContain("  migrations: {");
  });

  test("is the table it is given, recorded and left out of DB", async () => {
    const dir = await directory({
      "20261010120000_first.sql": "create table orders (id int4 primary key);",
    });
    const { types: source } = await generate({
      url,
      dir,
      table: "ops_journal",
    });

    expect(source).toContain('  journal: "ops_journal",\n');
    expect(source).toContain("  orders: {\n    id: number;\n  };\n");
    expect(source).not.toContain("ops_journal: {");
    expect(source).not.toContain('"ops_journal_pkey"');
  });
});

describe("an alias", () => {
  test("whose name is taken, by another or by the file, takes a number", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create type orders_status as enum ('a', 'b');
        create type public.json as enum ('j');
        create table orders (
          status text check (status in ('x', 'y')),
          kind public.json
        );`,
    });
    const { types: source } = await generate({ url, dir });

    expect(source).toContain('export type OrdersStatus = "a" | "b";');
    expect(source).toContain('export type OrdersStatus2 = "x" | "y";');
    expect(source).toContain('export type Json2 = "j";');
    expect(source).toContain("    status: OrdersStatus2 | null;\n");
    expect(source).toContain("    kind: Json2 | null;\n");
  });

  test("never takes a name the file uses, nor a character an identifier cannot hold", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create type date as enum ('today', 'tomorrow');
        create type buffer as enum ('small', 'large');
        create type record as enum ('a');
        create type "area_m²" as enum ('small', 'large');
        create table nothing ();
        create table events (
          at timestamptz not null,
          day public.date not null,
          on_day date not null,
          payload bytea not null,
          slot buffer not null,
          size "area_m²" not null
        );`,
    });
    const { types: source } = await generate({ url, dir });

    expect(source).toContain('export type Date2 = "today" | "tomorrow";');
    expect(source).toContain('export type Buffer2 = "small" | "large";');
    expect(source).toContain('export type Record2 = "a";');
    expect(source).toContain('export type AreaM = "small" | "large";');
    expect(source).toContain(
      "    at: Timestamp;\n    day: Date2;\n    on_day: CalendarDate;\n",
    );
    expect(source).toContain("  nothing: Record<never, never>;\n");
  });

  test("of a relation that would share its key with another is refused", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create schema a;
        create table a.b (x int4);
        create table "a.b" (y text);`,
    });

    await expect(generate({ url, dir })).rejects.toThrow(
      'two relations would both be "a.b" in DB',
    );
  });
});

describe("the columns of arrays", () => {
  test("of tables, views and materialized views are listed, each with its element type's delimiter", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create domain codes as text[];
        create domain payload as jsonb;
        create domain payloads as jsonb[];
        create table shapes (
          id int4 primary key,
          boxes box[],
          points point[],
          tags text[],
          labels codes,
          notes json[],
          documents payload[],
          versions payloads
        );
        create view shape_view as select id, boxes, tags from shapes;
        create materialized view shape_counts as select tags from shapes;`,
    });
    const { types: source } = await generate({ url, dir });

    expect(source).toContain(
      [
        "  arrays: {",
        "    shape_counts: {",
        '      tags: ",",',
        "    },",
        "    shape_view: {",
        '      boxes: ";",',
        '      tags: ",",',
        "    },",
        "    shapes: {",
        '      boxes: ";",',
        '      points: ",",',
        '      tags: ",",',
        '      labels: ",",',
        '      notes: "json",',
        '      documents: "json",',
        '      versions: "json",',
        "    },",
        "  },",
      ].join("\n"),
    );
  });
});

describe("a collation that does not tell values apart by their characters", () => {
  test("lets a column's list take values outside it, but not a domain's, so only the domain's narrows", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
        create domain ci_kind as text collate ci check (value in ('retail', 'bulk'));
        create table tones (
          tone text collate ci not null check (tone in ('loud', 'soft')),
          kind ci_kind
        );`,
    });
    const { types: source } = await generate({ url, dir });

    expect(source).toContain("    tone: string;\n    kind: CiKind | null;\n");
    expect(source).toContain('export type CiKind = "retail" | "bulk";');

    await migrate(sql, { dir, table: "collation_journal" });
    await sql`insert into tones (tone) values ('LOUD')`;

    const refused =
      await sql`insert into tones (tone, kind) values ('soft', 'RETAIL')`.catch(
        (error: { errno?: string }) => error.errno,
      );

    expect(refused).toBe("23514");
  });
});

describe("a not-null constraint not valid yet, on Postgres 18", () => {
  test("leaves the column nullable: the rows before it may hold NULL", async () => {
    const [server] =
      await sql`select current_setting('server_version_num')::int as version`;

    if (server.version < 180000) {
      return;
    }

    const dir = await directory({
      "20261010120000_first.sql": `
        create table legacy (id int4 primary key, email text);
        insert into legacy values (1, null);`,
      "20261011120000_tighten.sql": `
        alter table legacy add constraint legacy_email_not_null not null email not valid;`,
    });
    const { types: source } = await generate({ url, dir });

    expect(source).toContain("    email: string | null;\n");
  });
});

describe("migrations that fail", () => {
  test("fail the run, and the scratch database is dropped", async () => {
    const dir = await directory({
      "20261010120000_first.sql": "create table a (id int4);",
      "20261011120000_broken.sql": "select 1 / 0;",
    });
    let error: unknown;
    const made = await scratchMadeBy(async () => {
      error = await generate({ url, dir }).catch((failure: unknown) => failure);
    });

    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({
      reason: "failed",
      migration: "20261011120000_broken.sql",
      applied: ["20261010120000_first.sql"],
    });
    expect(made).toHaveLength(1);
    expect(await existing(made)).toEqual([]);
  });

  test("with a journal name that cannot be one are refused before any database is made", async () => {
    const role = `tetsu_sql_role_${Bun.randomUUIDv7().replaceAll("-", "")}`;

    await sql.unsafe(`create role ${role} login nocreatedb password 'scratch'`);

    const limited = new URL(url);

    limited.username = role;
    limited.password = "scratch";

    try {
      await expect(
        generate({
          url: limited.href,
          dir: await directory({}),
          table: "Bad Name",
        }),
      ).rejects.toThrow('"Bad Name" cannot name the journal');
    } finally {
      await sql.unsafe(`drop role ${role}`);
    }
  });

  test("in a directory that is not there make no scratch database at all", async () => {
    let error: unknown;
    const made = await scratchMadeBy(async () => {
      error = await generate({ url, dir: join(scratch, "nowhere") }).catch(
        (failure: unknown) => failure,
      );
    });

    expect(error).toMatchObject({ reason: "directory" });
    expect(made).toEqual([]);
  });
});

describe("no migrations", () => {
  test("make the file of an empty database, from no migration", async () => {
    const { types: source } = await generate({
      url,
      dir: await directory({}),
    });

    expect(source).toContain("as there are no migrations yet");
    expect(source).toContain("export type DB = Record<never, never>;");
    expect(source).toContain("export type Constraint = never;");
    expect(source).toContain("  migration: null,\n");
    expect(source).not.toContain("kysely");
  });
});

describe("the URL", () => {
  test("of another kind of database is refused as a TypeError", async () => {
    await expect(
      generate({ url: "sqlite://types.db", dir: await directory({}) }),
    ).rejects.toThrow(
      "generate runs on Postgres: url must be a postgres:// or postgresql:// URL",
    );
  });

  test("holds for the scratch database as written, options and all, whatever DATABASE_URL says", async () => {
    const dir = await directory({
      "20261010120000_first.sql": `
        create schema app;
        create table app.orders (id int4 primary key);`,
      "20261011120000_second.sql": "alter table orders add column note text;",
    });
    const options = new URL(url);

    options.searchParams.set("options", "-c search_path=app,public");

    const saved = Bun.env.DATABASE_URL;

    Bun.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/nowhere";

    try {
      const { types: source } = await generate({ url: options.href, dir });

      expect(source).toContain(
        '  "app.orders": {\n    id: number;\n    note: string | null;\n  };',
      );
    } finally {
      Bun.env.DATABASE_URL = saved;
    }
  });
});
