---
title: Validation
description: Any Standard Schema validates any part of a request; a failure answers 422 with every issue, and the response is checked on the way out.
sidebar:
  order: 6
---

A route validates a part of the request by declaring a schema for it. The
handler then gets that part typed from the schema's output.

## Declaring schemas

Any [Standard Schema](https://standardschema.dev) works. Zod, Valibot and
ArkType support it directly, and TypeBox does through `tb()` from
[`@tetsujs/typebox`](/docs/packages/typebox/).

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

A value the schema converts arrives converted: `ctx.params.id` is a
number here.

## The parts

| Part | Validates | Adds |
| --- | --- | --- |
| `params` | path parameters, as strings | `ctx.params`, narrowed |
| `query` | the query string: a record of strings, a repeated key as an array | `ctx.query` |
| `headers` | the request headers, names in lower case | `ctx.headers` |
| `cookies` | the request's cookies, signed ones already verified | `ctx.cookies` |
| `body` | the parsed body — see [Request bodies](/docs/concepts/request-bodies/) | `ctx.body` |
| `response` | what the handler returns | nothing; it checks what leaves |

A part without a schema is neither read nor typed. Without a `query`
schema the query string is not parsed and `ctx.query` does not exist.
Without a `body` schema, `bodyType` or `rawBody`, the body is never read.
[Context](/docs/concepts/context/#no-schema-no-field) explains why.

If a `beforeValidation` hook changes `ctx.body` or `ctx.query`, the schema
validates the hook's value.

## Validation errors

All parts are checked, in the order `params`, `query`, `headers`,
`cookies`, `body`, and their issues are collected. The client sees
everything wrong with a request in one answer. A failure answers `422`
before the handler runs:

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

Each issue's `path` starts with the part, then the keys inside it. The
messages come from the validator and change with its version, so branch
on `error` and `path`, and show `message` to people.

To answer `400` instead, set `validation: { status: 400 }` on `createApp`.
A body that is not valid JSON is always a `400`. To change the format of
the answer, use an application `onError` hook; see
[Errors](/docs/concepts/errors/).

## Converting strings

Path parameters, query values, headers, cookies and form fields all arrive
as strings. The framework does not guess types; the schema converts them.
With Zod, use `z.coerce`:

```ts twoslash
import { z } from "zod";
// ---cut---
const Page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
```

Arrays need the same care. A key sent once is a string, and only a
repeated key becomes an array: `?tag=a` is `"a"`, and `?tag=a&tag=b` is
`["a", "b"]`. A plain `z.array()` refuses a single tag, so wrap a single
value in an array first:

```ts twoslash
import { z } from "zod";
// ---cut---
const one = (value: unknown) => (typeof value === "string" ? [value] : value);

const Filter = z.object({
  tag: z.preprocess(one, z.array(z.string())).optional(),
});
```

Form fields work the same way. With TypeBox, `tb(…, { convert: true })`
does both conversions: `"42"` to `42`, and `"a"` to `["a"]`.

## Validator libraries

Only the schema changes between libraries; the route and the handler's
types follow it:

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

`tb()` options such as `convert`, `clean` and `defaults` are on the
[package page](/docs/packages/typebox/). For a schema to appear in the
OpenAPI document it must also produce JSON Schema. Zod, ArkType and
`tb()` do this themselves; Valibot needs `toStandardJsonSchema` from
`@valibot/to-json-schema`. See [`@tetsujs/openapi`](/docs/packages/openapi/).

Asynchronous validators work too.

## Checking the response

`schema.response` checks what the handler returns, at compile time and at
runtime, and the schema's output is what gets sent: a schema that strips
unknown keys keeps a field like `passwordHash` out of the response. A
response that fails its schema is a `500`, reported to `reportError`.
[Responses](/docs/concepts/responses/#the-response-map) covers a schema per
status, what is serialized, and turning the runtime check off with
`validateResponses: false`.
