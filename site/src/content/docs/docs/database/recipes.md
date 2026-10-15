---
title: Recipes
description: Ids in JSON, rows checked against a schema of your own, raw SQL, and a long result read in pages.
sidebar:
  order: 10
---

## Ids in JSON

An `int8` is read as a `bigint`, and `JSON.stringify` refuses a `bigint`: a
handler that returns a row with one answers `500`. Hand the id on as a
string, and say so in the response's schema, which the OpenAPI document is
built from:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
import { route } from "@tetsujs/core";
import { z } from "zod";

const Order = z.object({ id: z.string(), total: z.string() });

const open = route({
  method: "GET",
  path: "/orders/open",
  schema: { response: { 200: z.array(Order) } },
  handler: async () => {
    const orders = await db
      .selectFrom("orders")
      .select(["id", "total"])
      .where("status", "=", "new")
      .execute();

    return orders.map((order) => ({ ...order, id: String(order.id) }));
  },
});
```

`Number(order.id)` will do as well, while the ids stay below 2⁵³; past that,
a number rounds them. Types generated with `--int8 string` read an id as a
string, which needs neither: [int8 as a
string](/docs/database/types/#int8-as-a-string).

An id that comes in — in a path, a query or a body — comes in as a string.
A codec checks it, up to the largest `int8`, and hands the handler a
`bigint`, while the document says the client sends a string:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
import { httpError, route } from "@tetsujs/core";
import { z } from "zod";

const Id = z.codec(
  z.string().regex(/^[1-9]\d{0,18}$/),
  z.bigint().max(9_223_372_036_854_775_807n),
  { decode: (text) => BigInt(text), encode: (id) => String(id) },
);

const cancel = route({
  method: "POST",
  path: "/orders/:id/cancel",
  schema: { params: z.object({ id: Id }) },
  handler: async (ctx) => {
    const { numUpdatedRows } = await db
      .updateTable("orders")
      .set({ note: "cancelled" })
      .where("id", "=", ctx.params.id)
//                                 ^?
      .executeTakeFirst();

    if (numUpdatedRows === 0n) {
      throw httpError(404, "ORDER_NOT_FOUND");
    }

    return { cancelled: true };
  },
});
```

With [`@tetsujs/typebox`](/docs/packages/typebox/), the codec is TypeBox's.
A `Decode` that throws refuses the value with a `422`, as a pattern that
does not match does:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
import { httpError, route } from "@tetsujs/core";
import { tb, Type } from "@tetsujs/typebox";

const Id = Type.Codec(Type.String({ pattern: "^[1-9][0-9]{0,18}$" }))
  .Decode((text) => {
    const id = BigInt(text);

    if (id > 9_223_372_036_854_775_807n) {
      throw new Error("is larger than the largest int8");
    }

    return id;
  })
  .Encode((id: bigint) => String(id));

const cancel = route({
  method: "POST",
  path: "/orders/:id/cancel",
  schema: { params: tb(Type.Object({ id: Id })) },
  handler: async (ctx) => {
    const { numUpdatedRows } = await db
      .updateTable("orders")
      .set({ note: "cancelled" })
      .where("id", "=", ctx.params.id)
//                                 ^?
      .executeTakeFirst();

    if (numUpdatedRows === 0n) {
      throw httpError(404, "ORDER_NOT_FOUND");
    }

    return { cancelled: true };
  },
});
```

Either way, the OpenAPI document says the client sends a string, with the
pattern, and the handler is handed a `bigint`.

## Rows checked against a schema

A query of the builder or of a file is typed by the database, and needs no
check of its rows. Raw SQL is typed by what it is told, as in
`` sql<Report>`…` ``, and some values depend on the data more than on the
schema: a `sum` over no rows is NULL, as is a `json_agg` over none.

Where that matters, check the rows with a schema of your own:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/report.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
import { sql } from "kysely";
import { z } from "zod";

const Totals = z.object({ customers: z.number(), revenue: z.string() });

const { rows } = await sql`
  select count(distinct customer_id)::int4 as customers, sum(total) as revenue
  from orders
  where status = 'paid'
`.execute(db);

const totals = rows.map((row) => Totals.parse(row));
```

A row that fails the check is the database disagreeing with the code: a
bug, which the application answers with a `500`, not the client's `422`.
Here, a `revenue` of NULL fails when nothing is paid yet; a
`coalesce(sum(total), 0)` in the query keeps it a string. A [query
file](/docs/database/query-files/) is often the better answer: Postgres
types it, and the generated file says which columns may be NULL.

## Raw SQL

Kysely's `` sql`…` `` binds every value as a parameter, never as text of the
query. Within it:

- `sql.ref("orders.status")` names a column, and `sql.id("orders")` a table,
  quoted as Postgres reads them;
- `sql.join(values)` writes a list of parameters: `` sql`id in (${sql.join(ids)})` ``;
- an array for an array type is built in the query, as
  `` sql`array[${sql.join(labels)}]::text[]` ``: [Arrays](/docs/database/queries/#arrays).

A raw query that binds no value may hold several statements, and resolves
to the rows of the last; with a value, Postgres refuses more than one.
Anything long is clearer as a query file, which Postgres checks when the
types are generated.

## A long result, in pages

Bun.SQL has no cursor, so a long result is read in pages, each after the
last key of the one before:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/export.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
declare function write(row: { id: bigint; total: string }): void;
// ---cut---
let after = 0n;

for (;;) {
  const page = await db
    .selectFrom("orders")
    .select(["id", "total"])
    .where("id", ">", after)
    .orderBy("id")
    .limit(1_000)
    .execute();

  for (const row of page) {
    write(row);
  }

  const last = page.at(-1);

  if (last === undefined) {
    break;
  }

  after = last.id;
}
```

An index on the key keeps every page as quick as the first, which an
`offset` does not.
