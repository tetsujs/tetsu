---
title: "@tetsujs/sql"
description: Postgres on Bun's own client — SQL migrations, Kysely types generated from the database they build, and SQL files typed by Postgres itself.
sidebar:
  order: 12
  label: "@tetsujs/sql"
---

`@tetsujs/sql` puts Postgres behind an application on Tetsu. SQL migrations
are the schema, the types are generated from the database they build, and
queries are Kysely's, or SQL files typed by Postgres itself. It has a
section of its own: [Database](/docs/database/).

```bash
bun add @tetsujs/sql kysely
```

It needs Bun 1.4.3 or later and Postgres 14 or later. `kysely` is a peer
dependency, 0.29.6 or a later 0.29.

## Usage

```ts twoslash title="src/db.ts"
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/db.ts
declare const config: { DATABASE_URL: string };
// ---cut---
import { database, verifySchema } from "@tetsujs/sql";
import { schema } from "./db.generated";

export const db = database(schema, { url: config.DATABASE_URL });

await verifySchema(db, schema);

const paid = await db
  .selectFrom("orders")
  .select(["id", "total", "placed_at"])
  .where("status", "=", "paid")
  .execute();
```

`src/db.generated.ts` is what `tetsu-sql types:generate` writes from the
migrations: [Overview](/docs/database/) walks from the first migration to a
route, and [Types from the database](/docs/database/types/) says what each
column becomes.

## The command line

`tetsu-sql` runs the package's functions from `package.json` scripts, with
the database in `DATABASE_URL` or `--url`:

| command | what it does |
| --- | --- |
| `migrations:new <name>` | creates an empty migration, named with the current UTC time |
| `migrations:run` | applies the pending migrations: [Migrations](/docs/database/migrations/) |
| `types:generate` | writes the types of the database the migrations build, and the functions of the query files; `--check` writes nothing and fails when the files are out of date: [Types from the database](/docs/database/types/) |

## Exports

- `database`, with `DatabaseOptions`.
- `migrate`, with `MigrateOptions`, `MigrateResult` and `MigrationRecord`;
  `MigrationError`, with `MigrationErrorReason`.
- `verifySchema`.
- `atomic`.
- `isViolation`, with `ConstraintName` and `Constraints`, which the
  generated files add the names of their constraints to.
- `queryRows` and `queryCount`, with `FileQuery`: what the functions of
  query files call.
- `Schema`, the type of a generated `schema`.
- From `@tetsujs/sql/generate`: `generate`, with `GenerateOptions`,
  `QueriesOptions` and `GeneratedFiles`; `createMigration`, with
  `CreateMigrationOptions`; and `QueryFileError`.
- From `@tetsujs/sql/testing`: `testDatabase`, with `TestDatabaseOptions`
  and `TestDatabase`.
