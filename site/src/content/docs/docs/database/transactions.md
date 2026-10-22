---
title: Transactions and errors
description: Kysely's transactions, units of work with atomic() that hold together inside another's transaction too, and a broken constraint told by its name.
sidebar:
  order: 6
---

## Transactions

A transaction is Kysely's: it commits when its callback resolves, and rolls
back when the callback throws. Its queries run on `trx`, the connection it
reserved; a query on `db` inside the callback runs outside it.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
const order = await db
  .transaction()
  .setIsolationLevel("serializable")
  .execute(async (trx) => {
    const { id } = await trx
      .insertInto("orders")
      .values({ customer_id: 1n, total: "12.50" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("shipments")
      .values({ order_id: id, carrier: "post" })
      .execute();

    return id;
  });
```

A query that fails aborts the transaction, even when the callback catches
the failure and goes on: Postgres then turns the commit into a rollback. The
commit fails, with Bun's `ERR_POSTGRES_COMMIT_ROLLED_BACK`, rather than
resolve with nothing written. To go on after a failure that is expected,
run the part that may fail in a unit of its own, below: a savepoint takes
the failure, and the transaction goes on.

A transaction Kysely controls, from `db.startTransaction()`, holds its
connection until it is committed or rolled back, or, dropped without
either, until it is garbage-collected: Bun then closes the connection,
which rolls the transaction back. One whose commit failed still holds it,
so roll back in the `catch`:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
const trx = await db.startTransaction().execute();

try {
  await trx.updateTable("orders").set({ status: "paid" }).where("id", "=", 7n).execute();
  await trx.commit().execute();
} catch (error) {
  await trx.rollback().execute();
  throw error;
}
```

## Units of work

A method of a service that writes in two places has to hold together
whether it is called on its own or inside a caller's transaction. Kysely's
`transaction()` refuses to open inside another. `atomic()` does what each
case needs:

```ts twoslash title="src/shipping.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/queries.generated.ts
export * from "@examples/sql/queries.generated";
// @filename: src/shipping.ts
// ---cut---
import { atomic } from "@tetsujs/sql";
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
import { shipOrder } from "./queries.generated";

export function ship(db: Kysely<DB>, id: bigint, carrier: string) {
  return atomic(db, async (trx) => {
    if ((await shipOrder(trx, { id })) === 0n) {
      throw new Error("only a paid order ships");
    }

    await trx.insertInto("shipments").values({ order_id: id, carrier }).execute();
  });
}
```

- **On its own,** `ship(db, …)` opens a transaction, which commits when the
  work resolves and rolls back when it throws.
- **Inside a transaction,** `ship(trx, …)` marks a savepoint instead: the
  work throwing undoes what it wrote, and nothing the transaction wrote
  before it, which goes on.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/shipping.ts
import { atomic } from "@tetsujs/sql";
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
export function ship(db: Kysely<DB>, id: bigint, carrier: string) { return atomic(db, async () => {}); }
// @filename: src/checkout.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
import { ship } from "./shipping";
declare const db: Kysely<DB>;
// ---cut---
await ship(db, 7n, "post");

await db.transaction().execute(async (trx) => {
  await trx.updateTable("orders").set({ note: "rush" }).where("id", "=", 8n).execute();
  await ship(trx, 8n, "courier");
});
```

A query of the work that fails aborts what the work wrote, though the work
catches the failure: on its own the commit fails, and inside a transaction
the savepoint is rolled back and fails the same way, with
`ERR_POSTGRES_COMMIT_ROLLED_BACK`.

Units of one transaction run one after another, or one inside another,
never side by side: rolling one back would undo what the other wrote. A
unit opened beside one that is still open, as by `Promise.all`, is refused
before it writes anything.

A function of a [query file](/docs/database/query-files/) takes `trx` as it
takes `db`, so a unit mixes them freely, as `ship` does.

## A broken constraint

`isViolation(error, name)` tells whether Postgres refused a write for
breaking the constraint `name`: a unique key or index, a foreign key, a
check of a table or of a domain, or an exclusion constraint.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/customers.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
declare const email: string;
declare const name: string;
// ---cut---
import { httpError } from "@tetsujs/core";
import { isViolation } from "@tetsujs/sql";

try {
  await db.insertInto("customers").values({ email, name }).execute();
} catch (error) {
  if (isViolation(error, "customers_email_key")) {
    throw httpError(409, "EMAIL_TAKEN");
  }

  throw error;
}
```

The names it takes are those of the generated `Constraint`, so a name the
database does not have does not compile:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/customers.ts
import "./db.generated";
import { isViolation } from "@tetsujs/sql";
declare const error: unknown;
// @errors: 2345
// ---cut---
isViolation(error, "customers_emial_key");
```

It reads the class of the error's SQLSTATE and the constraint the error
names, and nothing of its `detail`, which holds values of the row, such as
the email that was taken: keep `detail` out of the response. When the name
matches, `error` is narrowed to Bun's `PostgresError`, with that
`constraint`.

A failure inside a transaction aborts it all the same. Answer it outside
the transaction, or run the write in a unit of its own with `atomic()`,
whose savepoint takes the failure while the transaction goes on.

A key, a unique index or an exclusion constraint of a partitioned table is
each partition's own: a duplicate in `events` breaks `events_2026_pkey`, of
the partition the row goes to, and never `events_pkey`. `Constraint` holds
them under the names they have in the partitions the migrations create,
not the table's. A partition made later, as by a job that adds one each
month, is in no generated file: tell its violation by `errno`, `23505` for
a duplicate, and by `table`, the partition. A foreign key or a check keeps
the table's name in every partition.
