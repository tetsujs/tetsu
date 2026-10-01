---
title: Request bodies
description: How a route declares its body with bodyType, how uploads arrive, how maxBodySize limits what is read, and how rawBody keeps the bytes a signature is over.
sidebar:
  order: 7
---

A route declares how its body is read, and the framework reads it that way,
within a size limit.

## Declaring the shape

`bodyType` sets the body's wire shape:

| `bodyType` | `ctx.body` before validation | |
| --- | --- | --- |
| `"json"` | `unknown` | the default |
| `"form"` | a record of strings and `File`s | `multipart/form-data` and `application/x-www-form-urlencoded` |
| `"text"` | `string` | the body as text |
| `"stream"` | `ReadableStream<Uint8Array>` | the body unread, for the handler to consume |

The route decides, not the `content-type` header, which many clients leave
out: `fetch` sends none for a plain string body. A body that does not parse
as the declared shape is a `400`, `MALFORMED_JSON` or `MALFORMED_FORM`.

With a `body` schema, `ctx.body` is the schema's output. Without one, it is
the parsed shape from the table:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
route({
  method: "POST",
  path: "/notes/import",
  bodyType: "text",
  handler: (ctx) => ({ lines: ctx.body.split("\n").length }),
  //                              ^?
});
```

A route reads its body only when it has a `body` schema, a `bodyType` or
`rawBody: true`. Otherwise the body is never read and `ctx.body` does not
exist. The body is read after the `beforeParse` hooks, so a hook there that
refuses a request costs no reading at all.

A handler can still read `ctx.req.body` itself, but `maxBodySize` does not
apply to it. To read the body yourself, declare `"stream"` instead.

## Uploads

A `"form"` body is parsed with Bun's own parser. Files arrive as `File`
values in `ctx.body`, next to the text fields, and are validated like any
other field. With TypeBox, `file()` and `files()` from
[`@tetsujs/typebox`](/docs/packages/typebox/#files) describe them; with Zod,
`z.file()`:

```ts twoslash
declare const images: { save(title: string, image: File): Promise<{ id: string }> };
// ---cut---
import { controller, route } from "@tetsujs/core";
import { file, Type, tb } from "@tetsujs/typebox";

const ImageUpload = tb(
  Type.Object({
    title: Type.String({ minLength: 1 }),
    image: file({ maxSize: "2m", type: "image" }),
  }),
);

export const imagesController = controller("Images", () => ({
  upload: route({
    method: "POST",
    path: "/images",
    bodyType: "form",
    maxBodySize: 3 * 1024 * 1024,
    schema: { body: ImageUpload },
    handler: async (ctx) => {
      ctx.out.status = 201;

      return await images.save(ctx.body.title, ctx.body.image);
      //                                                 ^?
    },
  }),
}));
```

- A field sent once is a value, a repeated one an array, as in the query
  string.
- A file input left empty is dropped, as if the field were not sent, so an
  optional file field works on an ordinary HTML form.
- A file's `type` is the MIME type the client declared, not what the bytes
  are.
- `maxBodySize` counts the whole form, multipart framing included.

Without a schema, `ctx.body` is the record of fields and files as they
arrived.

## Size limits

`maxBodySize` is the most a route reads, in bytes. It is 1 MiB by default,
set for the application on `createApp`, and overridden per route, as the
upload above does:

```ts twoslash
declare const routes: object;
// ---cut---
import { createApp } from "@tetsujs/core";

createApp({ routes, maxBodySize: 256 * 1024 });
```

Raise it on the route that needs more, not for the whole application.

An oversized body is refused without being buffered:

- A `content-length` above the limit is refused before any byte is read.
- A chunked body is counted as it arrives and refused at the first chunk
  that crosses the limit. The rest is left unread, so that connection
  cannot carry another request.
- A `"stream"` body is counted as the handler reads it.

Each is the same `413`:

```json
{ "status": 413, "message": "Body exceeds the configured limit", "error": "BODY_TOO_LARGE" }
```

### Streamed bodies

A `"stream"` body reaches the handler unread, so a large upload is never
held in memory:

```ts twoslash
declare const storage: { put(key: string, body: ReadableStream<Uint8Array>): Promise<void> };
// ---cut---
import { route } from "@tetsujs/core";

route({
  method: "PUT",
  path: "/backups/:name",
  bodyType: "stream",
  maxBodySize: 5 * 1024 ** 3,
  handler: async (ctx) => {
    await storage.put(ctx.params.name, ctx.body);
  },
});
```

The limit fails later here: the handler is already running when it is
crossed. The stream errors with the `413`, and whatever reads it rethrows
it. Cleaning up a partial write is the handler's job, in a `finally`.

A `"stream"` body cannot have a `body` schema, since nothing is read before
the handler runs. Declaring both is a compile error.

### Bun's own limit

`Bun.serve` has its own `maxRequestBodySize`, 128 MiB by default, and
refuses a larger body with a bare `413` before the application sees it.
When any `maxBodySize` in the application is above that, `createApp()` puts
a slightly higher `maxRequestBodySize` on the app, and
`Bun.serve({ ...app })` picks it up. It is only ever raised, and a value
written after the spread still wins. A handler that reads `ctx.req` itself
is limited by this cap alone.

### Large uploads

For files of many megabytes, the usual design keeps them out of the
application: the route checks who is asking and returns a pre-signed URL,
and the client uploads straight to object storage.

## Raw bytes for signatures

A webhook is signed over the exact bytes it was sent as. `rawBody: true`
keeps them in `ctx.rawBody`, next to the parsed and validated `ctx.body`.
The bytes are there from `beforeValidation` on, so a hook in that slot can
check the signature before anything is validated:

```ts twoslash
declare function verify(body: Uint8Array, signature: string | null): boolean;
declare const payments: { record(event: { id: string; amount: number }): void };
// ---cut---
import type { Requires } from "@tetsujs/core";
import { hook, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const PaymentEvent = z.object({ id: z.string(), amount: z.number() });

const signed = hook.beforeValidation((ctx: Requires<{ rawBody: Uint8Array }>) => {
  if (!verify(ctx.rawBody, ctx.req.headers.get("x-signature"))) {
    throw httpError(401, "BAD_SIGNATURE");
  }
});

route({
  method: "POST",
  path: "/webhooks/payments",
  rawBody: true,
  schema: { body: PaymentEvent },
  hooks: { beforeValidation: [signed] },
  handler: (ctx) => payments.record(ctx.body),
});
```

`ctx.rawBody` is typed only on a route that asks for it, so a hook that
needs it cannot be mounted on one that does not. It works with `json` and
`text` bodies; with `form` or `stream` it is a compile error. The body is
held twice, as bytes and as what was parsed, so ask for it only where a
signature needs it.

The [Webhooks guide](/docs/guides/webhooks/) builds a complete receiver on
this.
