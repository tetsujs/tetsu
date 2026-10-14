---
title: Postgres with @tetsujs/sql
description: SQL migrations as the source of truth, Kysely types generated from the database they build, and SQL files typed by Postgres itself, on Bun's own client.
sidebar:
  order: 1
  label: Overview
---

`@tetsujs/sql` puts Postgres behind an application on Tetsu, through Bun's
own client. The schema is a directory of SQL migrations. The types are
generated from the database those migrations build, as Postgres describes
it, so a column the database can leave NULL is `| null` in the code, and a
constraint is known by the name the database gives it. Queries are written
with Kysely's builder, on a driver of the package's own, or as SQL files,
whose functions Postgres types as well.

```bash
bun add @tetsujs/sql kysely
```

The package needs Bun 1.4.3 or later and Postgres 14 or later. Kysely is a
peer dependency: queries are written with it, and the package gives it a
driver on Bun.SQL that keeps every value what the types say.

## From a migration to a route

The command line, `tetsu-sql`, does the work outside the application. Three
scripts cover it:

```json title="package.json"
"scripts": {
  "db:new": "tetsu-sql migrations:new",
  "db:migrate": "tetsu-sql migrations:run",
  "db:types": "tetsu-sql types:generate"
}
```

`bun run db:new create_orders` creates an empty migration, named with the
current time, for the schema to be written in:

```sql title="migrations/20261014120100_create_orders.sql"
create type order_status as enum ('new', 'paid', 'shipped');

create table orders (
  id int8 generated always as identity primary key,
  customer_id int8 not null references customers (id),
  status order_status not null default 'new',
  total numeric(12, 2) not null check (total >= 0),
  tags text[] not null default '{}',
  note text,
  placed_at timestamptz not null default now()
);
```

`bun run db:migrate` applies it to the database `DATABASE_URL` names.
`bun run db:types` builds the migrations on a scratch database of the same
server, reads it back, and writes `src/db.generated.ts`:

```ts title="src/db.generated.ts"
export type OrderStatus = "new" | "paid" | "shipped";

export interface DB {
  orders: {
    id: GeneratedAlways<bigint>;
    customer_id: bigint;
    status: Generated<OrderStatus>;
    total: string;
    tags: Generated<ArrayOfNullable<string>>;
    note: string | null;
    placed_at: Generated<Timestamp>;
  };
  // the other tables, the constraints' names, and `schema` for the runtime
}
```

`database()` opens a pool on the database, and a controller takes it as a
dependency, as it would take anything else:

```ts twoslash title="src/orders.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { controller, createApp, route } from "@tetsujs/core";
import { database } from "@tetsujs/sql";
import type { Kysely } from "kysely";
import { type DB, schema } from "./db.generated";

const ordersController = controller("Orders", (db: Kysely<DB>) => ({
  open: route({
    method: "GET",
    path: "/orders/open",
    handler: async () => {
      const orders = await db
        .selectFrom("orders")
        .select(["id", "total", "placed_at"])
        .where("status", "=", "new")
        .execute();

      return orders.map((order) => ({ ...order, id: String(order.id) }));
      //     ^?
    },
  }),
}));

const db = database(schema, { url: config.DATABASE_URL });

Bun.serve({ ...createApp({ routes: ordersController(db) }) });
```

Nothing is annotated: the row's type is the table's columns as the database
reads them. `where("status", "=", "open")` would not compile, since `open` is
not a label of the enum. An `int8` is read as a `bigint`, which JSON cannot
hold, so the handler hands the id on as a string:
[Recipes](/docs/database/recipes/#ids-in-json) has the ways to do it.

The files the commands write are part of the code: commit them, and let CI
check that they match the migrations, as [Deploy and
CI](/docs/database/deploy/#ci) shows.

## The pages

- [Migrations](/docs/database/migrations/) — writing them, applying them,
  and changing a schema the application is running on.
- [Types from the database](/docs/database/types/) — what is generated, and
  how each Postgres type reads and is written.
- [Queries](/docs/database/queries/) — `database()`, Kysely's builder on it,
  the pool, sessions, and cancelling a query.
- [Query files](/docs/database/query-files/) — SQL in files of its own, each
  a typed function, with its NULLs told by Postgres.
- [Transactions and errors](/docs/database/transactions/) — `atomic()`, and
  telling a broken constraint by its name.
- [Testing](/docs/database/testing/) — a database of its own for each test
  file, built from the migrations.
- [Deploy and CI](/docs/database/deploy/) — migrations before the
  application starts, and the generated files checked in CI.
- [Bun's limits](/docs/database/bun-limits/) — what Bun.SQL does not do
  yet, and what the package does about it.
- [Recipes](/docs/database/recipes/) — ids in JSON, checking rows, raw SQL.

What a query costs over Bun.SQL alone, and next to Drizzle, is on
[Performance](/docs/more/performance/#database-queries).

## What it is not

- **Not an ORM.** There are no models and no relations: the schema is
  written in SQL, and the types follow the database, never the other way
  round.
- **Not a generator of migrations.** A migration is written by hand, as the
  SQL Postgres runs. `types:generate` reads the migrations; it never writes
  one.
- **Postgres only, on Bun.SQL.** There is no driver of Node's, such as `pg`,
  and no other database.
- **Columns keep their names.** A column is `placed_at` in the code as in
  the database. A plugin that renames keys on the way out renames the keys
  inside `jsonb` values too, and a query of the code would no longer read
  as the SQL it runs.
