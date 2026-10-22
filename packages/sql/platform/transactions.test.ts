/**
 * Transactions on a connection reserved from Bun's pool, which the
 * package's driver for Kysely opens and ends with plain statements: they
 * run there, and a commit Postgres turns into a rollback says so only in
 * the command of its result. A connection that comes free goes to the
 * query or the reservation that has waited longest, so that a query asked
 * for after a reservation waits for it: why the driver lets reservations
 * take turns at every connection but one. A reserved connection
 * garbage-collected with a transaction open on it is closed, rather than
 * handed on with the transaction: why the driver hands back the turn of a
 * connection collected before its turn went back.
 *
 * @module
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { testDatabase } from "../test-utils/database.ts";
import { failure } from "./values.ts";

afterAll(async () => {
  await sql.close();
});

const { url } = testDatabase();
const sql = new SQL(url);

beforeAll(async () => {
  await sql`create table notes (id int primary key, text text not null)`;
});

/** The ids of the notes stored, in order. */
async function notes(): Promise<number[]> {
  const rows: { id: number }[] = await sql`select id from notes order by id`;

  return rows.map((row) => row.id);
}

/** Runs `use` on a reserved connection, and hands it back. */
async function reserved<T>(use: (connection: SQL) => Promise<T>): Promise<T> {
  const connection = await sql.reserve();

  try {
    return await use(connection);
  } finally {
    connection.release();
  }
}

test("a bare begin and commit run on a reserved connection, and the commit says COMMIT", async () => {
  const command = await reserved(async (connection) => {
    await connection.unsafe("begin");
    await connection.unsafe("insert into notes values ($1, $2)", [1, "kept"]);

    return (await connection.unsafe("commit")).command;
  });

  expect(command).toBe("COMMIT");
  expect(await notes()).toContain(1);
});

test("a commit after a failed statement is answered ROLLBACK, without an error, and keeps nothing", async () => {
  const command = await reserved(async (connection) => {
    await connection.unsafe("begin");
    await connection.unsafe("insert into notes values ($1, $2)", [2, "lost"]);

    const duplicate = connection.unsafe("insert into notes values ($1, $2)", [
      2,
      "again",
    ]);

    expect(await duplicate.then(() => "stored", failure)).toBe("23505");

    return (await connection.unsafe("commit")).command;
  });

  expect(command).toBe("ROLLBACK");
  expect(await notes()).not.toContain(2);
});

test("a rollback with no transaction open is no error", async () => {
  const command = await reserved(
    async (connection) => (await connection.unsafe("rollback")).command,
  );

  expect(command).toBe("ROLLBACK");
});

test("rolling back to a savepoint undoes only what came after it", async () => {
  await reserved(async (connection) => {
    await connection.unsafe("begin");
    await connection.unsafe("insert into notes values ($1, $2)", [3, "kept"]);
    await connection.unsafe('savepoint "inner part"');

    const duplicate = connection.unsafe("insert into notes values ($1, $2)", [
      3,
      "again",
    ]);

    expect(await duplicate.then(() => "stored", failure)).toBe("23505");

    await connection.unsafe('rollback to savepoint "inner part"');
    await connection.unsafe("insert into notes values ($1, $2)", [4, "kept"]);
    await connection.unsafe("commit");
  });

  expect(await notes()).toEqual(expect.arrayContaining([3, 4]));
});

test("a connection that comes free goes to what waited longest, a query or a reservation", async () => {
  const pool = new SQL({ url, max: 1 });
  const done: string[] = [];
  const transaction = (name: string) =>
    pool
      .begin((tx) => tx`select pg_sleep(0.05)`)
      .then(() => {
        done.push(name);
      });
  const query = (name: string) =>
    pool`select 1`.then(() => {
      done.push(name);
    });

  try {
    const first = transaction("first transaction");

    await Bun.sleep(20);

    const earlier = query("query");

    await Bun.sleep(20);

    const later = transaction("later transaction");

    await Bun.sleep(20);
    await Promise.all([first, earlier, later, query("later query")]);
  } finally {
    await pool.close();
  }

  expect(done).toEqual([
    "first transaction",
    "query",
    "later transaction",
    "later query",
  ]);
});

test("a reserved connection garbage-collected with a transaction open on it is closed, not handed on", async () => {
  const pool = new SQL({ url, max: 1 });

  try {
    const pid = await (async () => {
      const connection = await pool.reserve();

      await connection.unsafe("begin");
      await connection.unsafe("insert into notes values ($1, $2)", [5, "open"]);

      const [row] = await connection.unsafe("select pg_backend_pid() as pid");

      return row.pid;
    })();
    let answered = false;
    const next = pool`
      select pg_backend_pid() as pid,
        (select count(*)::int from notes where id = 5) as seen`.finally(() => {
      answered = true;
    });

    for (let rounds = 0; rounds < 100 && !answered; rounds += 1) {
      Bun.gc(true);
      await Bun.sleep(20);
    }

    const [row] = await next;

    expect({ moved: row.pid !== pid, seen: row.seen }).toEqual({
      moved: true,
      seen: 0,
    });
  } finally {
    await pool.close();
  }
});
