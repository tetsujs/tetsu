---
title: Queries
description: database() and Kysely's builder on it, values as the types say, arrays, the pool and its reservations, a session of its own, and cancelling a query.
sidebar:
  order: 4
---

```ts twoslash title="src/db.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/db.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { database } from "@tetsujs/sql";
import { schema } from "./db.generated";

export const db = database(schema, { url: config.DATABASE_URL });
```

`database()` returns Kysely on a pool of Bun.SQL, for the database the
generated `schema` describes. The URL is a `postgres://` or `postgresql://`
one, and the other options are Bun's options of a pool, such as `max`,
`idleTimeout` or `tls`, but for those the package sets itself. The package
reads nothing from the environment: the URL is passed in, from the
application's configuration. Bun fills in what the URL leaves out — the
host, the port, the user, the password and `sslmode` — from `PGHOST`,
`PGPORT`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE`, so name them all in the
URL.

Open it once, where the application is wired, and hand it to what needs it,
as any other dependency. `db.destroy()` closes the pool, on shutdown:

```ts twoslash title="src/main.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
export * from "@examples/sql/orders";
// @filename: src/main.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { createApp } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { database } from "@tetsujs/sql";
import { schema } from "./db.generated";
import { ordersController } from "./orders";

const db = database(schema, { url: config.DATABASE_URL });
const server = Bun.serve({ ...createApp({ routes: ordersController(db) }) });

onShutdownSignals(server, { close: [() => db.destroy()] });
```

On a Bun older than 1.4.3, `database()` throws: before it, a query could be
handed the rows of another after a failure on the same connection.

## Queries are Kysely's

Every query is [Kysely's](https://kysely.dev/docs/category/examples), typed
by `DB`:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
declare const customerId: bigint;
// ---cut---
const recent = await db
//    ^?
  .selectFrom("orders as o")
  .innerJoin("customers as c", "c.id", "o.customer_id")
  .select(["o.id", "o.total", "o.placed_at", "c.email"])
  .where("o.customer_id", "=", customerId)
  .orderBy("o.placed_at", "desc")
  .limit(20)
  .execute();

const { id } = await db
  .insertInto("orders")
  .values({ customer_id: customerId, total: "12.50", tags: ["gift"] })
  .returning("id")
  .executeTakeFirstOrThrow();

await db.updateTable("orders").set({ status: "paid" }).where("id", "=", id).execute();
```

