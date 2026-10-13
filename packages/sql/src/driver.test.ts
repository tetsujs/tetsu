/**
 * Kysely's dialect on Bun.SQL against a real Postgres: transactions, what a
 * result carries, the values the driver mends, and a query given up by its
 * signal.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Kysely, sql as raw } from "kysely";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import { BunDialect } from "./driver.ts";

interface Database {
  readonly notes: { readonly id: number; readonly text: string };
  readonly moments: {
    readonly id: number;
    readonly day: Date | string | null;
    readonly local: Date | string | null;
    readonly instant: Date | string | null;
  };
  readonly vectors: {
    readonly id: number;
    readonly ints: number[] | null;
    readonly floats: number[] | null;
    readonly big: bigint | null;
  };
  readonly sources: { readonly id: number };
}

let db: Kysely<Database>;

afterAll(async () => {
  await db.destroy();
});

const { sql: client, url } = testDatabase();

/** Kysely on the dialect, with a pool of `max` connections. */
function kysely(max?: number): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new BunDialect(
      new SQL({ url, bigint: true, ...(max === undefined ? {} : { max }) }),
      new SQL({ url, bigint: true, max: 1 }),
    ),
  });
}

db = kysely();

beforeAll(async () => {
  await raw`
    create table notes (id int4 primary key, text text not null);
    create table moments (
      id int4 primary key, day date, local timestamp, instant timestamptz
    );
    create table vectors (
      id int4 primary key, ints int4[], floats float4[], big int8
    );
    insert into vectors values (1, '{1,2}', '{1.5,0.25}', 9007199254740993);
    create table sources (id int4 primary key);
    insert into sources values (1), (20);
  `.execute(db);
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

/**
 * Whether a query holding `marker` runs on this database, once it is
 * `expected` to or the wait runs out: read by the helper's own client, as
 * the pool under test may have no connection to spare.
 */
async function runs(marker: string, expected = true): Promise<boolean> {
  for (let tries = 0; tries < 100; tries += 1) {
    const [row] = await client`
      select count(*)::int as running from pg_stat_activity
      where datname = current_database() and state = 'active'
        and query like ${`%${marker}%`} and query not like '%pg_stat_activity%'`;

    if (row.running > 0 === expected) {
      return expected;
    }

    await Bun.sleep(50);
  }

  return !expected;
}

/** What a promise was rejected with, or that it was not. */
function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

describe("a transaction", () => {
  test("commits what its callback wrote", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("notes").values({ id: 1, text: "kept" }).execute();
    });

    expect(await notes()).toContain(1);
  });

  test("rolls back when its callback throws", async () => {
    const outcome = db.transaction().execute(async (trx) => {
      await trx.insertInto("notes").values({ id: 2, text: "lost" }).execute();

      throw new Error("give up");
    });

    expect(await refusal(outcome)).toEqual(new Error("give up"));
    expect(await notes()).not.toContain(2);
  });

  test("whose callback caught a failure fails, as Postgres rolled it back, and keeps nothing", async () => {
    const outcome = db.transaction().execute(async (trx) => {
      await trx.insertInto("notes").values({ id: 3, text: "lost" }).execute();
      await trx
        .insertInto("notes")
        .values({ id: 3, text: "duplicate" })
        .execute()
        .catch(() => undefined);

      return "done";
    });
    const error = await refusal(outcome);

    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(error).toMatchObject({
      code: "ERR_POSTGRES_COMMIT_ROLLED_BACK",
      message:
        "COMMIT was rolled back by the server because the transaction was already aborted",
    });
    expect(await notes()).not.toContain(3);
  });

  test("controlled, whose failure was caught, fails to commit, and a rollback hands its connection back", async () => {
    const small = kysely(1);

    try {
      const trx = await small.startTransaction().execute();

      await trx.insertInto("notes").values({ id: 4, text: "lost" }).execute();
      await trx
        .insertInto("notes")
        .values({ id: 4, text: "duplicate" })
        .execute()
        .catch(() => undefined);

      expect(await refusal(trx.commit().execute())).toMatchObject({
        code: "ERR_POSTGRES_COMMIT_ROLLED_BACK",
      });

      await trx.rollback().execute();

      expect((await raw`select 1 as one`.execute(small)).rows).toEqual([
        { one: 1 },
      ]);
      expect(await notes()).not.toContain(4);
    } finally {
      await small.destroy();
    }
  });

  test("rolls back to a savepoint, of any name, and goes on", async () => {
    const name = 'before "five"';
    const trx = await db.startTransaction().execute();

    await trx.insertInto("notes").values({ id: 5, text: "kept" }).execute();

    const savepoint = await trx.savepoint(name).execute();
    const duplicate = await refusal(
      savepoint.insertInto("notes").values({ id: 5, text: "twice" }).execute(),
    );

    expect(duplicate).toMatchObject({ errno: "23505" });

    await savepoint.rollbackToSavepoint(name).execute();
    await savepoint
      .insertInto("notes")
      .values({ id: 6, text: "kept" })
      .execute();

    const released = await savepoint.savepoint("inner").execute();

    await released.releaseSavepoint("inner").execute();
    await released.commit().execute();

    expect(await notes()).toEqual(expect.arrayContaining([5, 6]));
  });

  test("with a callback rolls back to a savepoint of its own and goes on", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("notes").values({ id: 7, text: "kept" }).execute();
      await raw`savepoint inner_part`.execute(trx);

      const duplicate = await refusal(
        trx.insertInto("notes").values({ id: 7, text: "twice" }).execute(),
      );

      expect(duplicate).toMatchObject({ errno: "23505" });

      await raw`rollback to savepoint inner_part`.execute(trx);
      await trx.insertInto("notes").values({ id: 8, text: "kept" }).execute();
    });

    expect(await notes()).toEqual(expect.arrayContaining([7, 8]));
  });

  test("cannot open another inside it: Kysely refuses", async () => {
    const outcome = db.transaction().execute(async (trx) => {
      await (trx as unknown as Kysely<Database>)
        .transaction()
        .execute(async () => {});
    });

    expect(await refusal(outcome)).toEqual(
      new Error(
        "calling the transaction method for a Transaction is not supported",
      ),
    );
  });

  test("runs at the isolation level and in the access mode it is given", async () => {
    const settings = await db
      .transaction()
      .setIsolationLevel("serializable")
      .setAccessMode("read only")
      .execute(
        async (trx) =>
          (
            await raw<{ isolation: string; readOnly: string }>`
              select current_setting('transaction_isolation') as isolation,
                     current_setting('transaction_read_only') as "readOnly"`.execute(
              trx,
            )
          ).rows[0],
      );

    expect(settings).toEqual({ isolation: "serializable", readOnly: "on" });
  });
});

