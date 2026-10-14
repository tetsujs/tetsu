---
title: Query files
description: SQL in files of its own, each written as a function that Postgres types — its parameters, its columns, and which of them may be NULL.
sidebar:
  order: 5
---

Some queries read better as SQL: a report with CTEs, a window function, a
query tuned against its plan. A query file holds one, in `queries/`.
`tetsu-sql types:generate` has Postgres describe each, without running it,
on the database the migrations build, and writes a function for it into
`src/queries.generated.ts`, typed by Postgres's answer.

```sql title="queries/customer-orders.sql"
-- A customer's orders, newest first, with the shipment of each that has
-- one.
select o.id, o.status, o.total, s.carrier, s.shipped_at
from orders o
  left join shipments s on s.order_id = o.id
where o.customer_id = :customerId
order by o.placed_at desc
```

```ts title="src/queries.generated.ts"
export interface CustomerOrdersRow {
  id: bigint;
  status: Database.OrderStatus;
  total: string;
  carrier: string | null;
  shipped_at: Date | null;
}

export interface CustomerOrdersParams {
  customerId: bigint;
}

/**
 * A customer's orders, newest first, with the shipment of each that has
 * one.
 *
 * `../queries/customer-orders.sql`
 */
export function customerOrders(
  db: Kysely<Database.DB>,
  params: CustomerOrdersParams,
): Promise<CustomerOrdersRow[]> {
  return queryRows(db, CUSTOMER_ORDERS, params);
}
```

`carrier` and `shipped_at` are `not null` in `shipments`, but the left join
leaves them NULL for an order that has not shipped. Postgres's plan of the
query says so, and the type follows: code that reads `shipped_at` without
checking it does not compile.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/queries.generated.ts
export * from "@examples/sql/queries.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// @errors: 18047
// ---cut---
import { customerOrders } from "./queries.generated";

for (const order of await customerOrders(db, { customerId: 1n })) {
  console.log(order.id, order.shipped_at.toISOString());
}
```

A function takes the database or a transaction, as anything written with
Kysely does. A query that returns no rows — an `update` without
`returning`, say — resolves to how many rows it changed, as a `bigint`.

## Writing a file

- **The name** is lowercase words joined by hyphens, and the function is
  its camel case: `customer-orders.sql` is `customerOrders`. A name that
  would make a reserved word, such as `delete.sql`, is refused.
- **The comment the file opens with** is the function's documentation.
- **A parameter** is a name after a colon, `:customerId`: the same name is
  the same parameter. Numbered ones, `$1`, are refused.
- **One query a file:** Postgres prepares it as one statement.

A colon after a letter, a digit, an underscore, a closing bracket or a
quote is not a parameter, so `total::text` and `tags[1:3]` are left as they
are, and so is anything in a string, a quoted name or a comment. Two cases
read as a parameter where they are not:

- **A slice from the start to a column,** `tags[:size]`, reads `:size` as a
  parameter: write `tags[1:size]`.
- **jsonb's `?` right after a parameter,** `:document?`, marks the parameter
  as maybe NULL: write `:document ? 'key'`, with a space.

## Parameters

A parameter is typed as Postgres types it from where it stands, and written
as a column of that type is: `:customerId` compared with an `int8` column
is a `bigint`, `:since` compared with a `timestamptz` is a `Date | string`,
and `any(:statuses)` against an enum column is a `readonly OrderStatus[]`.
An array is written as the literal Postgres reads, as
[`database()`](/docs/database/queries/#arrays) writes one.

A parameter is not NULL unless it says it may be, with `?` where it first
appears:

```sql title="queries/orders-with-note.sql"
select id, note from orders
where customer_id = :customerId and (note = :note? or :note? is null)
```

Where Postgres cannot tell a parameter's type, the generator says so, and
hints at a cast when nothing in the query types the parameter at all. A
parameter that first appears in `:since is null` is one: nothing there says
what it is. The cast goes where it first appears:

```sql title="queries/orders-since.sql"
select id, placed_at from orders
where :since?::timestamptz is null or placed_at >= :since
```

## Which columns may be NULL

Postgres describes a query's columns, and the table and column each is read
from; the generated types give that column's type. Whether it may be NULL
comes from the plan of the query, made for any values of its parameters:

- A query with no outer join and no grouping sets, whose statement returns
  only the rows it writes, makes no column NULL: a column is NULL as its
  table's column is.
- Otherwise, a column is not NULL only where the plan reads it from its
  table, and not on a side a join may leave NULL. A side a left, right,
  full or anti join leaves NULL is NULL, and so is a column a materialized
  CTE or a subquery gives on.
- With grouping sets, every column may be NULL.
- Any other column — an expression, an aggregate, a column of a union, or
  of a relation the generated file does not describe — may be NULL, and so
  may every column of a query Postgres cannot plan, such as `show`.

A quoted name that ends in `!` or `?` overrides all that: `!` says the
column is never NULL, and `?` that it may be. The marker is taken off the
name:

```sql title="queries/revenue-by-day.sql"
-- The revenue of paid and shipped orders, by day, since a time.
select date_trunc('day', placed_at) as "day!", sum(total) as "revenue!",
  count(*) as "orders!"
from orders
where status in ('paid', 'shipped') and placed_at >= :since
group by 1
order by 1
```

```ts title="src/queries.generated.ts"
export interface RevenueByDayRow {
  day: Date;
  revenue: string;
  orders: bigint;
}
```

Every column there is an expression or an aggregate, which Postgres says
nothing about. `count(*)` is never NULL; `sum(total)` is not NULL over a
group, whose rows are there and whose `total` is `not null`; and
`date_trunc` of a `not null` column is not NULL. The marker says what the
query knows and the plan does not.

Three cases to know:

- **A partitioned table under an outer join** reads as NULL on the side
  that is kept, too. Mark its columns `!`.
- **An expression cast to a domain,** `:kind::kind`, is typed by the
  domain's base type, as Postgres reports it. A column of a table of that
  domain keeps the domain's type.
- **A column of a view** may be NULL, as a view keeps no `not null`.

## When a file is refused

A file that cannot be read as a query, or one Postgres refuses, fails the
run. Every refusal is told at once, each at the file, line and column it is
about, in Postgres's words, with `:name` in place of the `$n` Postgres
uses. A file whose `where` reads `o.customer` for `o.customer_id` is told,
with Postgres's own hint:

```text
error: queries/customer-orders.sql:6:7: column o.customer does not exist (hint: Perhaps you meant to reference the column "o.customer_id".)
```

`types:generate --check` checks the file of functions as it checks the file
of types: in CI, a query that no longer fits the schema fails the build,
not the first request that runs it.
