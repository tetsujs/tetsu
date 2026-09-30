---
title: "@tetsujs/typebox"
description: TypeBox schemas as DTOs — compiled validation, full type inference, file uploads, and the same schema in the OpenAPI document.
sidebar:
  order: 3
  label: "@tetsujs/typebox"
---

`@tetsujs/typebox` turns a [TypeBox](https://github.com/sinclairzx81/typebox)
schema into a DTO the framework accepts in any part of a route's `schema`. It
keeps TypeBox's compiled validation, infers the types, and emits the same
schema into the OpenAPI document. TypeBox is one of the libraries Tetsu
validates with through Standard Schema; see [Validation](/docs/concepts/validation/)
for how a schema is used in a route.

```bash
bun add typebox @tetsujs/typebox
```

`typebox` is a peer dependency, so the application picks its version (1.3.34 or
later), and there is one copy of it.

## Usage

Wrap a TypeBox schema with `tb()` where the DTO is declared, and use it in any
part of a route's `schema`:

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

The schema is compiled once, when `tb()` runs, and every request uses the
compiled check. `Type` is TypeBox's own, re-exported, so TypeBox's documentation
applies as it is. The package also re-exports the types `Static`, `StaticDecode`
and `TSchema`. The value `tb()` returns is still a plain JSON Schema object: it
serializes clean, nests into other TypeBox schemas and feeds OpenAPI as it is,
and the validator is attached as a non-enumerable property.

The validated type is the decoded one. For a plain schema that is the schema's
own type, and for one built with `Type.Codec` it is what the codec produces.

## Options

| Option | Effect | Use for |
| --- | --- | --- |
| `convert` | converts before checking: `"42"` becomes `42`, a single `"a"` becomes `["a"]` | `params`, `query`, `headers` and form fields, which arrive as strings |
| `clean` | drops properties the schema does not declare | `response` DTOs, so nothing undeclared leaks |
| `defaults` | fills in a declared `default` when a value is missing | queries with optional parameters, configuration |
| `issues` | `"detailed"` (default) or `"summary"` | `"summary"` gives one issue per failed value, much cheaper on large bodies |
| `vendor` | the vendor name reported to the core | custom tooling |

All are off by default, and none of them modifies the value it was given: a
schema that converts, cleans or fills defaults works on a copy. On a `response`
schema that matters, since the value is the object the handler returned, and
`clean` on it would otherwise delete the undeclared fields from a cached entity
or a store record.

`convert` is never implicit. Path parameters, query strings and headers always
arrive as strings, so they need it; a body does not, and a body that sends
`"42"` for a number is refused.

`defaults` runs before coercion, so a default is checked exactly like a value
that arrived. It also changes what the schema says: a property with a `default`
is documented as optional on input, since the client does not have to send it,
and as required on output, since the value is there by the time the response is
built.

`issues: "summary"` reports one issue for the whole value, with no path, and
never walks the value to say where it went wrong. The compiled check says
invalid in nanoseconds; saying where is TypeBox's own error walk, which costs in
proportion to how much valid data lies before the failure. Use it on a large body
on an endpoint open to anyone, where the sender of a malformed payload is owed a
`422` and nothing more.

Wrapping a DTO again replaces its options rather than adding to them:
`tb(CreateOrder, { convert: true, issues: "summary" })` keeps `convert` only
because it says so.

### Nested DTOs

A DTO nested in another is checked with the options of the outer one, not its
own. A nested DTO declared with an option the outer one does not have is refused
where the outer one is made, since a `clean` that no longer strips is a field
leaking out of a response:

```ts twoslash
import { tb, Type } from "@tetsujs/typebox";
// ---cut---
const PublicUser = tb(Type.Object({ id: Type.String() }), { clean: true });

tb(Type.Object({ users: Type.Array(PublicUser) }));
// throws: the nested DTO asks for clean, which the outer one does not have

const Users = tb(Type.Object({ users: Type.Array(PublicUser) }), { clean: true });
// strips every user
```

A schema derived from a DTO, such as `Type.Pick(PublicUser, ["id"])`,
`Type.Omit` or `Type.Partial`, is a new schema and carries none of the DTO's
options. Give the `tb()` around it the options it needs.

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
| `minSize` | the same | the smallest; `1` rejects a file with nothing in it |
| `type` | `"image"`, `"image/png"`, `["image", "application/pdf"]` | the MIME type the client declared, not the bytes; `"image"` matches every image type |

A size is a number of bytes, or a number with the suffix `k` (KiB) or `m` (MiB).

`files()` gives an array whenever the field is there, even for a single file. A
file input nothing was chosen in is left out of the body, so under
`Type.Optional` an untouched one is absent: `file()` is `undefined` rather than
refused for its type, and `files()` is `undefined` rather than `[]`, so the
handler reads `ctx.body.gallery ?? []`, as the type already asks.

These checks run after the body was read, so they are a contract and not a
defence. The limit on what is read at all is `maxBodySize` on the application,
and it counts the multipart framing too, which is larger than it looks. In the
OpenAPI document a file is described as a binary string, with its size limits
and media type.

## Error messages

Set your own message on a schema with `errorMessage`: one string for any
failure, or one per keyword:

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

`errorMessage` is not included in the JSON Schema or the OpenAPI document. For
several languages, keep schemas without messages and translate in an `onError`
hook, keyed by each issue's path. See [Errors](/docs/concepts/errors/).

Every issue points at the field itself: a missing `password` is reported at
`["body", "password"]`, not at `body`. A union of literals fails with one issue
listing the allowed values. With `issues: "summary"`, the one issue says `does
not match the schema`.

## Codecs

A `Type.Codec` is validated as it arrives and handed over decoded:

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

A `Decode` that throws fails the value, as the check does: a `422`, with the
error's message, rather than a `500` any client could cause with a string
`BigInt` cannot read. Throw a message meant for the client.

## Validating outside a request

`parse()` validates any value and returns it, or throws a `ValidationError` with
every issue. It is synchronous, so it works at module level, for example for the
environment:

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

Inside a handler, a thrown `ValidationError` becomes the same `422` a rejected
request gets. At startup, catch it to print the issues and exit:

```ts twoslash
import { parse, tb, Type } from "@tetsujs/typebox";
import { ValidationError } from "@tetsujs/core";

const Env = tb(Type.Object({ PORT: Type.Integer() }), { convert: true });
// ---cut---
try {
  parse(Env, Bun.env);
} catch (error) {
  if (error instanceof ValidationError) {
    for (const issue of error.issues) {
      console.error(`${issue.path.join(".")}: ${issue.message}`);
    }

    process.exit(1);
  }

  throw error;
}
```

## OpenAPI and dialects

OpenAPI 3.1 and JSON Schema 2020-12 are emitted as they are. A schema is
described through Standard Schema's JSON Schema support, so a TypeBox DTO needs
no converter in [`@tetsujs/openapi`](/docs/packages/openapi/). Older dialects
throw rather than being converted approximately: a request for any target other
than `draft-2020-12` or `openapi-3.1` fails with a message naming the two. The
supported targets are exported as `supportedTargets`.

## Performance

TypeBox compiles each schema into a checking function, so valid bodies are
checked several times faster than with other Standard Schema libraries, and the
bigger the body, the bigger the gain. From `bun run --cwd bench validators`, in
nanoseconds per check:

| | Zod 4.6 | ArkType 2.2 | Valibot 1.5 | TypeBox via `tb()` |
| --- | --- | --- | --- | --- |
| small body, valid | 23 | 24 | 21 | **6.7** |
| 20-item body, valid | 922 | 168 | 784 | **52** |
| 20-item body, one item invalid | 1,020 | 3,260 | 936 | 21,090 |
| memory to import | +21 MB | +57 MB | +3 MB | +36 MB |

Describing a failure in detail is TypeBox's slow path; `issues: "summary"`
answers the invalid body above in 76 ns. TypeBox fits large bodies, mostly valid
traffic and schemas that double as documentation. A lighter library fits when
memory and startup matter more. See [Performance](/docs/more/performance/).
