---
title: Bun's limits
description: What Bun.SQL does not do yet, as of Bun 1.4.4, what the package does about each, and what is left to the application.
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
| reads an array of an enum, of a domain, of a composite type, of a range or a multirange of one's own or of an extension's type as its literal, such as `"{a,b}"` ([#41040](https://github.com/oven-sh/bun/issues/41040)) | types such a column `ArrayLiteral<E>`: read as that string, written as an array | parse the string where the elements are needed |
| binds a JavaScript array to an array of an enum, of a domain, of a composite type, of a range or a multirange of one's own or of an extension's type as its elements joined by commas, which Postgres refuses | writes an array to a column of arrays, and to a parameter of a query file, as the literal Postgres reads | in raw SQL, cast the array to one of a built-in type first: `${moods}::text[]::mood[]` |
| binds a JavaScript array to a `json[]` or a `jsonb[]` with `null` as JSON's `null`, and an array element as an array of more dimensions | writes the JSON of each element, and `null` as NULL | |
| binds `-0` in a JavaScript array as `0` | writes it as `-0` | |
| binds a `Date` of a year past 9999 or before 1 as `toISOString()` writes it, such as `+010000-01-01`, which a `date` and an array of dates or timestamps refuse | writes a `Date` as its ISO text, which a `date` reads of any year | |
| binds an invalid `Date` as the text `Invalid Date`, which Postgres refuses | throws a `RangeError` before anything is sent | |
| reads an `int4[]` or a `float4[]` as an `Int32Array` or a `Float32Array` when a query has parameters | reads it as an array | |
| reads a `float4` with parameters as its 32-bit value, such as `1.100000023841858` for `1.1` | | store what is compared or shown as `float8` or `numeric` |
| reads `'infinity'` and `'-infinity'` of a timestamp or a date as the numbers `Infinity` and `-Infinity` | says so in the generated types | check for a number where a column may hold them |
| stores a string bound to `json` or `jsonb` as a JSON string ([#28819](https://github.com/oven-sh/bun/issues/28819)) | types the column to take an object or an array, so a value passed through `JSON.stringify` does not compile | |

## The client

| Bun | the package | left to you |
| --- | --- | --- |
| before 1.4.4, read an array of `uuid`, of a range and of more types as its literal; before 1.4.3, could hand a query the rows of another after a failure on the same connection | `database()` throws on a Bun older than 1.4.4 | |
| takes `PGDATABASE`, when it is set, over the database a URL names ([#45276](https://github.com/oven-sh/bun/issues/45276)) | gives Bun the URL's database apart from the URL | give a client of your own its `database` too |
| connects without TLS when neither the URL nor `PGSSLMODE` names an `sslmode`, where Postgres's own clients try TLS first | | name the mode: [TLS](/docs/database/deploy/#tls) |
| has no cursor | `stream()` throws, saying so | read a long result in pages, by key |
| cannot describe a query without running it ([#45277](https://github.com/oven-sh/bun/issues/45277)) | describes query files over a connection of its own, by host and port, with TLS as `sslmode` says | give `types:generate` a URL with a host and a port, not a [unix socket](/docs/database/deploy/#a-unix-socket), and an authority of your own in [`NODE_EXTRA_CA_CERTS`](/docs/database/deploy/#tls) |
| has `query.cancel()` cancel a query already sent on the server, where Kysely's default `ignore query` lets one run to its end | cancels on abort only a query Bun has not sent yet, and leaves the server's cancel to `cancel query` | |
| may wait forever to close a connection the server ended | supports `cancel query`, not `kill session` | |

When Bun fixes one of these, a release of the package drops the workaround
and says so in its notes.
