---
title: Validation
description: Any Standard Schema validates any part of a request; every part is checked at once, a failure answers 422 with every issue, and the response is checked on the way out.
sidebar:
  order: 6
---

A route validates a part of the request by declaring a schema for it. This
page covers the parts, what a failure looks like, why converting strings is
the schema's job, the validator libraries, and the check on what a route
sends back.

## Standard Schema

The framework talks to validators through
[Standard Schema](https://standardschema.dev) and nothing else: it imports
no validator library, and any schema that implements the interface
validates any part. Zod, Valibot and ArkType implement it themselves;
TypeBox does through `tb()` from
[`@tetsujs/typebox`](/docs/packages/typebox/).

Each part a schema covers is typed from the schema's output, so a value the
schema converts arrives converted:

```ts twoslash
import { controller, route } from "@tetsujs/core";
import { z } from "zod";

const NoteId = z.object({ id: z.coerce.number().int().positive() });
const NoteChange = z.object({ title: z.string().min(1).optional(), body: z.string().optional() });

export const notesController = controller("Notes", () => ({
  change: route({
    method: "PATCH",
    path: "/notes/:id",
    schema: { params: NoteId, body: NoteChange },
    handler: (ctx) => ({ id: ctx.params.id, ...ctx.body }),
    //                           ^?
  }),
}));
```

## The parts

| Part | Validates | Adds |
| --- | --- | --- |
| `params` | path parameters, as strings | `ctx.params`, narrowed |
| `query` | the query string: a record of strings, a repeated key as an array | `ctx.query` |
| `headers` | the request headers, names in lower case | `ctx.headers` |
| `cookies` | the cookies the request carries, signed ones already verified | `ctx.cookies` |
| `body` | the parsed body — see [Request bodies](/docs/concepts/request-bodies/) | `ctx.body` |
| `response` | what the handler returns | nothing — it checks what leaves |

A part without a schema is neither read nor typed. Without a `query`
schema the query string is not parsed at all, and `ctx.query` does not
exist; without a `headers` schema the headers are never copied into a
record; without a `body` schema — and without a `bodyType` or `rawBody` —
the body is never read. A route pays only for the parts it declares.
[Context](/docs/concepts/context/#no-schema-no-field) says why a missing
part is absent rather than `unknown`.

A schema validates what the context holds, not always the request itself:
a `beforeValidation` hook that normalizes `ctx.body` or `ctx.query` hands
the schema its own value. The schema's output then replaces it, and is what
the handler sees.

## Every part at once

The parts are checked in a fixed order — `params`, `query`, `headers`,
`cookies`, `body` — and their issues are collected, so a client sees
everything wrong with a request in one answer rather than one fix at a
time. A failure answers `422` before the handler runs, with the error
envelope and an `issues` list:

```json
{
  "status": 422,
  "message": "Validation failed",
  "error": "VALIDATION_FAILED",
  "issues": [
    { "message": "Invalid option: expected one of \"yes\"|\"no\"", "path": ["query", "draft"] },
    { "message": "Too small: expected string to have >=1 characters", "path": ["body", "title"] }
  ]
}
```

Each issue's `path` starts with the part it belongs to, then the keys
inside it; array indices stay numbers. The messages are the validator's
own, so they change with the library and its version: branch on `error` and
`path`, show `message` to people. To answer with another status, set
`validation: { status: 400 }` on `createApp` — `400` and `422` are the two
it takes. A body that is not valid JSON is a `400` either way, before any
schema sees it.

An application `onError` hook can replace the envelope entirely — a
`ValidationError` carries its `issues` — as
[Errors](/docs/concepts/errors/) shows.

## Converting is the schema's job

A path parameter, a query value, a header, a cookie and a form field all
arrive as strings. The framework does not guess which of them were meant
as numbers or booleans: the schema converts them, and says so where the
route is declared. With Zod that is `z.coerce`:

```ts twoslash
import { z } from "zod";
// ---cut---
const Page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
```

An array needs the same care. A key sent once is a string, and only a
repeated key becomes an array: `?tag=a` is `"a"`, and `?tag=a&tag=b` is
`["a", "b"]`. A plain `z.array()` refuses a single tag with `422` — which
a test that sends two does not notice — so the schema wraps one value in
an array itself:

```ts twoslash
import { z } from "zod";
// ---cut---
const one = (value: unknown) => (typeof value === "string" ? [value] : value);

const Filter = z.object({
  tag: z.preprocess(one, z.array(z.string())).optional(),
});
```

A form body follows the same rule: a field sent once is a value, a
repeated field an array. With TypeBox, `tb(…, { convert: true })` does both
conversions — `"42"` to `42`, and a single `"a"` to `["a"]`.

## Validator libraries

The same route with each of the four. Only the schema changes; the route
and the handler's types follow it:

```ts twoslash
import { route } from "@tetsujs/core";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";
import { Type, tb } from "@tetsujs/typebox";

const WithZod = z.object({ title: z.string().min(1), pinned: z.boolean() });

const WithValibot = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  pinned: v.boolean(),
});

const WithArkType = type({ title: "string > 0", pinned: "boolean" });

const WithTypeBox = tb(Type.Object({ title: Type.String({ minLength: 1 }), pinned: Type.Boolean() }));

route({
  method: "POST",
  path: "/notes",
  schema: { body: WithTypeBox },
  handler: (ctx) => ctx.body,
  //                    ^?
});
```

TypeBox has no Standard Schema of its own, so `tb()` wraps a TypeBox
schema in one and compiles its check once, when `tb()` runs; its options
— `convert`, `clean`, `defaults` — are on the
[package page](/docs/packages/typebox/). A schema that should also appear
in the OpenAPI document must emit JSON Schema: Zod, ArkType and `tb()` do
it themselves, and Valibot through `toStandardJsonSchema` from
`@valibot/to-json-schema`. See [`@tetsujs/openapi`](/docs/packages/openapi/).

A validator that checks asynchronously works too. The request waits for it
and the parts are still reported in order.

## Checking the response

`schema.response` checks what the handler returns, at compile time and at
runtime. At compile time the handler must return the declared shape. At
runtime the value the schema returns is what gets serialized — so a schema
that strips unknown keys keeps a field like `passwordHash` out of the JSON,
which structural typing cannot do: a handler returning
`User & { passwordHash }` satisfies the type `User`.

```ts twoslash
interface UserRow { id: string; name: string; passwordHash: string }
declare const users: { find(id: string): UserRow };
// ---cut---
import { route } from "@tetsujs/core";
import { z } from "zod";

const PublicUser = z.object({ id: z.string(), name: z.string() });

route({
  method: "GET",
  path: "/users/:id",
  schema: { response: PublicUser },
  handler: (ctx) => users.find(ctx.params.id),
});
```

A response that fails its schema is the server's fault, not the client's:
it answers `500` without leaking the value, and the failure goes to
`reportError`. A `Response` the handler builds itself is never checked —
the framework does not inspect a response it did not build.

A single schema checks every response of the route. A response map binds
a schema to each status instead — `{ 201: Note, 409: Conflict }` — and is
also the list of statuses the route may answer with, with `null` for a
status without a body and entries for headers and cookies.
[Responses](/docs/concepts/responses/) covers the map in full.

`validateResponses: false` on `createApp` turns the runtime check off. The
schema keeps working at the other two levels: it still checks the
handler's return type at compile time, and still documents the response.
The framework never reads `NODE_ENV`; checking responses outside
production only is a decision for the composition root:

```ts twoslash
declare const routes: object;
// ---cut---
import { createApp } from "@tetsujs/core";

createApp({ routes, validateResponses: Bun.env.NODE_ENV !== "production" });
```
