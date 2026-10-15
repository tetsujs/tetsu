/**
 * The functions of query files, run: the generated file of the fixture's
 * queries on a database built from its migrations, with values as the
 * file types them — what each returns, how its parameters go in, and a
 * query run inside a unit of work. Each test inserts the orders it reads,
 * so that any of them runs alone as it runs with the others.
 *
 * @module
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { sql } from "kysely";
import { DATABASE_MS } from "../test-utils/database.ts";
import { schema } from "../test-utils/fixtures/schema/db.generated.ts";
import {
  boxes,
  documents,
  importedCodes,
  insertOrder,
  invoicesAndOrders,
  kindOf,
  now,
  openOrders,
  orderById,
  orderCounts,
  ordersWithItems,
  setScores,
  shipOrder,
} from "../test-utils/fixtures/schema/queries.generated.ts";
import { atomic } from "./atomic.ts";
import { queryRows } from "./queries.ts";
import { testDatabase } from "./testing.ts";

setDefaultTimeout(DATABASE_MS);

const { db } = testDatabase(schema, {
  url: Bun.env["DATABASE_URL"],
  dir: join(import.meta.dir, "../test-utils/fixtures/schema/migrations"),
});

/** An order the fixture's tables take, by `insertOrder`. */
const order = {
  kind: "retail",
  channel: "web",
  quantity: 2,
  amount: "12.50",
  note: "fragile",
  attributes: "colour=>red",
  tags: ["gift", "glass"],
  payload: { gift: true, lines: [1, 2] },
  placedAt: new Date("2026-10-13T10:00:00Z"),
} as const;

/** Inserts an order of its own, by `insertOrder`, and returns its id. */
async function newOrder(): Promise<bigint> {
  const [inserted] = await insertOrder(db, order);

  if (inserted === undefined) {
    throw new Error("the order was not inserted");
  }

  return inserted.id;
}

/**
 * The scores of an order, as their text: Bun cannot read an `int4[]` that
 * holds a NULL with parameters (oven-sh/bun#45062).
 */
async function scoresOf(id: bigint): Promise<string | undefined> {
  const { rows } = await sql<{
    scores: string;
  }>`select scores::text as scores from orders where id = ${id}`.execute(db);

  return rows[0]?.scores;
}

