---
title: Deploy and CI
description: Migrations as a step before the application starts, the database checked against the types at start, the generated files checked in CI, and the connection settings production needs.
sidebar:
  order: 8
---

## Migrations before the application

Apply the migrations as a step of the deploy, before the new version
starts: a release job, a Kubernetes `Job`, a step of the pipeline.

```bash
bunx tetsu-sql migrations:run --json
```

- **A failure stops the deploy** before any instance runs code the database
  is not ready for.
- **The migrations can run as a role of their own,** given by the step's
  `DATABASE_URL`, with rights to change the schema that the application's
  role does not need.
- **One run applies them.** Instances started together would be safe as
  well, since a run waits for another to finish, but each would hold a
  connection while it waits.

The version before keeps running while the migrations apply, and until the
new one is out, so a migration must not break it: [Changing a schema the
application runs on](/docs/database/migrations/#changing-a-schema-the-application-runs-on).

A database built before its migrations takes a baseline once, before its
first run: [Adopting a database](/docs/database/migrations/#adopting-a-database).

The migrations are read from disk by the step that applies them: ship the
directory with it. The application itself reads none of them, so a binary
built with `bun build --compile` holds only the generated files, which are
ordinary modules.

## Checking the database at start

`verifySchema()` checks, before the application serves, that the database
has applied the migration the types were built from:

```ts twoslash title="src/main.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
export * from "@examples/sql/orders";
// @filename: src/main.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { createApp } from "@tetsujs/core";
import { database, verifySchema } from "@tetsujs/sql";
import { schema } from "./db.generated";
import { ordersController } from "./orders";

const db = database(schema, { url: config.DATABASE_URL });

await verifySchema(db, schema);

Bun.serve({ ...createApp({ routes: ordersController(db) }) });
```

A deploy whose migrations did not run then fails as it starts, with a
`MigrationError`, rather than on the first request that needs them:

- `behind` — the database has not applied the migration, or has no journal;
- `changed` — it applied another text of that migration;
- `table` — the journal's table is not a journal.

Newer migrations may follow it: after a rollback, the code is older than
the database, and runs on it as it did before. The journal is read with
`db`'s own connection, so the application's role needs to read it. A journal
in a schema the connection does not search is named as `schema.table`, with
`--table`, when the types are generated.

## CI

CI checks that the generated files are what the migrations and the query
files make, then runs the tests, on a Postgres of the job:

```yaml title=".github/workflows/ci.yml"
jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 2s
          --health-timeout 5s
          --health-retries 15

    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx tetsu-sql types:generate --check
      - run: bun test
```

`types:generate --check` writes nothing. It fails when a file differs from
what the migrations and the query files make, in anything but its
formatting, and says which: `src/db.generated.ts is out of date: run
tetsu-sql types:generate`. A migration changed without generating the types
again, or a query file that no longer fits the schema, fails the build
rather than a request in production.

The image is the Postgres of production, so that the types and the tests
see what production does.

## Connections

### TLS

Without `sslmode` in the URL, or `PGSSLMODE` in the environment, Bun connects
without TLS, where Postgres's own clients would try TLS first. Name the mode
in the URL: `sslmode=require`
encrypts, and `sslmode=verify-full` also checks the server's certificate and
its name. A certificate signed by an authority of your own goes in Bun's
[`tls` option](https://bun.com/docs/runtime/sql), which `database()` passes
on. `tetsu-sql` and `generate()` take only a URL: name the authority's file
in `NODE_EXTRA_CA_CERTS`, which Bun trusts for every connection, theirs
included.

`sslmode=prefer` hangs on a server that offers no TLS, in Bun 1.4.3: use
`require`, or `disable` on a network of your own.

### The database a URL names

Bun 1.4.3 takes `PGDATABASE`, when it is set, over the database a URL
names. `database()`, `tetsu-sql` and `testDatabase()` give Bun the URL's
database apart from the URL, so the URL wins. A client of your own, such as
one handed to `migrate()`, needs the same: `new SQL({ url, database: "shop"
})`.

### A unix socket

Bun reaches a server on the unix socket that `path` names in the URL:
`postgres://shop@localhost/shop?path=/var/run/postgresql/.s.PGSQL.5432`.
`tetsu-sql types:generate` and `generate()` build the types over it, but
describe query files on a connection of their own, which reaches a server
only by its host and port: with query files, they refuse a URL with `path`.

### The size of the pool

`max` is per process, and a process that cancels a query opens one
connection more, to send the cancel on. Postgres's `max_connections`, 100 by
default, is shared by every process of every instance. A query holds no connection of
its own, so the pool's size is a matter of the transactions that run at
once: they take turns at `max − 1` connections, and the one left over runs
everything else.

Behind a pooler in transaction mode, such as PgBouncer, a session lasts one
transaction: `db.connection()`, a session's advisory lock and `set` do not
hold across transactions there. Bun prepares statements on each
connection; where the pooler does not keep prepared statements, pass
`prepare: false`.

### Timeouts

`statement_timeout` is the server's limit on a query: [Cancelling a
query](/docs/database/queries/#cancelling-a-query) sets it for the pool. Bun's
own options limit the pool: `connectionTimeout`, 30 seconds by default,
`idleTimeout` and `maxLifetime`, in seconds.

### Shutdown

`db.destroy()` closes the pool once the requests in flight are done, as a
`close` of [`@tetsujs/lifecycle`](/docs/packages/lifecycle/):
[Queries](/docs/database/queries/) shows it.
