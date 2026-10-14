---
title: Testing
description: A database of its own for each test file, built from the migrations with the types checked against them, and dropped once the file has run.
sidebar:
  order: 7
---

Tests run against a real Postgres: the queries, the constraints and the
types are what they check. `testDatabase()`, from `@tetsujs/sql/testing`,
gives a test file a database of its own:

```ts twoslash title="src/orders.test.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/queries.generated.ts
export * from "@examples/sql/queries.generated";
// @filename: src/orders.test.ts
// ---cut---
import { expect, test } from "bun:test";
import { testDatabase } from "@tetsujs/sql/testing";
import { schema } from "./db.generated";
import { customerOrders } from "./queries.generated";

const { db } = testDatabase(schema, {
  url: Bun.env.DATABASE_URL,
  dir: "migrations",
});

test("lists a customer's orders, with the shipment of each", async () => {
  const customer = await db
    .insertInto("customers")
    .values({ email: "ada@example.com", name: "Ada" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const order = await db
    .insertInto("orders")
    .values({ customer_id: customer.id, total: "12.50", status: "paid" })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("shipments")
    .values({ order_id: order.id, carrier: "post" })
    .execute();

  expect(await customerOrders(db, { customerId: customer.id })).toEqual([
    {
      id: order.id,
      status: "paid",
      total: "12.50",
      carrier: "post",
      shipped_at: expect.any(Date),
    },
  ]);
});
```

`testDatabase()` registers two hooks of `bun:test` where it is called — at
the top level of a file for the file, in a `describe` for that `describe` —
and returns the database's `db`, its `url` for code under test that opens
connections of its own, and its `name`. Its options besides `url` and `dir`
are `database()`'s, such as `max` and `connection`, so that the tests run
on a pool set as the application's.

- **`beforeAll`** creates a database from `template0` on the server `url`
  names, and applies the migrations of `dir`. It fails when the newest
  migration is not the one the types of `schema` were built from: the tests
  would check code against types older or newer than the database. Run
  `types:generate` again.
- **`afterAll`** closes the pool, then drops the database, whoever is still
  on it.

The server is one where tests may create databases, such as a container. A
`url` that is not set is refused, saying so, so `Bun.env.DATABASE_URL` can
be passed as it is.

## What the tests share

Every test of the file runs on the same database, one after another. A test
inserts the rows it reads, as above, so that it runs the same alone, under
`-t`, as with the others. Two files never share a database.

Bun runs hooks in the order they were registered. Call `testDatabase()`
before the hooks of your own that fill the database, and leave cleaning up
to the drop: an `afterAll` of your own runs once the database is gone. When
no test of the scope runs, as with a `-t` filter that matches none, Bun runs
neither hook, and no database is made.

A pool that does not close fails `afterAll`, once the database is dropped
all the same: a test left a transaction open, or a query running.

## A run that stops early

A run that was killed, or stopped by `--bail`, which skips `afterAll`,
leaves its database behind. Each is named `tetsu_sql_` and a UUIDv7, which
holds the time it was made, and the next run on the server drops it once it
is an hour old and nobody is on it.

## The application over HTTP

The same database serves an application under test, built as `main.ts`
builds it, with [`serve()`](/docs/guides/testing/#testing-through-a-server):

```ts twoslash title="src/orders.http.test.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
export * from "@examples/sql/orders";
// @filename: src/orders.http.test.ts
// ---cut---
import { expect, test } from "bun:test";
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { testDatabase } from "@tetsujs/sql/testing";
import { schema } from "./db.generated";
import { ordersController } from "./orders";

const { db } = testDatabase(schema, {
  url: Bun.env.DATABASE_URL,
  dir: "migrations",
});
const request = serve(createApp({ routes: ordersController(db) }));

test("refuses an order for a customer there is not", async () => {
  const response = await request("/customers/999/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ total: "1.00" }),
  });

  expect(response.status).toBe(404);
});
```

A Postgres for the tests in CI is a service of the job: [Deploy and
CI](/docs/database/deploy/#ci) has one.
