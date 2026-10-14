---
title: Types from the database
description: What tetsu-sql types:generate writes, how each Postgres type reads and is written, and when a column is NULL.
sidebar:
  order: 3
---

```bash
bunx tetsu-sql types:generate
```

The command builds the migrations on a scratch database of the server
`DATABASE_URL` names, reads its catalog, and writes `src/db.generated.ts`:
the database the code is written against, as Postgres describes it. Then it
drops the scratch database, whether the migrations applied or failed. When
there is a `queries/` directory, it writes the functions of the [query
files](/docs/database/query-files/) as well, from the same database.

| flag | what it is |
| --- | --- |
| `--url` | the server, as a database of it: the scratch database is made next to it, and it is not touched. `DATABASE_URL` by default |
| `--dir` | the migrations, `migrations` by default |
| `--table` | the journal, `migrations` by default |
| `--out` | the file of types, `src/db.generated.ts` by default |
| `--queries`, `--queries-out` | the query files, `queries`, and their functions, `src/queries.generated.ts` |
| `--int8` | what an `int8` reads as: `bigint` by default, or `string`, as [int8 as a string](#int8-as-a-string) says |
| `--check` | write nothing, and fail when a file differs from what would be written in anything but its formatting |
| `--json` | print each line as a JSON object |

The user of the URL needs the right to create databases. What a migration
does to the whole server, such as a role it creates, stays on it after the
scratch database is gone, so build the types on a server of their own, such
as a container, and create roles only where they are missing:

```sql title="migrations/20261014122000_create_reader.sql"
do $$
begin
  if not exists (select from pg_roles where rolname = 'reader') then
    create role reader nologin;
  end if;
end
$$;
```

A scratch database is named `tetsu_sql_` and a UUIDv7. One that a killed run
left behind is dropped by the next run on the server, once it is an hour
old and nobody is on it.

## What the file holds

- **`DB`**, with a member for each table, view, materialized view and
  foreign table. A relation of the `public` schema is keyed by its name, one
  of another schema by `schema.name`, such as `"billing.invoices"`.
  Partitions are left out: their parent describes them.
- **A union for each enum,** such as `OrderStatus`, and for each list of
  values a check allows, such as `check (region in ('eu', 'us'))`.
- **`Constraint`**, the names of the constraints, which
  [`isViolation()`](/docs/database/transactions/#a-broken-constraint) takes.
- **`schema`**, for the runtime: the journal, the migration the types were
  built from, which [`verifySchema()`](/docs/database/deploy/#checking-the-database-at-start)
  checks the database against, what an `int8` reads as, and the columns of
  arrays, which `database()` writes arrays to.

A `comment on` a table or a column is its documentation in the file, and
shows where the editor shows the type.

The file is generated: change the migrations, never the file, and generate
it again. Commit it, and check it in CI, as [Deploy and
CI](/docs/database/deploy/#ci) shows. Leave the generated files out of the
linter and the formatter: they are laid out as Prettier, and Biome set to
spaces, lay out code by default, and `--check` compares their code, not
their layout.

## Columns

A column is typed as Bun reads its values, with `bigint: true`, or with
`bigint: false` for [`int8` read as a string](#int8-as-a-string), which is
how `database()` reads them. Three things can change what a type is
written as:

- **`Generated<T>`** — a column with a default, an identity `by default` or
  a serial: an insert may leave it out.
- **`GeneratedAlways<T>`** — an identity `always`, a generated column, or a
  column of a materialized view: it is never written.
- **`| null`** — a column without `not null`.

```ts twoslash
// @filename: src/db.generated.ts
export * from "@examples/sql/db.generated";
// @filename: src/orders.ts
import type { Kysely } from "kysely";
import type { DB } from "./db.generated";
declare const db: Kysely<DB>;
// @errors: 2353
// ---cut---
await db
  .insertInto("orders")
  .values({ customer_id: 1n, total: "12.50" })
  .execute();

await db
  .insertInto("orders")
  .values({ id: 7n, customer_id: 1n, total: "12.50" })
  .execute();
```

The first insert leaves `status`, `tags` and `placed_at` to their defaults,
and `note` NULL. The second writes `id`, which an identity `always` makes
Postgres's alone.

A column of a domain declared `not null` is not NULL, and one of a domain
with a default is `Generated`. Postgres does not hold a domain's `not null`
everywhere: the notes of [`create
domain`](https://www.postgresql.org/docs/current/sql-createdomain.html) show
how an outer join or a subquery can put a NULL in such a column.

Postgres cannot tell whether a column of a view or of a materialized view
holds NULL, and keeps no `not null` of a foreign table, so their columns are
`| null`. A query of a
view reads what it reads; a [query file](/docs/database/query-files/) that
reads a view types its columns the same way.

## How each type reads

| Postgres | read as | written as |
| --- | --- | --- |
| `bool` | `boolean` | |
| `int2`, `int4`, `oid`, `float4`, `float8` | `number` | |
| `int8` | `bigint`, or `string` with `--int8 string` | with `--int8 string`, a string, a number or a bigint |
| `numeric`, `money` | `string`, exact | |
| `text`, `varchar`, `char(n)`, `name`, `citext` | `string` | |
| `uuid` | `string` | |
| `json`, `jsonb` | `unknown`, as Postgres parsed it | an object or an array |
| `timestamp`, `timestamptz` | `Date` | a `Date` or a string Postgres reads |
| `date` | `Date`, at midnight UTC | a `Date`, its day in UTC, or a string such as `"2026-10-12"` |
| `time`, `timetz`, `interval` | `string` | |
| `bytea` | `Buffer` | any `Uint8Array` |
| an enum | the union of its labels | |
| a domain | its base type, narrowed by a list its checks allow | |
| `inet`, `cidr`, `macaddr`, geometric types, `bit`, `xml`, ranges, `tsvector`, a composite type | `string`, as Postgres writes it | |
| a type the generator does not know | `unknown` | |

A few values read as more than their type says:

- A `timestamp` is read as its time in UTC: Postgres keeps no zone with it.
- `'infinity'` and `'-infinity'` of a timestamp or a date are read as the
  numbers `Infinity` and `-Infinity`.
- A `float4` with parameters is read as its 32-bit value, such as
  `1.100000023841858` for `1.1`: [Bun's limits](/docs/database/bun-limits/).
- A string written to a `json` or `jsonb` column would be stored as a JSON
  string, so the column's type takes an object or an array: a value already
  passed through `JSON.stringify` does not compile.

## int8 as a string

An `int8` is read as a `bigint` by default: exact, and refused by
`JSON.stringify`, so an id goes out of a handler as a string, as [Ids in
JSON](/docs/database/recipes/#ids-in-json) shows. A project whose `int8`
columns are ids, and none of them amounts, can read them as strings
instead:

```bash
bunx tetsu-sql types:generate --int8 string
```

- **Every `int8` reads as a string:** a column, an element of an `int8[]`,
  a `count(*)` of a query file. JSON takes it as it is.
- **It is written as a string, a number or a bigint.** A number that is
  not whole is refused, as by any integer column. Kysely compares a column
  as it reads it, so `where("id", "=", "42")` takes a string.
- **`schema` records it,** and `database()` and `testDatabase()` read
  `int8` so: the types and the client cannot disagree. `--check` without
  the flag finds the file out of date.
- **Arithmetic on a string compiles:** `count + 1` is `"11"`. Cast in SQL,
  as `count(*)::int4`, or keep `bigint` where an `int8` holds amounts.

The choice is the project's, not a column's: Bun reads every `int8` one
way.

## Arrays

An array of a type Bun parses is `ArrayOfNullable<E>`: an array whose
elements may be NULL, as those of any Postgres array may.
`check (array_position(tags, null) is null)` keeps them out, and makes the
column `ArrayOf<E>`.

Bun reads an array of `uuid`, of an enum, of a domain, of a range, of a
composite type or of an extension's type as its Postgres literal, such as
`"{a,b}"`: such a column is `ArrayLiteral<E>`, read as that string and
written as an array.

An array of more dimensions is typed as an array of one: Postgres keeps no
number of dimensions with a column. Bun reads it as nested arrays — but
for an `int4[]` or a `float4[]` read with parameters, which fails: [Bun's
limits](/docs/database/bun-limits/) — so a query that reads one says what
it holds itself, as `` sql<string[][]>`cells` ``, and the package writes
nested arrays back as more dimensions.

An array is written to a column of arrays as the literal Postgres reads,
since Bun cannot bind it: [Queries](/docs/database/queries/#arrays) has
where that happens, and where it does not.

## More than one database

Each database has a file of its own, through `--out`, and its own
`database()`. The names of the constraints of every generated file in a
program are the names `isViolation()` takes, without clashing.
