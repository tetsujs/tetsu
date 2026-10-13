/**
 * The migration runner against a real Postgres: what it applies and
 * records, what it refuses before touching anything, how a failure and a
 * migration outside a transaction end, and how two runners share a
 * database.
 *
 * Each `describe` has a database of its own, so its journal starts empty;
 * a test that needs migrations applied first applies them itself or in the
 * `describe`'s `beforeAll`.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { SQL as Client } from "bun";
import { testDatabase } from "../test-utils/database.ts";
import { MigrationError } from "./errors.ts";
import type { MigrationRecord } from "./migrate.ts";
import { migrate } from "./migrate.ts";
import { checksum } from "./migration-files.ts";

const scratch = await mkdtemp(join(tmpdir(), "tetsu-sql-migrate-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A directory of its own holding these migrations. */
async function directory(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(scratch, "dir-"));

  for (const [name, text] of Object.entries(files)) {
    await Bun.write(join(dir, name), text);
  }

  return dir;
}

/** The error a run rejects with. */
async function refusal(run: Promise<unknown>): Promise<MigrationError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof MigrationError) {
      return error;
    }

    throw error;
  }

  throw new Error("the run did not fail");
}

/** The names the journal holds, in order. */
async function journal(sql: SQL, table = "migrations"): Promise<string[]> {
  const rows: { name: string }[] = await sql.unsafe(
    `select name from ${table}`,
  );

  return rows.map((row) => row.name).toSorted();
}

/** Whether a table of that name exists. */
async function exists(sql: SQL, table: string): Promise<boolean> {
  const [row] = await sql`select to_regclass(${table}) is not null as found`;

  return row.found;
}

/** The SQLSTATE of the Postgres error a failed run wraps. */
function sqlstate(error: MigrationError): unknown {
  return (error.cause as { errno?: unknown } | undefined)?.errno;
}

const first = "20261010120000_first.sql";
const second = "20261011120000_second.sql";
const third = "20261012120000_third.sql";
const fourth = "20261013120000_fourth.sql";

describe("runs", () => {
  const { sql } = testDatabase();

  test("apply the pending migrations in order, record each with its checksum, and later only newer ones", async () => {
    const two = {
      [second]: "alter table a\nadd column y int;",
      [first]: "create table a (x int);",
    };

    expect(await migrate(sql, { dir: await directory(two) })).toEqual({
      applied: [first, second],
      ahead: [],
    });

    const rows =
      await sql`select name, checksum, applied_at from migrations order by name`;

    expect(rows.map((row: { name: string }) => row.name)).toEqual([
      first,
      second,
    ]);
    expect(rows[0].checksum).toBe(checksum("create table a (x int);"));
    expect(rows[0].applied_at).toBeInstanceOf(Date);

    const columns = await sql`
      select column_name from information_schema.columns
      where table_name = 'a' order by ordinal_position`;

    expect(
      columns.map((row: { column_name: string }) => row.column_name),
    ).toEqual(["x", "y"]);
    expect(await migrate(sql, { dir: await directory(two) })).toEqual({
      applied: [],
      ahead: [],
    });

    const three = { ...two, [third]: "create table c (x int);" };

    expect(await migrate(sql, { dir: await directory(three) })).toEqual({
      applied: [third],
      ahead: [],
    });
    expect(await journal(sql)).toEqual([first, second, third]);

    const rewritten = {
      ...three,
      [first]: "\uFEFFcreate table a (x int);",
      [second]: "alter table a\r\nadd column y int;",
    };

    expect(await migrate(sql, { dir: await directory(rewritten) })).toEqual({
      applied: [],
      ahead: [],
    });
  });
});