describe("a query that returns rows", () => {
  test("returns them as its file types them", async () => {
    const id = await newOrder();

    expect(await orderById(db, { id })).toEqual([
      {
        id,
        number: expect.any(Number),
        status: "new",
        shipping: null,
        kind: "retail",
        channel: "web",
        priority: 1,
        region: null,
        tags: ["gift", "glass"],
        labels: [],
        notes: null,
        scores: [],
        coupons: null,
        history: null,
        moments: null,
        amount: "12.50",
        total: "25.00",
        note: "fragile",
        email: null,
        payload: { gift: true, lines: [1, 2] },
        placed_on: expect.any(Date),
        placed_at: new Date("2026-10-13T10:00:00Z"),
        receipt: null,
        attributes: null,
      },
    ]);
    expect(await orderById(db, { id: 0n })).toEqual([]);
  });

  test("written by an insert returns what it returns", async () => {
    const [row] = await insertOrder(db, {
      ...order,
      placedAt: "2026-10-13 12:00:00+02",
    });

    expect(row).toEqual({
      id: expect.any(BigInt),
      placed_at: new Date("2026-10-13T10:00:00Z"),
    });
  });

  test("takes an array as its parameter's literal, and NULL where it may be NULL", async () => {
    const id = await newOrder();
    const all = await ordersWithItems(db, {
      statuses: ["new", "paid"],
      note: null,
    });

    expect(all).toContainEqual({
      id,
      status: "new",
      line: null,
      mixed: null,
      total: BigInt(all.length),
    });
    expect(
      await ordersWithItems(db, { statuses: ["shipped"], note: null }),
    ).toEqual([]);

    await db
      .insertInto("order_items")
      .values({ order_id: id, line: 1, "Mixed Case": "Glass" })
      .execute();

    const fragile = await ordersWithItems(db, {
      statuses: ["new"],
      note: "fragile",
    });

    expect(fragile).toContainEqual({
      id,
      status: "new",
      line: 1,
      mixed: "Glass",
      total: BigInt(fragile.length),
    });
  });

  test("writes each element of an array of json as JSON, and each of box by its delimiter", async () => {
    expect(
      await documents(db, { documents: [{ a: 1 }, [1, "two"], null] }),
    ).toEqual([{ count: 3 }]);
    expect(
      await boxes(db, { boxes: ["(1,1),(0,0)", null, "(3,3),(2,2)"] }),
    ).toEqual([{ boxes: ["(1,1),(0,0)", null, "(3,3),(2,2)"] }]);
  });

  test("of a join that may find no row returns NULL for it", async () => {
    const id = await newOrder();
    const [invoice] = await db
      .insertInto("billing.invoices")
      .defaultValues()
      .returning("id")
      .execute();

    expect(await invoicesAndOrders(db)).toContainEqual({
      invoice: invoice?.id ?? null,
      state: "draft",
      order: null,
    });
    expect(await invoicesAndOrders(db)).toContainEqual({
      invoice: null,
      state: null,
      order: id,
    });
  });

  test("of a view, a materialized view and a foreign table returns their rows", async () => {
    const id = await newOrder();

    await sql`refresh materialized view order_counts`.execute(db);

    const counted = await db
      .selectFrom("orders")
      .select(["status", db.fn.countAll<bigint>().as("orders")])
      .groupBy("status")
      .execute();

    expect(await openOrders(db)).toContainEqual({
      id,
      status: "new",
      note: "fragile",
      placed_at: new Date("2026-10-13T10:00:00Z"),
    });
    expect(
      (await orderCounts(db)).toSorted((a, b) =>
        String(a.status).localeCompare(String(b.status)),
      ),
    ).toEqual(
      counted
        .toSorted((a, b) => a.status.localeCompare(b.status))
        .map(({ status, orders }) => ({
          status,
          orders,
          doubled: orders * 2n,
        })),
    );
    expect(await importedCodes(db)).toEqual([]);
  });

  test("of no table returns its expressions", async () => {
    const [row] = await now(db);

    expect(row).toEqual({ now: expect.any(Date), one: 1 });
    expect(await kindOf(db, { kind: "bulk", level: "a" })).toEqual([
      { kind: "bulk", level: "a" },
    ]);
  });

  test("refuses parameters that lack one of its own, before it runs", async () => {
    await expect(orderById(db, {} as never)).rejects.toThrow(
      new TypeError("the query takes :id, which its parameters do not hold"),
    );
    await expect(
      queryRows(
        db,
        { text: "select $1::int4", names: ["n"], arrays: {} },
        { n: undefined },
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("a query that returns no rows", () => {
  test("returns how many rows it changed", async () => {
    const id = await newOrder();

    expect(await shipOrder(db, { id })).toBe(0n);

    await db
      .updateTable("orders")
      .set({ status: "paid" })
      .where("id", "=", id)
      .execute();

    expect(await shipOrder(db, { id })).toBe(1n);
    expect(await shipOrder(db, { id })).toBe(0n);
  });

  test("writes an array, of Int32Array too, to a column of arrays", async () => {
    const id = await newOrder();

    expect(await setScores(db, { id, scores: [3, null, 1] })).toBe(1n);
    expect(await scoresOf(id)).toBe("{3,NULL,1}");
    expect(
      await setScores(db, {
        id,
        scores: Int32Array.of(7, 8) as unknown as number[],
      }),
    ).toBe(1n);
    expect(await scoresOf(id)).toBe("{7,8}");
  });
});

describe("a query in a unit of work", () => {
  test("is rolled back with it", async () => {
    const count = () =>
      db
        .selectFrom("orders")
        .select(db.fn.countAll<bigint>().as("count"))
        .executeTakeFirstOrThrow();
    const before = await count();

    await expect(
      atomic(db, async (trx) => {
        await insertOrder(trx, order);

        throw new Error("changed my mind");
      }),
    ).rejects.toThrow("changed my mind");

    expect(await count()).toEqual(before);
  });
});
