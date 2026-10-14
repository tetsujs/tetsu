---
title: Migrations
description: SQL files applied in the order they were made, each in a transaction of its own and recorded in a journal, and what a run refuses before it changes anything.
sidebar:
  order: 2
---

The schema is a directory of SQL files, `migrations/` by default. A file is
named `YYYYMMDDHHMMSS_name.sql`: the UTC time it was made, then a name in
lowercase letters, digits and underscores. Files run in the order of their
names, which is the order they were made in, and the types are generated in
that same order.

## Writing one

```bash
bunx tetsu-sql migrations:new add_shipments
```

This creates `migrations/20261014120500_add_shipments.sql`, empty, and
refuses to overwrite a file of that name. From code, `createMigration()` of
`@tetsujs/sql/generate` does the same.

A migration is the SQL Postgres runs: any number of statements, comments
and `$$` bodies, but none of the commands of `psql` itself, such as `\set`
or `\i`. A pending migration that holds only comments and blank lines is
refused rather than applied: once recorded, it could not be written.

## Applying them

```bash
bunx tetsu-sql migrations:run
```

The command applies the pending migrations to the database `DATABASE_URL`
names, or `--url`, and prints a line for each step: `applying …`, then
`applied … in 12 ms`, or `nothing to apply`. A failure is printed on stderr,
and the command exits with 1. What Postgres adds to it follows, a line
each, as psql prints it: the SQLSTATE, then the detail and the hint when
there are any.

```text wrap
error: 20261014120500_unique_email.sql failed: could not create unique index "customers_email_key"
sqlstate: 23505
detail: Key (email)=(ann@example.com) is duplicated.
```

The detail holds values of rows, as here. With `--json`, each line is a
JSON object with its time and level, for a log collector, and so is a
failure, on stdout with the rest, with `sqlstate`, `detail` and `hint` as
fields of its own.

The same run, from code, is `migrate()`, on a Bun.SQL client of its own:

```ts twoslash title="scripts/migrate.ts"
import { SQL } from "bun";
import { migrate } from "@tetsujs/sql";

const sql = new SQL({ url: Bun.env.DATABASE_URL, database: "shop" });

try {
  const { applied } = await migrate(sql, {
    dir: "./migrations",
    write: (record) => console.log(record),
  });

  console.log(`${applied.length} applied`);
} finally {
  await sql.close();
}
```

The run reserves one connection of the client and closes it at the end, so
nothing a migration set for its session reaches anything else. Bun 1.4.3
takes `PGDATABASE`, when it is set, over the database a URL names: where it
may be set, give the client the database as `database` too, as the command
does.

Each migration runs in a transaction of its own, and is recorded in the
journal in that same transaction. A migration that fails leaves nothing of
itself applied or recorded; the ones before it stay applied. Each starts
from the session's defaults, so a `search_path` or a role one of them sets
does not reach the next.

