---
title: Bun's limits
description: What Bun.SQL does not do yet, as of Bun 1.4.3, what the package does about each, and what is left to the application.
sidebar:
  order: 9
---

The package runs on Bun's own client, and leans on what it does. Where Bun
falls short, the package works around it, or the types say what Bun reads.
Where a row names an issue, the package's tests pin what Bun does today,
and fail once Bun fixes it, so that the workaround goes with the bug.

## Values

| Bun | the package | left to you |
| --- | --- | --- |
| cannot bind a JavaScript array to an array type ([#29551](https://github.com/oven-sh/bun/issues/29551)) | writes it as a Postgres literal where a query says it goes to a column of arrays, and to an array parameter of a query file | in raw SQL, or as the argument of another function, build the array in the query: [Arrays](/docs/database/queries/#arrays) |
| binds a `Date` to a `date` or a `time` wrongly ([#29010](https://github.com/oven-sh/bun/issues/29010)) | binds a `Date` as its ISO text, which a `date` and a timestamp read; types a `time` as a string | |
| reads an array of `uuid`, of an enum, of a domain, of a range, of a composite type or of an extension's type as its literal, such as `"{a,b}"` ([#41039](https://github.com/oven-sh/bun/issues/41039), [#41040](https://github.com/oven-sh/bun/issues/41040)) | types such a column `ArrayLiteral<E>`: read as that string, written as an array | parse the string where the elements are needed |
| reads an `int4[]` or a `float4[]` as an `Int32Array` or a `Float32Array` when a query has parameters | reads it as an array | |
| cannot read an `int4[]` or a `float4[]` that holds a NULL when a query has parameters, nor one of more dimensions ([#45062](https://github.com/oven-sh/bun/issues/45062)) | | keep NULLs out of the column with `check (array_position(scores, null) is null)`, which also types it without them, or read it as text: `scores::text` |
| reads a `float4` with parameters as its 32-bit value, such as `1.100000023841858` for `1.1` | | store what is compared or shown as `float8` or `numeric` |
| reads `'infinity'` and `'-infinity'` of a timestamp or a date as the numbers `Infinity` and `-Infinity` | says so in the generated types | check for a number where a column may hold them |
| stores a string bound to `json` or `jsonb` as a JSON string ([#28819](https://github.com/oven-sh/bun/issues/28819)) | types the column to take an object or an array, so a value passed through `JSON.stringify` does not compile | |

## The client

| Bun | the package | left to you |
| --- | --- | --- |
| before 1.4.3, could hand a query the rows of another after a failure on the same connection | `database()` throws on a Bun older than 1.4.3 | |
| takes `PGDATABASE`, when it is set, over the database a URL names | gives Bun the URL's database apart from the URL | give a client of your own its `database` too |
| connects without TLS when neither the URL nor `PGSSLMODE` names an `sslmode`, where Postgres's own clients try TLS first | | name the mode: [TLS](/docs/database/deploy/#tls) |
| hangs on `sslmode=prefer` against a server that offers no TLS | | use `require`, or `disable` |
| has no cursor | `stream()` throws, saying so | read a long result in pages, by key |
| hands a connection that comes free to a waiting reservation before any other query, so reservations beyond the pool's size hold every query up | lets reservations take turns at one fewer connection than `max` | |
| may wait forever to close a connection the server ended | supports `cancel query`, not `kill session` | |
| gives `error.column` as a number when Postgres names no column, as for a broken constraint ([#45064](https://github.com/oven-sh/bun/issues/45064)) | reads the constraint's name, in `isViolation()` | read `constraint` for a broken constraint |

When Bun fixes one of these, a release of the package drops the workaround
and says so in its notes.