describe("a result", () => {
  test("counts the rows an insert, an update and a delete changed", async () => {
    const inserted = await db
      .insertInto("notes")
      .values([
        { id: 10, text: "a" },
        { id: 11, text: "b" },
      ])
      .executeTakeFirstOrThrow();
    const updated = await db
      .updateTable("notes")
      .set({ text: "c" })
      .where("id", ">=", 10)
      .executeTakeFirstOrThrow();
    const deleted = await db
      .deleteFrom("notes")
      .where("id", ">=", 10)
      .executeTakeFirstOrThrow();

    expect(inserted.numInsertedOrUpdatedRows).toBe(2n);
    expect(updated.numUpdatedRows).toBe(2n);
    expect(deleted.numDeletedRows).toBe(2n);
  });

  test("counts the rows a merge changed, from Postgres 15 on", async () => {
    const [server] = (
      await raw<{
        version: number;
      }>`select current_setting('server_version_num')::int as version`.execute(
        db,
      )
    ).rows;

    if (server === undefined || server.version < 150000) {
      return;
    }

    const merged = await db
      .mergeInto("notes as t")
      .using("sources as s", "s.id", "t.id")
      .whenMatched()
      .thenUpdateSet({ text: "merged" })
      .whenNotMatched()
      .thenInsertValues((eb) => ({ id: eb.ref("s.id"), text: "new" }))
      .executeTakeFirstOrThrow();

    expect(merged.numChangedRows).toBe(2n);
  });

  test("of a select counts nothing", async () => {
    const result = await raw`select 1 as one`.execute(db);

    expect(result.numAffectedRows).toBeUndefined();
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  test("holds an int4[] and a float4[] as arrays, with parameters and without", async () => {
    const binary = await db
      .selectFrom("vectors")
      .select(["ints", "floats", "big"])
      .where("id", "=", 1)
      .execute();
    const text = await db
      .selectFrom("vectors")
      .select(["ints", "floats", "big"])
      .execute();

    for (const rows of [binary, text]) {
      expect(rows).toEqual([
        { ints: [1, 2], floats: [1.5, 0.25], big: 9007199254740993n },
      ]);
      expect(Array.isArray(rows[0]?.ints)).toBe(true);
      expect(Array.isArray(rows[0]?.floats)).toBe(true);
    }
  });

  test("passes a failure on as Bun's own PostgresError", async () => {
    await db.insertInto("notes").values({ id: 30, text: "first" }).execute();

    const error = await refusal(
      db.insertInto("notes").values({ id: 30, text: "again" }).execute(),
    );

    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(error).toMatchObject({
      errno: "23505",
      constraint: "notes_pkey",
      table: "notes",
    });
  });

  test("of several statements is the last statement's", async () => {
    const result = await raw`select 1 as a; select 2 as b`.execute(db);

    expect(result.rows).toEqual([{ b: 2 }]);
  });

  test("cannot be streamed, as Bun.SQL has no cursor", async () => {
    const stream = async () => {
      for await (const row of db.selectFrom("notes").selectAll().stream()) {
        return row;
      }

      return undefined;
    };

    expect(await refusal(stream())).toEqual(
      new Error(
        "stream() reads rows through a cursor, which Bun.SQL does not have yet: use execute()",
      ),
    );
  });
});

describe("a Date", () => {
  test("is written to a date, a timestamp and a timestamptz as its instant in UTC, whatever the time zone of the process", async () => {
    const zone = process.env.TZ;
    const instant = new Date("2026-10-12T21:30:00.250Z");

    process.env.TZ = "Asia/Tokyo";

    try {
      await db
        .insertInto("moments")
        .values({ id: 1, day: instant, local: instant, instant })
        .execute();
      await raw`insert into moments (id, day, local, instant) values (2, ${instant}, ${instant}, ${instant})`.execute(
        db,
      );
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }

    const rows = await raw<{
      day: string;
      local: string;
      instant: Date;
    }>`select day::text as day, local::text as local, instant from moments where id in (1, 2) order by id`.execute(
      db,
    );

    expect(rows.rows).toEqual([
      {
        day: "2026-10-12",
        local: "2026-10-12 21:30:00.25",
        instant: instant,
      },
      {
        day: "2026-10-12",
        local: "2026-10-12 21:30:00.25",
        instant: instant,
      },
    ]);
  });

  test("that is invalid is refused before anything is written", async () => {
    const error = await refusal(
      db
        .insertInto("moments")
        .values({ id: 3, instant: new Date(Number.NaN) })
        .execute(),
    );

    expect(error).toBeInstanceOf(RangeError);

    const stored = await db
      .selectFrom("moments")
      .select("id")
      .where("id", "=", 3)
      .execute();

    expect(stored).toEqual([]);
  });
});

describe("a query given up by its signal", () => {
  test("while it waits for a connection fails with the signal's reason", async () => {
    const small = kysely(1);

    try {
      const holder = await small.startTransaction().execute();
      const controller = new AbortController();
      const waiting = refusal(
        raw`select 1`.execute(small, { signal: controller.signal }),
      );
      const reason = new Error("waited too long");

      setTimeout(() => controller.abort(reason), 50);

      expect(await waiting).toBe(reason);

      await holder.rollback().execute();

      expect((await raw`select 1 as one`.execute(small)).rows).toEqual([
        { one: 1 },
      ]);
    } finally {
      await small.destroy();
    }
  });

  test(
    "while it runs is cancelled on the server, with the cancel strategy",
    async () => {
      const controller = new AbortController();
      const reason = new Error("gave up");
      const sleeping = refusal(
        raw`select pg_sleep(30), 'tetsu_sql_cancel_alone'`.execute(db, {
          signal: controller.signal,
          inflightQueryAbortStrategy: "cancel query",
        }),
      );

      expect(await runs("tetsu_sql_cancel_alone")).toBe(true);

      controller.abort(reason);

      expect(await sleeping).toBe(reason);
      expect(await runs("tetsu_sql_cancel_alone", false)).toBe(false);
    },
    DATABASE_MS,
  );

  test(
    "on a pool of one connection is cancelled, and the pool goes on",
    async () => {
      const small = kysely(1);

      try {
        const controller = new AbortController();
        const reason = new Error("gave up");
        const sleeping = refusal(
          raw`select pg_sleep(30), 'tetsu_sql_cancel_pool'`.execute(small, {
            signal: controller.signal,
            inflightQueryAbortStrategy: "cancel query",
          }),
        );

        expect(await runs("tetsu_sql_cancel_pool")).toBe(true);

        controller.abort(reason);

        expect(await sleeping).toBe(reason);
        expect((await raw`select 1 as one`.execute(small)).rows).toEqual([
          { one: 1 },
        ]);
      } finally {
        await small.destroy();
      }
    },
    DATABASE_MS,
  );

  test(
    "inside a transaction is cancelled, and the transaction then fails to commit",
    async () => {
      const controller = new AbortController();
      const reason = new Error("gave up");
      const started = performance.now();
      const outcome = refusal(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto("notes")
            .values({ id: 40, text: "lost" })
            .execute();

          const sleeping = refusal(
            raw`select pg_sleep(30), 'tetsu_sql_cancel_transaction'`.execute(
              trx,
              {
                signal: controller.signal,
                inflightQueryAbortStrategy: "cancel query",
              },
            ),
          );

          expect(await runs("tetsu_sql_cancel_transaction")).toBe(true);

          controller.abort(reason);

          expect(await sleeping).toBe(reason);
        }),
      );

      expect(await outcome).toMatchObject({
        code: "ERR_POSTGRES_COMMIT_ROLLED_BACK",
      });
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(await notes()).not.toContain(40);
    },
    DATABASE_MS,
  );

  test("cannot kill its session: Kysely says so before it runs", async () => {
    const error = await refusal(
      raw`select 1`.execute(db, {
        signal: new AbortController().signal,
        inflightQueryAbortStrategy: "kill session",
      }),
    );

    expect(error).toEqual(
      new Error(
        'This dialect doesn\'t support `inflightQueryAbortStrategy` "kill session". Use "ignore query" or "cancel query" instead.',
      ),
    );
  });
});
