/**
 * `isViolation()` against a real Postgres, on the database the fixture
 * migrations build: each kind of broken constraint is told by its name,
 * and nothing else is taken for one.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { DATABASE_MS, testDatabase } from "../test-utils/database.ts";
import type { DB } from "../test-utils/fixtures/schema/db.generated.ts";
import { schema } from "../test-utils/fixtures/schema/db.generated.ts";
import { database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { isViolation } from "./violation.ts";

let db: Kysely<DB>;

afterAll(async () => {
  await db.destroy();
});

const { sql: client, url } = testDatabase();

db = database(schema, { url });

beforeAll(async () => {
  await migrate(client, {
    dir: join(import.meta.dir, "../test-utils/fixtures/schema/migrations"),
  });
}, DATABASE_MS);

/** The columns an order cannot go without. */
const order = {
  kind: "retail",
  channel: "web",
  quantity: 1,
  amount: "12.50",
  note: "fragile",
  outer_kind: "a",
  required_attributes: "colour=>red",
} as const;

/** What a write failed with. */
function failure(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => {
      throw new Error("the write did not fail");
    },
    (error: unknown) => error,
  );
}

/** An order stored, by its id. */
async function stored(): Promise<bigint> {
  const { id } = await db
    .insertInto("orders")
    .values(order)
    .returning("id")
    .executeTakeFirstOrThrow();

  return id;
}

describe("a broken constraint is told by its name", () => {
  test("of a unique key", async () => {
    const error = await failure(
      db
        .insertInto("orders")
        .values([
          { ...order, email: "twice@example.com" },
          { ...order, email: "twice@example.com" },
        ])
        .execute(),
    );

    expect(isViolation(error, "orders_email_key")).toBe(true);
    expect(isViolation(error, "orders_pkey")).toBe(false);
  });

  test("of a unique index that is no constraint", async () => {
    const error = await failure(
      db
        .insertInto("orders")
        .values([
          { ...order, number: 7 },
          { ...order, number: 7 },
        ])
        .execute(),
    );

    expect(isViolation(error, "orders_number_key")).toBe(true);
  });

  test("of a foreign key, on an insert and on a restricted delete, which Postgres 18 tells with another code", async () => {
    const missing = await failure(
      db.insertInto("order_items").values({ order_id: -1n, line: 1 }).execute(),
    );
    const id = await stored();

    await db.insertInto("billing.invoices").values({ order_id: id }).execute();

    const referenced = await failure(
      db.deleteFrom("orders").where("id", "=", id).execute(),
    );

    const [server] = (
      await sql<{
        version: number;
      }>`select current_setting('server_version_num')::int as version`.execute(
        db,
      )
    ).rows;

    expect(isViolation(missing, "order_items_order_id_fkey")).toBe(true);
    expect(isViolation(referenced, "invoices_order_id_fkey")).toBe(true);
    expect((referenced as SQL.PostgresError).errno).toBe(
      (server?.version ?? 0) >= 180000 ? "23001" : "23503",
    );
  });

  test("of a check, of a table and of a domain", async () => {
    const table = await failure(
      db
        .insertInto("orders")
        .values({ ...order, channel: "phone" as never })
        .execute(),
    );
    const domain = await failure(
      db
        .insertInto("orders")
        .values({ ...order, kind: "unknown" as never })
        .execute(),
    );

    expect(isViolation(table, "orders_channel_check")).toBe(true);
    expect(isViolation(domain, "kind_check")).toBe(true);
    expect((domain as SQL.PostgresError).table).toBeUndefined();
  });

  test("of an exclusion constraint", async () => {
    await db
      .insertInto("bookings")
      .values({ id: 1, during: "[2026-10-01,2026-10-05)" })
      .execute();

    const error = await failure(
      db
        .insertInto("bookings")
        .values({ id: 2, during: "[2026-10-03,2026-10-07)" })
        .execute(),
    );

    expect(isViolation(error, "bookings_during_excl")).toBe(true);
  });
});

describe("no constraint is taken as broken", () => {
  test("by a value missing from a column that is not null, which names none", async () => {
    const error = await failure(
      db
        .insertInto("orders")
        .values({ ...order, amount: null as never })
        .execute(),
    );

    expect((error as SQL.PostgresError).errno).toBe("23502");
    expect(isViolation(error, "orders_pkey")).toBe(false);
  });

  test("by a failure of another class that names the constraint all the same: a value too long for its unique index", async () => {
    const long = Buffer.from(
      crypto.getRandomValues(new Uint8Array(2000)),
    ).toString("hex");
    const error = await failure(
      db
        .insertInto("orders")
        .values({ ...order, email: long })
        .execute(),
    );

    expect((error as SQL.PostgresError).errno).toBe("54000");
    expect(["orders_email_key", "orders_open_email_key"]).toContain(
      (error as SQL.PostgresError).constraint ?? "",
    );
    expect(isViolation(error, "orders_email_key")).toBe(false);
    expect(isViolation(error, "orders_open_email_key")).toBe(false);
  });

  test("by a failure of another kind, or an error that is not Postgres's", async () => {
    const syntax = await failure(sql`select from from`.execute(db));
    const lookalike = Object.assign(new Error("looks like one"), {
      errno: "23505",
      constraint: "orders_email_key",
    });

    expect(isViolation(syntax, "orders_email_key")).toBe(false);
    expect(isViolation(lookalike, "orders_email_key")).toBe(false);
    expect(isViolation(new TypeError("no"), "orders_email_key")).toBe(false);
    expect(isViolation(undefined, "orders_email_key")).toBe(false);
  });

  test("by a commit Postgres turned into a rollback", async () => {
    const error = await failure(
      db.transaction().execute(async (trx) => {
        await trx
          .insertInto("orders")
          .values([
            { ...order, email: "again@example.com" },
            { ...order, email: "again@example.com" },
          ])
          .execute()
          .catch(() => undefined);
      }),
    );

    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(isViolation(error, "orders_email_key")).toBe(false);
  });
});