A run holds an advisory lock for its whole length. A second run started
meanwhile waits for it — `waiting for another migration run to finish` — and
then finds nothing left to apply. So every instance of an application can
run the migrations as it starts without applying one twice, though a step
of its own before the start is safer: see [Deploy and
CI](/docs/database/deploy/#migrations-before-the-application).

## What a run refuses

Before it applies anything, a run checks the files against the journal:
every applied migration must still have its file, unchanged, and every
pending one must be newer than the last one applied. A refusal is a
`MigrationError`, whose `reason` says what was wrong and whose `migration`
names the file to blame.

| `reason` | when |
| --- | --- |
| `directory` | the migrations directory is not there |
| `name` | a `.sql` file is not named as a migration, or a new migration's name is not lowercase letters, digits and underscores, or its file exists |
| `encoding` | a migration file is not UTF-8 |
| `empty` | a pending migration holds nothing to run, or one a baseline would record |
| `table` | the journal's table exists, and is not a journal |
| `missing` | an applied migration's file is gone, though newer files are there, or the directory holds no migration at all; for a baseline, the migration named is not there |
| `changed` | an applied migration's file has changed |
| `out-of-order` | a pending migration is older than the last one applied |
| `recorded` | a baseline found migrations recorded in the journal already: [Adopting a database](#adopting-a-database) |
| `failed` | a migration failed, and was rolled back, unless it runs outside a transaction; the Postgres error is the `cause` |
| `own-transaction` | a migration ended its transaction itself, with a `COMMIT` or a `ROLLBACK` |

Every reason but the last two is found before anything is applied, so the
database is as it was. After those two, `applied` lists what the run applied
first.

An applied migration newer than every file is not missing: the code was
rolled back past it, while the database kept it. The run applies nothing,
and names it in `ahead`, so that the old code can start on the newer
database — as long as the migration left it working for the code before
it, which is the next section's subject.

## Changing a schema the application runs on

The application keeps running while the migrations apply, and until its new
version is out: a migration runs under the code before it. Renaming a
column, changing its type or making it `not null` breaks that code at once.
Such a change takes three releases:

1. **Expand.** Add the new column or table, nullable or with a default, and
   nothing the old code reads.
2. **Switch.** Release code that writes both and reads the new one; fill the
   new one from the old in a migration or a job.
3. **Contract.** Once no running code reads the old one, drop it, in a later
   release.

There are no down migrations: a mistake is undone by a new migration, and a
release rolled back runs on the database as it is, which the expand step
keeps working for it.

[squawk](https://squawkhq.com/) lints migrations for statements that hold
long locks on a busy table, such as a column added with a volatile default,
which rewrites the table, or an index built without `concurrently`. It
reads the same files, as a step of CI.

## Locks and timeouts

A statement of a migration waits at most 5 seconds for a lock, then fails,
and the migration is rolled back. A statement waiting for a lock holds up
every later query that needs the same lock, so an `ALTER TABLE` behind a
long transaction would stall the application; failing early and running
again later does not. `--lock-timeout-ms` changes the limit, or the
`lockTimeoutMs` option of `migrate()`; `0` waits as long as it takes.

## Outside a transaction

A migration whose first line is `-- no-transaction` runs outside one, as
`create index concurrently` must, and is recorded once it has run:

```sql title="migrations/20261014121000_index_orders_by_status.sql"
-- no-transaction
create index concurrently orders_status_idx on orders (status);
```

Postgres runs the statements of such a file together, so a `concurrently`
statement must be the only one in it. It runs without a lock timeout:
`create index concurrently` waits for every older transaction to end,
without holding up the application, and building the index may take long.
One that fails leaves an invalid index behind: drop it, with `drop index
concurrently`, before running the migration again.

## The journal

The journal is a table, `migrations` by default, in the first schema of the
`search_path`: a row for each applied migration, with its name, the SHA-256
of its text and when it was applied. `--table` names another, as `table` or
`schema.table`. A table of that name that is not a journal is refused, never
written to.

`verifySchema()` reads the same journal when the application starts:
[Deploy and CI](/docs/database/deploy/#checking-the-database-at-start).

## Adopting a database

A database built before its migrations, by another tool or by hand, has
the schema they create already, so its first run fails, and says what to do:

```text wrap
error: 20261015120000_schema.sql failed: relation "customers" already exists. If the database was built before its migrations, record the ones it has instead of running them: tetsu-sql migrations:baseline <the last one it has>
sqlstate: 42P07
```

A baseline records migrations in the journal as applied, with their
checksums, without running them:

```bash
bunx tetsu-sql migrations:baseline 20261015120000_schema
```

It records the migration named and every one before it, and
`migrations:run` then applies the ones after. The name goes with or
without `.sql`, or as the file's path, and `--dir`, `--url` and `--table`
are the ones `migrations:run` is given. From code, it is `baseline(sql, {
dir, migration })`, on a client of its own, as `migrate()` is.

- **Name the last migration the database has.** Named too early, the next
  run fails on what the database has; too late, the run skips what it
  lacks.
- **Only a journal that records nothing takes a baseline.** A missing one is
  created. Once a migration is recorded, the journal says what the database
  has, and a baseline is refused with `recorded`. A run whose first
  migration failed leaves the journal empty; one that applied migrations
  before failing, or a baseline named wrong, leaves rows to delete before
  the next run: `delete from migrations`, or from the table `--table`
  names.
- **Each database built before the migrations takes one, once:**
  production, staging. A new database, for the tests or a new environment,
  runs every migration from the first, as the scratch database of
  `types:generate` does, so the first migration must build the schema on
  an empty database too.

The first migration of such a database is usually its schema as it is,
from `pg_dump --schema-only --no-owner --no-privileges`, trimmed to the
statements you would have written. A recent `pg_dump` puts `\restrict` and
`\unrestrict` lines around the dump: commands of `psql`, not SQL, so delete
them.
