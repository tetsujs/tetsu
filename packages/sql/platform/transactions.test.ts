/**
 * Transactions through Kysely on Bun.SQL, which `atomic()` builds on: what
 * commits, what rolls back, what Kysely refuses, and where a savepoint
 * works.
 *
 * Kysely's driver for Postgres opens and ends a transaction with plain
 * `begin` and `commit` statements, so what `sql.begin()` checks for itself
 * is not checked here.
 *
 * @module
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { Kysely, sql as raw } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import { testDatabase } from "../test-utils/database.ts";
import { failure } from "./values.ts";

interface Database {
  readonly notes: { readonly id: number; readonly text: string };
}

const { sql, url } = testDatabase();
const db = new Kysely<Database>({
  dialect: new PostgresJSDialect({ postgres: new SQL(url) }),
});

beforeAll(async () => {
  await sql`create table notes (id int primary key, text text not null)`;
});

afterAll(async () => {
  await db.destroy();
});

/** The ids of the notes stored, in order. */
async function notes(): Promise<number[]> {
  const rows = await db
    .selectFrom("notes")
    .select("id")
    .orderBy("id")
    .execute();

  return rows.map((row) => row.id);
}

test("a transaction commits what its callback wrote", async () => {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("notes").values({ id: 1, text: "kept" }).execute();
  });

  expect(await notes()).toContain(1);
});

test("a transaction rolls back when its callback throws", async () => {
  const outcome = db.transaction().execute(async (trx) => {
    await trx.insertInto("notes").values({ id: 2, text: "lost" }).execute();

    throw new Error("give up");
  });

  expect(
    await outcome.then(
      () => "committed",
      (error) => String(error),
    ),
  ).toBe("Error: give up");
  expect(await notes()).not.toContain(2);
});

test("a transaction whose callback swallowed a failure resolves, and nothing it wrote is stored", async () => {
  const outcome = db.transaction().execute(async (trx) => {
    await trx.insertInto("notes").values({ id: 3, text: "lost" }).execute();
    await trx
      .insertInto("notes")
      .values({ id: 3, text: "duplicate" })
      .execute()
      .catch(() => undefined);

    return "done";
  });

  expect(await outcome).toBe("done");
  expect(await notes()).not.toContain(3);
});

test("Kysely refuses transaction() on a transaction", async () => {
  const outcome = db.transaction().execute(async (trx) => {
    await (trx as unknown as Kysely<Database>)
      .transaction()
      .execute(async () => {});
  });

  expect(
    await outcome.then(
      () => "ran",
      (error) => String(error),
    ),
  ).toBe(
    "Error: calling the transaction method for a Transaction is not supported",
  );
});

test("a savepoint inside a callback transaction undoes only what came after it", async () => {
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("notes").values({ id: 4, text: "kept" }).execute();
    await raw`savepoint inner_part`.execute(trx);

    const duplicate = trx
      .insertInto("notes")
      .values({ id: 4, text: "duplicate" })
      .execute();

    expect(await duplicate.then(() => "stored", failure)).toBe("23505");

    await raw`rollback to savepoint inner_part`.execute(trx);
    await trx.insertInto("notes").values({ id: 5, text: "kept" }).execute();
  });

  expect(await notes()).toEqual(expect.arrayContaining([4, 5]));
});

test("a controlled transaction rolls back to its savepoint over kysely-postgres-js", async () => {
  const trx = await db.startTransaction().execute();

  await trx.insertInto("notes").values({ id: 6, text: "kept" }).execute();

  const savepoint = await trx.savepoint("before_seven").execute();

  await savepoint.insertInto("notes").values({ id: 7, text: "lost" }).execute();
  await savepoint.rollbackToSavepoint("before_seven").execute();
  await trx.commit().execute();

  const stored = await notes();

  expect(stored).toContain(6);
  expect(stored).not.toContain(7);
});
