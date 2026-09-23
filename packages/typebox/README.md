# @tetsujs/typebox

TypeBox schemas as DTOs: compiled validation, full type inference, and the
same schema in the OpenAPI document.

```bash
bun add typebox @tetsujs/typebox
```

## Usage

Wrap a TypeBox schema with `tb()` where the DTO is declared, and use it in
any part of a route's `schema`:

```ts
import { tb, Type } from "@tetsujs/typebox";

export const CreateUser = tb(
  Type.Object({
    name: Type.String({ minLength: 1 }),
    email: Type.String({ format: "email" }),
  }),
);

export const UserParams = tb(Type.Object({ id: Type.Integer() }), { convert: true });

update = route({
  method: "PUT",
  path: "/users/:id",
  schema: { params: UserParams, body: CreateUser },
  handler: (ctx) => this.users.update(ctx.params.id, ctx.body),
  //                                   ^? number     ^? { name: string; email: string }
});
```

The schema is compiled once, when `tb()` runs, and every request uses the
compiled check. `Type` is TypeBox's own, re-exported, so TypeBox's
documentation applies as it is; `typebox` stays a peer dependency, so the
application picks its version.

## Options

| Option | Effect | Use for |
| --- | --- | --- |
| `convert` | converts before checking: `"42"` → `42` | `params`, `query`, `headers`, which arrive as strings |
| `clean` | drops properties the schema does not declare | `response` DTOs, so nothing undeclared leaks |
| `defaults` | fills in a declared `default` when a value is missing | queries with optional parameters, configuration |
| `issues` | `"detailed"` (default) or `"summary"` | `"summary"` gives one issue per failed value — much cheaper on large bodies |
| `vendor` | the vendor name reported to the core | custom tooling |

All are off by default, and none of them modifies the value it was given.
Wrapping a DTO again replaces its options rather than adding to them:
`tb(CreateOrder, { convert: true, issues: "summary" })` keeps `convert`
only because it says so.

A property with a `default` and `defaults: true` is documented as optional
on input, since the client does not have to send it.

## Files

`file()` and `files()` validate uploads in a `bodyType: "form"` body:

```ts
import { file, files, tb, Type } from "@tetsujs/typebox";

const Upload = tb(
  Type.Object({
    title: Type.String({ minLength: 1 }),
    avatar: file({ maxSize: "5m", type: "image" }),
    gallery: files({ maxSize: "1m" }),
  }),
);

route({
  method: "POST",
  path: "/uploads",
  bodyType: "form",
  schema: { body: Upload },
  handler: (ctx) => store(ctx.body.title, ctx.body.avatar, ctx.body.gallery),
  //                                      ^? File          ^? File[]
});
```

| Option | Accepts | Checks |
| --- | --- | --- |
| `maxSize` | `5242880`, `"512k"`, `"5m"` | the largest file size |
| `minSize` | the same | the smallest — `1` rejects the empty part an untouched input sends |
| `type` | `"image"`, `"image/png"`, `["image", "application/pdf"]` | the MIME type; `"image"` matches every image type |

`files()` always gives an array, even for a single file. These checks run
after the body was read; the limit on what is read at all is `maxBodySize`,
and it counts the multipart framing too, which is larger than it looks.

## Error messages

Set your own message on a schema with `errorMessage` — one string for any
failure, or one per keyword:

```ts
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

`errorMessage` is not included in the JSON Schema or the OpenAPI document.
For several languages, keep schemas without messages and translate in an
`onError` hook, keyed by each issue's path.

Every issue points at the field itself — a missing `password` is reported
at `["body", "password"]`, not at `body` — and a union of literals fails
with one issue listing the allowed values.

## Codecs

A `Type.Codec` is validated as it arrives and handed over decoded:

```ts
const Instant = Type.Codec(Type.String({ format: "date-time" }))
  .Decode((value) => new Date(value))
  .Encode((value: Date) => value.toISOString());

const Stored = tb(Type.Object({ code: Type.String(), expiresAt: Instant }));

parse(Stored, await redis.hgetall(key)); // { code: string; expiresAt: Date }
```

## Validating outside a request

`parse()` validates any value and returns it, or throws a
`ValidationError` with every issue. It is synchronous, so it works at
module level — for example, for the environment:

```ts
import { parse, tb, Type } from "@tetsujs/typebox";

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
rejected request gets.

## Performance

TypeBox compiles each schema into a checking function, so valid bodies are
checked several times faster than with other Standard Schema libraries —
the bigger the body, the bigger the gain. From
`bun run --cwd bench validators`, in nanoseconds per check:

| | Zod 4.6 | ArkType 2.2 | Valibot 1.5 | TypeBox via `tb()` |
| --- | --- | --- | --- | --- |
| small body, valid | 23 | 24 | 21 | **6.7** |
| 20-item body, valid | 922 | 168 | 784 | **52** |
| 20-item body, one item invalid | 1,020 | 3,260 | 936 | 21,090 |
| memory to import | +21 MB | +57 MB | +3 MB | +36 MB |

Describing a failure in detail is TypeBox's slow path; `issues: "summary"`
answers the invalid body above in 76 ns. TypeBox fits large bodies, mostly
valid traffic and schemas that double as documentation; a lighter library
fits when memory and startup matter more.

OpenAPI 3.1 and JSON Schema 2020-12 are emitted as they are; older
dialects throw rather than being converted approximately.