The package changes nothing of Kysely's API but two things Bun.SQL cannot
do yet: the `kill session` strategy of [cancelling a
query](#cancelling-a-query), and `stream()`, which needs a cursor: it
throws, so read a long result in
pages instead, by key. A query of raw SQL, with Kysely's `` sql`…` ``,
binds its values as parameters too. One that binds no value may hold
several statements, and resolves to the rows of the last; with a value,
Postgres refuses more than one.

## Values

Values go through as the [generated types](/docs/database/types/#how-each-type-reads)
say: an `int8` is a `bigint` both ways, unless the types were generated with
`--int8 string`, a `numeric` a string, a `json` or
`jsonb` column takes an object or an array and returns what Postgres parsed.
The driver mends what Bun does not do:

- a `Date` is written to any timestamp and to a `date` as its instant, in
  ISO text; an invalid `Date` throws a `RangeError` before anything is sent;
- a number that is not a safe integer, such as `2.5`, is sent as its text,
  which Postgres reads as the type the query gives the parameter. An integer
  column refuses it, `invalid input syntax for type integer: "2.5"`, where
  Bun would send a `float8` the column rounds to the even, `2`, without an
  error; a `float8`, a `float4` and a `numeric` read the number it is. In
  raw SQL, where nothing gives the parameter a type, cast it:
  `` sql`${ratio}::float8` ``;
- an `int4[]` or a `float4[]`, which Bun reads as an `Int32Array` or a
  `Float32Array` when a query has parameters, is read as an array, as it is
  without them.

### Arrays

Bun cannot bind a JavaScript array to a column of arrays, so `database()`
writes it as the literal Postgres reads, such as `{"gift","glass"}`. It does
so wherever a query says the array goes to such a column:

- a value of an insert, an upsert or a merge, and a `set` of an update;
- a value compared with a column of arrays of the same query, such as
  `where("tags", "@>", ["gift"])`;
- the argument of `any()` or `all()`, which only an array can be.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
const gifts = await db
  .selectFrom("orders")
  .select("id")
  .where("tags", "@>", ["gift"])
  .execute();

const some = await db
  .selectFrom("orders")
  .select(["id", "status"])
  .where((eb) => eb("id", "=", eb.fn.any(eb.val([1n, 2n, 3n]))))
  .execute();
```

Elements are written as their column takes them: by the delimiter of the
type, which is `;` for a `box`, and as JSON for an array of `json` or
`jsonb`. An array of arrays is written as one of more dimensions.

Anywhere else an array is bound as Bun binds it: as JSON into a `jsonb`
column, which is right, and as nothing Postgres reads for an array type, in
raw SQL or as the argument of another function. There, build the array in
the query:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
import { sql } from "kysely";

const labels = ["gift", "fragile"];
const { rows } = await sql<{ tagged: boolean }>`
  select array[${sql.join(labels)}]::text[] && array['gift'] as tagged
`.execute(db);
```

## Values and SQL

A value never becomes text of a query. The builder, `` sql`…` `` and the
functions of query files send every value as a parameter, apart from the
SQL, and Postgres reads it as data: a name such as
`'; drop table customers; --` is stored as it is. An array goes as one
parameter too, the elements of its literal quoted and escaped.

What a parameter cannot carry is left to the code:

- **SQL made of input.** `sql.raw()` and `sql.lit()` write their argument
  into the query as it is: never hand them input.
- **A name from input,** such as the column a list is sorted by. A name is
  not a value, so it cannot be a parameter: in a query file,
  `order by :column` sorts by a constant. Kysely quotes a name it is given,
  but the name can be any column, so map the input to the names it may be.
- **`set`,** which takes no parameter: `` sql`set local app.user_id = ${id}` ``
  fails with `42601`. `set_config()` takes the value as one.
- **A pattern of `like`,** where `%` and `_` from input match anything.
  Escape them.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
declare const userId: string;
declare const typed: string;
// ---cut---
import { sql } from "kysely";

const sortable = { placed: "placed_at", total: "total" } as const;

function openOrders(sort: keyof typeof sortable) {
  return db
    .selectFrom("orders")
    .select(["id", "total", "placed_at"])
    .where("status", "=", "new")
    .orderBy(sortable[sort], "desc")
    .execute();
}

await db.transaction().execute(async (trx) => {
  await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
  // the transaction's queries, and its policies, read current_setting('app.user_id')
});

const matching = await db
  .selectFrom("customers")
  .select("email")
  .where("email", "like", `${typed.replaceAll(/[\\%_]/g, "\\$&")}%`)
  .execute();
```

`set_config()` with `true` holds for the transaction, as `set local` does.

## The pool

A query runs on Bun's pool, which sends the queries of many callers down one
connection without waiting for each answer. A query holds no connection of
its own, and `max`, 10 by default, limits connections, not queries: the
[benchmark](/docs/more/performance/#database-queries) runs 32 queries at a
time on 10 connections.

Three things reserve a connection for themselves:

- a transaction, from its `begin` to its end;
- the work of `db.connection()`, below;
- a query given a signal with Kysely's `cancel query` strategy, to cancel it
  by.

Reservations take turns, in the order they come, at one fewer connection
than `max`, at least one. Bun hands a connection that comes free to a
waiting reservation before any other query, so were every connection
theirs to take, a burst of transactions would hold up every other query —
health checks included — until it ended. The connection left over is the
pool's.

A reservation inside another's work, such as a transaction opened on `db`
inside the callback of `db.connection()`, needs a turn of its own, and waits
for it while holding the first. With `max: 2` there is one turn, and it
waits forever. Run the inner queries on what the work is handed — the
`trx` of a transaction, the connection of `connection()` — and it needs no
turn.

## A session of its own

Queries of `db` share no session: two of them may run on different
connections. Work that needs one — a `set` that later queries read, a
temporary table, a session's advisory lock — runs in `db.connection()`,
whose queries share one connection, reserved for it:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
declare function closeTheDay(db: Kysely<DB>): Promise<void>;
// ---cut---
import { sql } from "kysely";

await db.connection().execute(async (session) => {
  await sql`select pg_advisory_lock(${42})`.execute(session);

  try {
    await closeTheDay(session);
  } finally {
    await sql`select pg_advisory_unlock(${42})`.execute(session);
  }
});
```

The connection goes back to the pool as the work left it: Bun resets
nothing. Undo what the work set for the session before it ends, or set it
with `set local` inside a transaction, which ends with it. `connection()`
keeps its session on a Kysely made from `db` too, by `withSchema()` or
`withPlugin()`. A query the work runs on `db` itself, rather than on what it
is handed, runs on the pool.

## Cancelling a query

A query is given up with an `AbortSignal`, as Kysely takes it:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/report.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// ---cut---
const totals = await db
  .selectFrom("orders")
  .select(["status", db.fn.sum<string>("total").as("total")])
  .groupBy("status")
  .execute({
    signal: AbortSignal.timeout(5_000),
    inflightQueryAbortStrategy: "cancel query",
  });
```

The promise then fails with the signal's reason. What happens to the query
depends on where it was:

- **Waiting for a connection,** in Bun's queue, it is taken out, and never
  runs. A write given up while the pool was busy is not made later.
- **Sent, with the default `ignore query`,** it runs to its end on the
  server, and its answer is dropped.
- **Sent, with `cancel query`,** a connection of the database's own sends
  Postgres the cancel for its backend: Postgres stops it, and inside a
  transaction the transaction then fails to commit. Kysely prints the
  query's own failure, `` `query` failed in the background after
  abortion ``, on the console.

`kill session` is not supported: Bun's pool may wait forever to close a
connection the server ended.

A limit the server holds for every query of the pool is
`statement_timeout`, a setting Bun sends as each connection opens:

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/db.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { database } from "@tetsujs/sql";
import { schema } from "./db.generated";

export const db = database(schema, {
  url: config.DATABASE_URL,
  connection: { statement_timeout: "5s" },
});
```

A query that runs longer fails with `57014`. The URL's `options` parameter
sets it as well, as `?options=-c%20statement_timeout%3D5s`.
