---
title: "@tetsujs/typebox"
description: TypeBox schemas as DTOs — compiled validation, full type inference, file uploads, and the same schema in the OpenAPI document.
sidebar:
  order: 3
  label: "@tetsujs/typebox"
---

`@tetsujs/typebox` turns a [TypeBox](https://github.com/sinclairzx81/typebox)
schema into a DTO you can use in any part of a route's `schema`. Validation
is compiled, types are inferred, and the same schema goes into the OpenAPI
document. See [Validation](/docs/concepts/validation/) for how schemas are
used in a route.

```bash
bun add typebox @tetsujs/typebox
```

`typebox` is a peer dependency, version 1.3.34 or later, so the application
picks the version and has one copy of it.

## Usage

Wrap a TypeBox schema with `tb()` and use it in a route's `schema`:

```ts twoslash
import { controller, route } from "@tetsujs/core";

declare const users: {
  update(id: number, user: { name: string; email: string }): { id: number };
};
// ---cut---
import { tb, Type } from "@tetsujs/typebox";

export const CreateUser = tb(
  Type.Object({
    name: Type.String({ minLength: 1 }),
    email: Type.String({ format: "email" }),
  }),
);

export const UserParams = tb(Type.Object({ id: Type.Integer() }), { convert: true });

export const usersController = controller("Users", () => ({
  update: route({
    method: "PUT",
    path: "/users/:id",
    schema: { params: UserParams, body: CreateUser },
    handler: (ctx) => users.update(ctx.params.id, ctx.body),
    //                                        ^? number
  }),
}));
```

`tb()` compiles the schema once, and every request runs the compiled check.
`Type` is TypeBox's own, re-exported, so TypeBox's documentation applies.
The types `Static`, `StaticDecode` and `TSchema` are re-exported too. What
`tb()` returns is still a plain JSON Schema object: it serializes cleanly
and nests into other TypeBox schemas.

## Options

| Option | Effect | Use for |
| --- | --- | --- |
| `convert` | converts before checking: `"42"` becomes `42`, a single `"a"` becomes `["a"]` | `params`, `query`, `headers` and form fields, which arrive as strings |
| `clean` | drops properties the schema does not declare | `response` DTOs, so undeclared fields do not leak |
| `defaults` | fills in a declared `default` when a value is missing | optional query parameters, configuration |
| `issues` | `"detailed"` (default) or `"summary"` | `"summary"` reports a single issue with no path, much cheaper on large bodies |
| `vendor` | the vendor name reported through Standard Schema | custom tooling |

All are off by default. None of them changes the value passed in: they work
on a copy, so `clean` on a response never deletes fields from the object the
handler returned.

`convert` is never implicit. A JSON body that sends `"42"` for a number is
refused.

`defaults` runs before the check, so a filled-in default is checked like any
other value. In the OpenAPI document, a property with a `default` is optional
on input and required on output.

`issues: "summary"` returns one issue, `does not match the schema`, with no
path. Finding where a value failed is TypeBox's slow path, and its cost grows
with the valid data before the failure. Use `"summary"` on large bodies on
public endpoints, where a bad payload only needs a `422`.

Wrapping a DTO again replaces its options.
`tb(CreateOrder, { issues: "summary" })` has no `convert`, even if
`CreateOrder` had it.

### Nested DTOs

A DTO nested in another is checked with the outer DTO's options, not its
own. If the nested one has an option the outer one lacks, `tb()` throws,
because a `clean` that no longer strips would leak fields:

```ts twoslash
import { tb, Type } from "@tetsujs/typebox";
// ---cut---
const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });

tb(Type.Object({ users: Type.Array(PublicUser) }));
// throws: the nested DTO asks for clean, which the outer one does not have

const Users = tb(Type.Object({ users: Type.Array(PublicUser) }), { clean: true });
// strips every user
```

A schema derived from a DTO, with `Type.Pick`, `Type.Omit` or
`Type.Partial`, is a new schema with none of the DTO's options. Pass the
options it needs to its own `tb()`.

## Files

`file()` and `files()` validate uploads in a `bodyType: "form"` body. See
[Request bodies](/docs/concepts/request-bodies/) for how uploads are read.

```ts twoslash
import { controller, route } from "@tetsujs/core";

declare function store(title: string, avatar: File, gallery: File[]): { id: string };
// ---cut---
import { file, files, tb, Type } from "@tetsujs/typebox";

const Upload = tb(
  Type.Object({
    title: Type.String({ minLength: 1 }),
    avatar: file({ maxSize: "5m", type: "image" }),
    gallery: files({ maxSize: "1m" }),
  }),
);

export const uploads = controller("Uploads", () => ({
  create: route({
    method: "POST",
    path: "/uploads",
    bodyType: "form",
    schema: { body: Upload },
    handler: (ctx) => store(ctx.body.title, ctx.body.avatar, ctx.body.gallery),
    //                                               ^? File
  }),
}));
```

| Option | Accepts | Checks |
| --- | --- | --- |
| `maxSize` | `5242880`, `"512k"`, `"5m"` | the largest file size |
| `minSize` | the same | the smallest; `1` rejects an empty file |
| `type` | `"image"`, `"image/png"`, `["image", "application/pdf"]` | the MIME type the client declared, not the bytes; `"image"` matches every image type |

A size is a number of bytes, or a number with `k` (KiB) or `m` (MiB).

`files()` gives an array whenever the field is there, even for a single
file. A file input left empty is absent from the body, so wrap an optional
one in `Type.Optional`: an absent `files()` field is `undefined`, not `[]`,
and the handler reads `ctx.body.gallery ?? []`.

These checks run after the body is read. The limit on how much is read at
all is `maxBodySize` on the application, and it counts the multipart framing
too. In the OpenAPI document a file is a binary string with its size limits
and media type.

## Error messages

Set your own message with `errorMessage`: one string for any failure, or one
per keyword:

```ts twoslash
import { tb, Type } from "@tetsujs/typebox";
// ---cut---
const CreateUser = tb(
  Type.Object({
    email: Type.String({
      format: "email",
      errorMessage: { format: "Not an email address", required: "Email is required" },
    }),
    password: Type.String({ minLength: 8, errorMessage: "At least 8 characters" }),
  }),
);
```

`errorMessage` is left out of the JSON Schema and the OpenAPI document. For
several languages, keep schemas without messages and translate in an
`onError` hook, by each issue's path. See [Errors](/docs/concepts/errors/).

Each issue points at the field itself: a missing `password` is reported at
`["body", "password"]`, not at `body`. A union of literals fails with one
issue that lists the allowed values.

## Codecs

A `Type.Codec` is validated as it arrives and handed to the handler
decoded. The validated type is the decoded one:

```ts twoslash
import { parse, tb, Type } from "@tetsujs/typebox";

declare const redis: { hgetall(key: string): Promise<Record<string, string>> };
declare const key: string;
// ---cut---
const Instant = Type.Codec(Type.String({ format: "date-time" }))
  .Decode((value) => new Date(value))
  .Encode((value: Date) => value.toISOString());

const Stored = tb(Type.Object({ code: Type.String(), expiresAt: Instant }));

const session = parse(Stored, await redis.hgetall(key));
//    ^? { code: string; expiresAt: Date; }
```

If `Decode` throws, the value fails with a `422` carrying the error's
message, not a `500`. Throw a message meant for the client.

## Validating outside a request

`parse()` validates a value and returns it, or throws a `ValidationError`
with every issue. It is synchronous, so it works at module level, for
example for the environment:

```ts twoslash
import { parse, tb, Type } from "@tetsujs/typebox";
// ---cut---
const Env = tb(
  Type.Object({
    PORT: Type.Integer({ minimum: 1, maximum: 65_535, default: 3000 }),
    DATABASE_URL: Type.String({ format: "uri" }),
  }),
  { convert: true, defaults: true, clean: true },
);

export const env = parse(Env, Bun.env);
```

Inside a handler, a thrown `ValidationError` becomes the same `422` a
rejected request gets. At startup, catch it, print `error.issues` and exit.

## OpenAPI

A TypeBox schema is JSON Schema 2020-12, which OpenAPI 3.1 uses as is, so
[`@tetsujs/openapi`](/docs/packages/openapi/) needs no converter. Only the
targets `draft-2020-12` and `openapi-3.1` are supported, exported as
`supportedTargets`. Asking for an older dialect throws.

## Performance

TypeBox compiles each schema into a checking function, so valid bodies are
checked several times faster than with other Standard Schema libraries, and
the gap grows with the body. Describing a failure in detail is its slow
path, which `issues: "summary"` avoids, and importing it costs more memory
than Zod or Valibot. TypeBox suits large bodies, mostly valid traffic and
schemas that double as documentation; a lighter library suits cases where
memory and startup matter more. [Performance](/docs/more/performance/#validation)
has the numbers.