describe("before applying anything, a run refuses", () => {
  const { sql } = testDatabase();
  const applied = {
    [first]: "create table a (x int);",
    [second]: "create table b (x int);",
  };

  beforeAll(async () => {
    await migrate(sql, { dir: await directory(applied) });
  });

  test("an applied migration whose file has changed", async () => {
    const dir = await directory({
      ...applied,
      [first]: "create table a (x int, y int);",
      [third]: "create table c (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("changed");
    expect(error.migration).toBe(first);
    expect(await exists(sql, "c")).toBe(false);
  });

  test("an applied migration whose file is gone", async () => {
    const dir = await directory({
      [second]: applied[second],
      [third]: "create table c (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("missing");
    expect(error.migration).toBe(first);
    expect(await exists(sql, "c")).toBe(false);
  });

  test("a pending migration older than the last applied", async () => {
    const older = "20261010180000_between.sql";
    const dir = await directory({
      ...applied,
      [older]: "create table between_them (x int);",
      [third]: "create table c (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("out-of-order");
    expect(error.migration).toBe(older);
    expect(error.message).toContain(second);
    expect(await exists(sql, "between_them")).toBe(false);
    expect(await exists(sql, "c")).toBe(false);
  });

  test("an empty pending migration", async () => {
    const dir = await directory({ ...applied, [third]: "-- to do\n" });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("empty");
    expect(error.migration).toBe(third);
    expect(await journal(sql)).toEqual([first, second]);
  });

  test("a misnamed .sql file, and does not read other files", async () => {
    const dir = await directory({
      ...applied,
      "notes.md": "not a migration",
      "3_third.sql": "create table c (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("name");
    expect(error.migration).toBe("3_third.sql");
    expect(await exists(sql, "c")).toBe(false);
  });

  test("a directory that is not there", async () => {
    const error = await refusal(
      migrate(sql, { dir: join(scratch, "nowhere") }),
    );

    expect(error.reason).toBe("directory");
  });

  test("a journal table that is not a journal", async () => {
    await sql`create table not_a_journal (id int)`;

    const error = await refusal(
      migrate(sql, { dir: await directory(applied), table: "not_a_journal" }),
    );

    expect(error.reason).toBe("table");
    expect(error.message).toContain("id integer");
    expect(await journal(sql)).toEqual([first, second]);
  });
});

describe("a database ahead of the files", () => {
  const { sql } = testDatabase();

  beforeAll(async () => {
    await migrate(sql, {
      dir: await directory({
        [first]: "create table a (x int);",
        [second]: "create table b (x int);",
        [third]: "create table c (x int);",
      }),
    });
  });

  test("names the applied migrations newer than every file, and applies nothing", async () => {
    const back = await directory({
      [first]: "create table a (x int);",
      [second]: "create table b (x int);",
    });
    const records: MigrationRecord[] = [];

    expect(
      await migrate(sql, {
        dir: back,
        write: (record) => {
          records.push(record);
        },
      }),
    ).toEqual({ applied: [], ahead: [third] });
    expect(records).toEqual([{ event: "ahead", migration: third }]);

    const further = await directory({ [first]: "create table a (x int);" });

    expect(await migrate(sql, { dir: further })).toEqual({
      applied: [],
      ahead: [second, third],
    });
    expect(await journal(sql)).toEqual([first, second, third]);
  });

  test("still refuses a pending migration older than them", async () => {
    const between = "20261011180000_between.sql";
    const dir = await directory({
      [first]: "create table a (x int);",
      [second]: "create table b (x int);",
      [between]: "create table between_them (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("out-of-order");
    expect(error.migration).toBe(between);
    expect(await exists(sql, "between_them")).toBe(false);
  });

  test("refuses one gone as missing once a newer file is there", async () => {
    const dir = await directory({
      [first]: "create table a (x int);",
      [second]: "create table b (x int);",
      [fourth]: "create table d (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("missing");
    expect(error.migration).toBe(third);
    expect(error.message).toBe(
      `${third} was applied, and its file is gone, though newer ones are there: restore it`,
    );
    expect(await exists(sql, "d")).toBe(false);
  });

  test("refuses them all when the directory holds no migration files", async () => {
    const dir = await directory({ "README.md": "not a migration" });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("missing");
    expect(error.migration).toBe(first);
    expect(error.message).toContain("holds no migration files");
  });
});

describe("what a run writes", () => {
  const { sql, url } = testDatabase();

  test("is a record before each migration and after it, with how long it took", async () => {
    const records: MigrationRecord[] = [];
    const dir = await directory({
      [first]: "create table a (x int);",
      [second]: "create table b (x int);\nselect 1 / 0;",
    });
    const error = await refusal(
      migrate(sql, {
        dir,
        write: (record) => {
          records.push(record);
        },
      }),
    );

    expect(error.reason).toBe("failed");
    expect(records).toEqual([
      { event: "applying", migration: first },
      { event: "applied", migration: first, durationMs: expect.any(Number) },
      { event: "applying", migration: second },
    ]);
    expect(String((records[1] as { durationMs: number }).durationMs)).toMatch(
      /^\d+(\.\d{1,3})?$/,
    );
  });

  test("says when it waits for another run", async () => {
    const dir = await directory({
      [first]: "create table waited (x int);\nselect pg_sleep(0.5);",
    });
    const other = new Client(url);
    const writes: MigrationRecord[][] = [[], []];

    try {
      await Promise.all(
        [sql, other].map((client, index) =>
          migrate(client, {
            dir,
            table: "waiting_journal",
            write: (record) => {
              writes[index]?.push(record);
            },
          }),
        ),
      );

      expect(
        writes.filter((records) => records[0]?.event === "waiting"),
      ).toEqual([[{ event: "waiting" }]]);
    } finally {
      await other.close();
    }
  });
});

describe("a failing migration", () => {
  const { sql } = testDatabase();

  test("is rolled back and not recorded, the ones before it stay, and a fixed run goes on from it", async () => {
    const broken = {
      [first]: "create table a (x int);",
      [second]: "create table b (x int);\nselect 1 / 0;",
      [third]: "create table c (x int);",
    };
    const error = await refusal(migrate(sql, { dir: await directory(broken) }));

    expect(error.reason).toBe("failed");
    expect(error.migration).toBe(second);
    expect(error.message).toStartWith(`${second} failed: `);
    expect(error.applied).toEqual([first]);
    expect(sqlstate(error)).toBe("22012");
    expect(await journal(sql)).toEqual([first]);
    expect(await exists(sql, "a")).toBe(true);
    expect(await exists(sql, "b")).toBe(false);
    expect(await exists(sql, "c")).toBe(false);

    const fixed = { ...broken, [second]: "create table b (x int);" };

    expect(await migrate(sql, { dir: await directory(fixed) })).toEqual({
      applied: [second, third],
      ahead: [],
    });
  });
});

describe("a migration with an error Postgres points at", () => {
  const { sql } = testDatabase();

  test("fails with the line of it", async () => {
    const dir = await directory({
      [first]: "create table a (x int);\n\ncreate tabel b (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.message).toBe(
      `${first} failed at line 3: syntax error at or near "tabel"`,
    );
    expect(error.applied).toEqual([]);
  });

  test("counts the characters before it as Postgres does, not in UTF-16 units", async () => {
    const sushi = String.fromCodePoint(0x1f363);
    const dir = await directory({ [first]: `-- ${sushi}\ntabel;` });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.message).toStartWith(`${first} failed at line 2: `);
  });
});

describe("a migration that ends its own transaction", () => {
  const { sql } = testDatabase();

  test("with a COMMIT is refused and not recorded, and what it ran stays", async () => {
    const dir = await directory({
      [first]:
        "create table early (x int);\ncommit;\ncreate table late (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("own-transaction");
    expect(error.migration).toBe(first);
    expect(error.message).toContain("part of it may stay applied");
    expect(await journal(sql)).toEqual([]);
    expect(await exists(sql, "early")).toBe(true);
    expect(await exists(sql, "late")).toBe(true);
  });

  test("with a ROLLBACK is refused and not recorded, and what ran after it stays", async () => {
    const dir = await directory({
      [first]:
        "create table undone (x int);\nrollback;\ncreate table kept (x int);",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("own-transaction");
    expect(await journal(sql)).toEqual([]);
    expect(await exists(sql, "undone")).toBe(false);
    expect(await exists(sql, "kept")).toBe(true);
  });

  test("with a COMMIT, then a failure, is refused as one, with the failure as the cause", async () => {
    const dir = await directory({
      [first]: "create table committed_early (x int);\ncommit;\nselect 1 / 0;",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("own-transaction");
    expect(sqlstate(error)).toBe("22012");
    expect(await journal(sql)).toEqual([]);
    expect(await exists(sql, "committed_early")).toBe(true);
  });

  test("with a ROLLBACK, then a failure, failed, and nothing of it stays", async () => {
    const dir = await directory({
      [first]:
        "create table gone_early (x int);\nrollback;\ncreate table gone_late (x int);\nselect 1 / 0;",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("failed");
    expect(await exists(sql, "gone_early")).toBe(false);
    expect(await exists(sql, "gone_late")).toBe(false);
  });
});

describe("what a migration sets for its session", () => {
  const { sql } = testDatabase();

  test("does not reach the next migration, nor the journal", async () => {
    const dir = await directory({
      [first]:
        "select pg_catalog.set_config('search_path', '', false);\ncreate table public.dumped (x int);",
      [second]:
        "create schema app;\nset search_path = app, public;\nset role pg_read_all_data;\ncreate temp table scratch (x int);",
      [third]:
        "-- no-transaction\nset search_path = app, public;\nset session authorization pg_read_all_data;",
      [fourth]:
        "create table placed (x int);\ncreate temp table scratch (x int);",
    });

    expect(await migrate(sql, { dir })).toEqual({
      applied: [first, second, third, fourth],
      ahead: [],
    });
    expect(await journal(sql)).toEqual([first, second, third, fourth]);

    const [placed] = await sql`
      select schemaname as schema, tableowner = session_user as own
      from pg_tables where tablename = 'placed'`;

    expect(placed).toEqual({ schema: "public", own: true });
  });
});

describe("what the application set for the session the run takes", () => {
  const { url } = testDatabase();

  test("is reset before the run reads anything", async () => {
    const sql = new Client(url, { max: 1 });

    try {
      await sql`set search_path = nowhere`;
      await sql`set role pg_read_all_data`;

      const dir = await directory({ [first]: "create table a (x int);" });

      expect(await migrate(sql, { dir })).toEqual({
        applied: [first],
        ahead: [],
      });

      const [table] = await sql`
        select schemaname as schema, tableowner = session_user as own
        from pg_tables where tablename = 'a'`;

      expect(table).toEqual({ schema: "public", own: true });
    } finally {
      await sql.close();
    }
  });
});

describe("a migration marked -- no-transaction", () => {
  const { sql } = testDatabase();

  test("runs outside a transaction, so CREATE INDEX CONCURRENTLY works, and is recorded", async () => {
    const dir = await directory({
      [first]: "create table a (x int);",
      [second]: "-- no-transaction\ncreate index concurrently a_x on a (x);",
    });

    expect(await migrate(sql, { dir })).toEqual({
      applied: [first, second],
      ahead: [],
    });
    expect(await exists(sql, "a_x")).toBe(true);
  });

  test("waits for older transactions as long as they take, whatever lockTimeoutMs says", async () => {
    await sql`create table busy (x int)`;
    await sql`create table elsewhere (x int)`;

    const holder = await sql.reserve();

    try {
      await holder`begin isolation level repeatable read`;
      await holder`select count(*) from elsewhere`;

      const dir = await directory({
        [first]: "create table a (x int);",
        [second]: "-- no-transaction\ncreate index concurrently a_x on a (x);",
        [third]:
          "-- no-transaction\ncreate index concurrently busy_x on busy (x);",
      });
      const started = performance.now();
      const run = migrate(sql, { dir, lockTimeoutMs: 100 });

      await Bun.sleep(500);
      await holder`commit`;

      expect(await run).toEqual({ applied: [third], ahead: [] });
      expect(performance.now() - started).toBeGreaterThanOrEqual(500);

      const [index] = await sql`
        select indisvalid as valid from pg_index
        where indexrelid = 'busy_x'::regclass`;

      expect(index.valid).toBe(true);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });
});

describe("a migration marked -- no-transaction with its own BEGIN", () => {
  const { url } = testDatabase();

  test("and no COMMIT is committed with its record", async () => {
    const sql = new Client(url, { max: 1 });

    try {
      const dir = await directory({
        [first]: "-- no-transaction\nbegin;\ncreate table opened (x int);",
      });

      expect(await migrate(sql, { dir })).toEqual({
        applied: [first],
        ahead: [],
      });
    } finally {
      await sql.close();
    }

    const check = new Client(url);

    try {
      expect(await journal(check)).toEqual([first]);
      expect(await exists(check, "opened")).toBe(true);
    } finally {
      await check.close();
    }
  });

  test("that fails leaves the client clean: its next query and run go through", async () => {
    const sql = new Client(url, { max: 1 });

    try {
      const broken = await directory({
        [first]: "-- no-transaction\nbegin;\ncreate table opened (x int);",
        [second]:
          "-- no-transaction\nbegin;\ncreate table aborted (x int);\nselect 1 / 0;",
      });
      const error = await refusal(migrate(sql, { dir: broken }));

      expect(error.reason).toBe("failed");
      expect(sqlstate(error)).toBe("22012");
      expect(await exists(sql, "aborted")).toBe(false);

      const fixed = await directory({
        [first]: "-- no-transaction\nbegin;\ncreate table opened (x int);",
        [second]: "create table aborted (x int);",
      });

      expect(await migrate(sql, { dir: fixed })).toEqual({
        applied: [second],
        ahead: [],
      });
    } finally {
      await sql.close();
    }
  });
});

describe("a migration marked -- no-transaction with other statements", () => {
  const { sql } = testDatabase();

  test("fails when CONCURRENTLY shares the file with them", async () => {
    const dir = await directory({
      [first]: "create table a (x int);",
      [second]:
        "-- no-transaction\ncreate index concurrently a_y on a (x);\nselect 1;",
    });
    const error = await refusal(migrate(sql, { dir }));

    expect(error.reason).toBe("failed");
    expect(error.migration).toBe(second);
    expect(sqlstate(error)).toBe("25001");
    expect(await journal(sql)).toEqual([first]);
  });
});

describe("a lock a migration waits for", () => {
  const { sql } = testDatabase();

  test("ends it with 55P03 after lockTimeoutMs", async () => {
    await migrate(sql, {
      dir: await directory({ [first]: "create table a (x int);" }),
    });

    const holder = await sql.reserve();

    try {
      await holder`begin`;
      await holder`lock table a in access share mode`;

      const dir = await directory({
        [first]: "create table a (x int);",
        [second]: "alter table a add column y int;",
      });
      const started = performance.now();
      const error = await refusal(migrate(sql, { dir, lockTimeoutMs: 200 }));
      const waited = performance.now() - started;

      expect(error.reason).toBe("failed");
      expect(error.migration).toBe(second);
      expect(sqlstate(error)).toBe("55P03");
      expect(waited).toBeGreaterThanOrEqual(200);
      expect(waited).toBeLessThan(5000);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });
});

describe("timeouts the database sets for its sessions", () => {
  const { sql, name, url } = testDatabase();

  beforeAll(async () => {
    await sql.unsafe(`alter database ${name} set lock_timeout = '100ms'`);
    await sql.unsafe(`alter database ${name} set statement_timeout = '300ms'`);
  });

  test("cut neither a runner's wait for another nor a migration outside a transaction", async () => {
    const one = new Client(url);
    const two = new Client(url);

    try {
      const dir = await directory({
        [first]: "set local statement_timeout = 0;\nselect pg_sleep(0.6);",
        [second]: "-- no-transaction\nselect pg_sleep(0.4);",
      });
      const runs = await Promise.all([
        migrate(one, { dir }),
        migrate(two, { dir }),
      ]);

      expect(
        runs.map((run) => run.applied).toSorted((a, b) => a.length - b.length),
      ).toEqual([[], [first, second]]);
    } finally {
      await one.close();
      await two.close();
    }
  });

  test("hold in a migration in a transaction, which can lift them itself", async () => {
    const client = new Client(url);

    try {
      const dir = await directory({ [first]: "select pg_sleep(0.5);" });
      const error = await refusal(
        migrate(client, { dir, table: "slow_journal" }),
      );

      expect(error.migration).toBe(first);
      expect(sqlstate(error)).toBe("57014");
    } finally {
      await client.close();
    }
  });
});

describe("two runners started together", () => {
  const { sql, url } = testDatabase();

  test("apply each migration once: one applies them, the other waits and finds nothing", async () => {
    const dir = await directory({
      [first]: "create table a (x int);\nselect pg_sleep(0.2);",
      [second]: "create table b (x int);",
    });
    const other = new Client(url);

    try {
      const runs = await Promise.all([
        migrate(sql, { dir }),
        migrate(other, { dir }),
      ]);
      const lists = runs
        .map((run) => run.applied)
        .toSorted((a, b) => a.length - b.length);

      expect(lists).toEqual([[], [first, second]]);
      expect(await journal(sql)).toEqual([first, second]);
    } finally {
      await other.close();
    }
  });
});

describe("two runners naming the journal with its schema and without", () => {
  const { sql, url } = testDatabase();

  test("wait for each other, as they write one journal", async () => {
    const dir = await directory({
      [first]: "create table a (x int);\nselect pg_sleep(0.2);",
      [second]: "create table b (x int);",
    });
    const other = new Client(url);

    try {
      const runs = await Promise.all([
        migrate(sql, { dir }),
        migrate(other, { dir, table: "public.migrations" }),
      ]);

      expect(
        runs.map((run) => run.applied).toSorted((a, b) => a.length - b.length),
      ).toEqual([[], [first, second]]);
    } finally {
      await other.close();
    }
  });
});

describe("the journal", () => {
  const { sql, url } = testDatabase();

  test("can be named, with a schema or without", async () => {
    await sql`create schema ops`;

    const dir = await directory({ [first]: "create table a (x int);" });

    expect(await migrate(sql, { dir, table: "schema_history" })).toEqual({
      applied: [first],
      ahead: [],
    });
    expect(await journal(sql, "schema_history")).toEqual([first]);
    expect(await exists(sql, "migrations")).toBe(false);

    const elsewhere = await directory({
      [first]: "create table ops.a (x int);",
    });

    expect(
      await migrate(sql, { dir: elsewhere, table: "ops.history" }),
    ).toEqual({ applied: [first], ahead: [] });
    expect(await journal(sql, "ops.history")).toEqual([first]);

    const keyword = await directory({ [first]: "create table c (x int);" });

    expect(await migrate(sql, { dir: keyword, table: "order" })).toEqual({
      applied: [first],
      ahead: [],
    });
    expect(await journal(sql, '"order"')).toEqual([first]);
  });

  test("is the table its name finds, though the search_path puts another schema first", async () => {
    await sql`create schema first_in_path`;

    const dir = await directory({ [first]: "create table found (x int);" });

    expect(await migrate(sql, { dir, table: "found_journal" })).toEqual({
      applied: [first],
      ahead: [],
    });

    const shifted = new Client(url, {
      connection: { search_path: "first_in_path, public" },
    });

    try {
      expect(await migrate(shifted, { dir, table: "found_journal" })).toEqual({
        applied: [],
        ahead: [],
      });
      expect(await exists(sql, "first_in_path.found_journal")).toBe(false);
    } finally {
      await shifted.close();
    }
  });

  test("is created in the first schema of the search_path, and found there, whatever its name", async () => {
    await sql`create schema "Ops"`;

    const dir = await directory({ [first]: "create table ops_a (x int);" });
    const shouting = new Client(url, {
      connection: { search_path: '"Ops"' },
    });

    try {
      expect(await migrate(shouting, { dir, table: "ops_journal" })).toEqual({
        applied: [first],
        ahead: [],
      });
      expect(await migrate(shouting, { dir, table: "ops_journal" })).toEqual({
        applied: [],
        ahead: [],
      });
      expect(await journal(sql, '"Ops".ops_journal')).toEqual([first]);
    } finally {
      await shouting.close();
    }
  });

  test("is created with its schema, when that is missing too", async () => {
    const dir = await directory({ [first]: "create table d (x int);" });

    expect(await migrate(sql, { dir, table: "fresh.journal" })).toEqual({
      applied: [first],
      ahead: [],
    });
    expect(await journal(sql, "fresh.journal")).toEqual([first]);
  });

  test("is refused when no schema of the search_path exists to hold it", async () => {
    const lost = new Client(url, { connection: { search_path: "nowhere" } });

    try {
      const dir = await directory({ [first]: "select 1;" });
      const error = await refusal(migrate(lost, { dir }));

      expect(error.reason).toBe("table");
      expect(error.message).toContain("no schema of the search_path exists");
    } finally {
      await lost.close();
    }
  });

  test.each([
    ["Migrations", "an uppercase letter"],
    ["migrations; drop table a", "a statement"],
    ['"migrations"', "quotes"],
    ["a.b.c", "two dots"],
    ["", "nothing"],
  ])("refuses the name %j, with %s, as a TypeError", async (table) => {
    const dir = await directory({ [first]: "select 1;" });

    await expect(migrate(sql, { dir, table })).rejects.toThrow(TypeError);
  });
});

describe("lockTimeoutMs", () => {
  const { sql } = testDatabase();

  test.each([-1, 1.5, Number.NaN, 2 ** 31])(
    "refuses %p as a TypeError",
    async (lockTimeoutMs) => {
      const dir = await directory({ [first]: "select 1;" });

      await expect(migrate(sql, { dir, lockTimeoutMs })).rejects.toThrow(
        TypeError,
      );
    },
  );

  test("of 0 waits as long as it takes", async () => {
    const dir = await directory({ [first]: "create table a (x int);" });

    expect(await migrate(sql, { dir, lockTimeoutMs: 0 })).toEqual({
      applied: [first],
      ahead: [],
    });
  });
});

describe("the connection a run used", () => {
  const { url } = testDatabase();

  test("is closed, so nothing a migration set for its session reaches the application", async () => {
    const sql = new Client(url, { max: 1 });

    try {
      const dir = await directory({
        [first]: "-- no-transaction\nset statement_timeout = 1234;",
        [second]:
          "set role pg_read_all_data;\ncreate temp table scratch (x int);",
      });

      await migrate(sql, { dir });

      const [row] = await sql`
        select current_user = session_user as own,
               current_setting('statement_timeout') as statement,
               current_setting('lock_timeout') as lock,
               to_regclass('pg_temp.scratch') as scratch,
               (select count(*)::int from pg_locks
                where locktype = 'advisory'
                  and database = (select oid from pg_database
                                  where datname = current_database())) as locks`;

      expect(row).toEqual({
        own: true,
        statement: "0",
        lock: "0",
        scratch: null,
        locks: 0,
      });
    } finally {
      await sql.close();
    }
  });
});

describe("a client for another database", () => {
  test("is refused as a TypeError", async () => {
    const lite = new Client(":memory:");

    try {
      const dir = await directory({ [first]: "select 1;" });

      await expect(migrate(lite, { dir })).rejects.toThrow(
        "migrate runs on Postgres, and this client is for sqlite",
      );
    } finally {
      await lite.close();
    }
  });
});

describe("the runner's advisory lock", () => {
  const { url } = testDatabase();

  test("does not wait on the application's own advisory locks", async () => {
    const sql = new Client(url);
    const holder = await sql.reserve();

    try {
      await holder`select pg_advisory_lock(1, hashtext('migrations'))`;

      const dir = await directory({
        [first]: "create table locks_apart (x int);",
      });

      expect(await migrate(sql, { dir })).toEqual({
        applied: [first],
        ahead: [],
      });
    } finally {
      await holder`select pg_advisory_unlock(1, hashtext('migrations'))`;
      holder.release();
      await sql.close();
    }
  });
});
