/**
 * What the migration runner relies on: how Bun.SQL runs a file of several
 * statements, in a transaction and out of one, how a lock timeout ends a
 * wait, and how an advisory lock keeps two runners apart.
 *
 * @module
 */

import { beforeAll, expect, test } from "bun:test";
import { testDatabase } from "../test-utils/database.ts";
import { failure } from "./values.ts";

const { sql } = testDatabase();

beforeAll(async () => {
  await sql`create table locked (id int)`;
});

/** `ok`, or the SQLSTATE (or the client's code) a statement fails with. */
function outcome(statement: Promise<unknown>): Promise<string> {
  return statement.then(() => "ok", failure);
}

/** Whether a table of that name exists. */
async function exists(table: string): Promise<boolean> {
  const [row] = await sql`select to_regclass(${table}) is not null as found`;

  return row.found;
}

test("a query without parameters may hold several statements, one with parameters may not", async () => {
  const results = await sql.unsafe("select 1 as a; select 2 as b", []);

  expect(results).toEqual([[{ a: 1 }], [{ b: 2 }]]);
  expect(
    await outcome(sql.unsafe("select $1::int as a; select 2 as b", [1])),
  ).toBe("42601");
});

test("several statements in one query run as one transaction, so a failure undoes them all", async () => {
  const file =
    "create table first (a int); create table second (a int); select 1 / 0";

  expect(await outcome(sql.unsafe(file).simple())).toBe("22012");
  expect(await exists("first")).toBe(false);
  expect(await exists("second")).toBe(false);
});

test("CREATE INDEX CONCURRENTLY runs alone, and refuses to run with other statements", async () => {
  const together = sql
    .unsafe("create index concurrently locked_a on locked (id); select 1")
    .simple();
  const alone = sql
    .unsafe("create index concurrently locked_b on locked (id)")
    .simple();

  expect(await outcome(together)).toBe("25001");
  expect(await outcome(alone)).toBe("ok");
});

test("a file runs whole inside sql.begin(), and a failure rolls all of it back", async () => {
  await sql.begin(async (tx) => {
    await tx
      .unsafe("create table kept (a int); create table also_kept (a int)")
      .simple();
  });

  const failed = sql.begin(async (tx) => {
    await tx.unsafe("create table rolled_back (a int); select 1 / 0").simple();
  });

  expect(await outcome(failed)).toBe("22012");
  expect(await exists("kept")).toBe(true);
  expect(await exists("also_kept")).toBe(true);
  expect(await exists("rolled_back")).toBe(false);
});

test("a COMMIT in the file ends sql.begin()'s transaction early, and what came before it stays", async () => {
  const file =
    "create table early (a int); commit; create table late (a int); select 1 / 0";
  const failed = sql.begin(async (tx) => {
    await tx.unsafe(file).simple();
  });

  expect(await outcome(failed)).toBe("22012");
  expect(await exists("early")).toBe(true);
  expect(await exists("late")).toBe(false);
});

test("Bun refuses a bare BEGIN on the pool", async () => {
  expect(await outcome(sql`begin`)).toBe("ERR_POSTGRES_UNSAFE_TRANSACTION");
});

test("lock_timeout ends a wait for a lock with 55P03, and without it the wait lasts", async () => {
  const holder = await sql.reserve();

  try {
    await holder`begin`;
    await holder`lock table locked in access share mode`;

    const started = performance.now();
    const [bounded, unbounded] = await Promise.all([
      outcome(
        sql.begin(async (tx) => {
          await tx`set local lock_timeout = '200ms'`;
          await tx`alter table locked add column b int`;
        }),
      ),
      outcome(
        sql.begin(async (tx) => {
          await tx`set local statement_timeout = '600ms'`;
          await tx`alter table locked add column c int`;
        }),
      ).then((code) => ({ code, waited: performance.now() - started })),
    ]);

    expect(bounded).toBe("55P03");
    expect(unbounded.code).toBe("57014");
    expect(unbounded.waited).toBeGreaterThanOrEqual(600);
  } finally {
    await holder`rollback`;
    holder.release();
  }
});

test("a session's advisory lock keeps other sessions out across its transactions, failed ones too", async () => {
  const first = await sql.reserve();
  const second = await sql.reserve();

  try {
    const [taken] = await first`select pg_try_advisory_lock(7071) as ok`;

    await first.begin(async (tx) => {
      await tx`create table under_lock (a int)`;
    });

    const failed = first.begin(async (tx) => {
      await tx`select 1 / 0`;
    });

    expect(await outcome(failed)).toBe("22012");

    const [refused] = await second`select pg_try_advisory_lock(7071) as ok`;

    await first`select pg_advisory_unlock(7071)`;

    const [granted] = await second`select pg_try_advisory_lock(7071) as ok`;

    await second`select pg_advisory_unlock(7071)`;

    expect([taken.ok, refused.ok, granted.ok]).toEqual([true, false, true]);
    expect(await exists("under_lock")).toBe(true);
  } finally {
    first.release();
    second.release();
  }
});
