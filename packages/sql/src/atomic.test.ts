/**
 * `atomic()` against a real Postgres: a transaction of its own, a
 * savepoint inside another's, and a failure that was caught, at any depth.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { testDatabase } from "../test-utils/database.ts";
import { atomic } from "./atomic.ts";
import { database } from "./database.ts";

interface Notes {
  readonly notes: { readonly id: number; readonly text: string };
}

let db: Kysely<Notes>;

afterAll(async () => {
  await db.destroy();
});

const { url } = testDatabase();

db = database<Notes>(
  { journal: "migrations", migration: null, arrays: {} },
  { url },
);

beforeAll(async () => {
  await sql`create table notes (id int4 primary key, text text not null)`.execute(
    db,
  );
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

/** Writes a note with this id. */
function write(executor: Kysely<Notes>, id: number): Promise<unknown> {
  return executor.insertInto("notes").values({ id, text: "n" }).execute();
}

/** What a promise was rejected with, or that it was not. */
function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

describe("on its own", () => {
  test("commits what the work wrote, and resolves to what it returned", async () => {
    const result = await atomic(db, async (trx) => {
      await write(trx, 1);

      return "done";
    });

    expect(result).toBe("done");
    expect(await notes()).toContain(1);
  });

  test("rolls back when the work throws, and throws on", async () => {
    const error = await refusal(
      atomic(db, async (trx) => {
        await write(trx, 2);

        throw new Error("give up");
      }),
    );

    expect(error).toEqual(new Error("give up"));
    expect(await notes()).not.toContain(2);
  });

  test("fails, and keeps nothing, when a query of the work failed and it was caught", async () => {
    const error = await refusal(
      atomic(db, async (trx) => {
        await write(trx, 3);
        await write(trx, 3).catch(() => undefined);
      }),
    );

    expect(error).toMatchObject({ code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
    expect(await notes()).not.toContain(3);
  });
});

describe("inside a transaction", () => {
  test("keeps what it wrote along with the transaction", async () => {
    await atomic(db, async (outer) => {
      await write(outer, 10);
      await atomic(outer, async (inner) => {
        await write(inner, 11);
      });
    });

    expect(await notes()).toEqual(expect.arrayContaining([10, 11]));
  });

  test("undoes only its own work when it throws, and the transaction goes on", async () => {
    await atomic(db, async (outer) => {
      await write(outer, 20);

      const error = await refusal(
        atomic(outer, async (inner) => {
          await write(inner, 21);

          throw new Error("inner gives up");
        }),
      );

      expect(error).toEqual(new Error("inner gives up"));

      await write(outer, 22);
    });

    const stored = await notes();

    expect(stored).toEqual(expect.arrayContaining([20, 22]));
    expect(stored).not.toContain(21);
  });

  test("fails, undoing its own work only, when a query of it failed and it was caught", async () => {
    await atomic(db, async (outer) => {
      await write(outer, 30);

      const error = await refusal(
        atomic(outer, async (inner) => {
          await write(inner, 31);
          await write(inner, 30).catch(() => undefined);
        }),
      );

      expect(error).toBeInstanceOf(SQL.PostgresError);
      expect(error).toMatchObject({ code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });

      await write(outer, 32);
    });

    const stored = await notes();

    expect(stored).toEqual(expect.arrayContaining([30, 32]));
    expect(stored).not.toContain(31);
  });

  test("three deep, a failure in the middle undoes the middle and what is under it", async () => {
    await atomic(db, async (outer) => {
      await write(outer, 40);
      await refusal(
        atomic(outer, async (middle) => {
          await write(middle, 41);
          await atomic(middle, async (inner) => {
            await write(inner, 42);
          });

          throw new Error("middle gives up");
        }),
      );
      await atomic(outer, async (after) => {
        await write(after, 43);
      });
    });

    const stored = await notes();

    expect(stored).toEqual(expect.arrayContaining([40, 43]));
    expect(stored).not.toContain(41);
    expect(stored).not.toContain(42);
  });

  test("nests inside a unit that uses the transaction it was given, not the one it is handed", async () => {
    await atomic(db, async (outer) => {
      await atomic(outer, async () => {
        await write(outer, 60);
        await atomic(outer, async (inner) => {
          await write(inner, 61);
        });
      });
    });

    expect(await notes()).toEqual(expect.arrayContaining([60, 61]));
  });

  test("beside another unit still open is refused, before it writes anything", async () => {
    const outcome = await refusal(
      atomic(db, async (outer) => {
        const [first, second] = await Promise.allSettled([
          atomic(outer, async (unit) => {
            await sql`select pg_sleep(0.1)`.execute(unit);
            await write(unit, 70);

            return "first";
          }),
          atomic(outer, async (unit) => {
            await write(unit, 71);

            return "second";
          }),
        ]);

        expect(first).toEqual({ status: "fulfilled", value: "first" });
        expect(second).toMatchObject({
          status: "rejected",
          reason: new Error(
            "atomic() was called beside another unit of the same transaction that is still open: units of one transaction run one after another, or one inside another, never side by side, as with Promise.all",
          ),
        });

        await atomic(outer, async (unit) => {
          await write(unit, 72);
        });
      }),
    );

    expect(outcome).toBe("resolved");

    const stored = await notes();

    expect(stored).toEqual(expect.arrayContaining([70, 72]));
    expect(stored).not.toContain(71);
  });

  test.each([
    ["withSchema()", 80, (trx: Kysely<Notes>) => trx.withSchema("public")],
    [
      "withPlugin()",
      82,
      (trx: Kysely<Notes>) =>
        trx.withPlugin({
          transformQuery: (args) => args.node,
          transformResult: async (args) => args.result,
        }),
    ],
  ])(
    "beside another unit is refused, though given a Kysely %s made of the transaction",
    async (_, id, derive) => {
      const outcome = await refusal(
        atomic(db, async (outer) => {
          const [first, second] = await Promise.allSettled([
            atomic(outer, async (unit) => {
              await sql`select pg_sleep(0.1)`.execute(unit);
              await write(unit, id);

              return "first";
            }),
            atomic(derive(outer), async (unit) => {
              await write(unit, id + 1);

              return "second";
            }),
          ]);

          expect(first).toEqual({ status: "fulfilled", value: "first" });
          expect(second).toMatchObject({ status: "rejected" });
        }),
      );

      expect(outcome).toBe("resolved");
      expect(await notes()).not.toContain(id + 1);
    },
  );

  test("controlled, marks a savepoint as well", async () => {
    const trx = await db.startTransaction().execute();

    try {
      await write(trx, 50);
      await refusal(
        atomic(trx, async (inner) => {
          await write(inner, 51);

          throw new Error("no");
        }),
      );
      await trx.commit().execute();
    } catch (error) {
      await trx.rollback().execute();

      throw error;
    }

    const stored = await notes();

    expect(stored).toContain(50);
    expect(stored).not.toContain(51);
  });
});
