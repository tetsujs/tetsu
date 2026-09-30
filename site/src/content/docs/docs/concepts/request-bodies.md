---
title: Request bodies
description: How a route declares its body with bodyType, how uploads arrive, how maxBodySize limits what is read, and how rawBody keeps the bytes a signature is over.
sidebar:
  order: 7
---

A route says how its body is read, and the framework reads it that way,
within a size limit. This page covers the body shapes, file uploads, the
limits, and keeping the raw bytes for a signature.

## Declaring the shape

`bodyType` declares the body's wire shape:

| `bodyType` | `ctx.body` before validation | |
| --- | --- | --- |
| `"json"` | `unknown` | the default |
| `"form"` | a record of strings and `File`s | `multipart/form-data` and `application/x-www-form-urlencoded` |
| `"text"` | `string` | the body as text |
| `"stream"` | `ReadableStream<Uint8Array>` | the body unread, for the handler to consume |

The route decides, not the `content-type` header. Guessing from the header
fails on requests that carry none — `fetch` sends no content type for a
plain string body, which is how many clients post JSON — so the header is
never consulted, and a body that does not parse as the declared shape is a
`400`: `MALFORMED_JSON` or `MALFORMED_FORM`, never a silent
reinterpretation.

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

## The body is read only when declared

A route reads its body when it has a `body` schema, a `bodyType`, or
`rawBody: true`. A route with none of them never touches it: the bytes are
not read, not counted and not parsed, and `ctx.body` does not exist. A
`GET` route pays nothing for bodies, and a `beforeParse` hook that refuses
a request does so before a single byte is read.

Declaring the shape is the way to take the body in hand. `ctx.req` is
always there, and a handler can read `ctx.req.body` itself, but then no
line of the route says so and `maxBodySize` does not apply to it. A route
that declares `"stream"` states where the body will be read, and keeps the
limit.

## Uploads

A `"form"` body parses both multipart and urlencoded forms, with Bun's own
parser. Files arrive as `File` values inside `ctx.body`, next to the text
fields, and are validated like any other field — size and type included.
With TypeBox, `file()` and `files()` from
[`@tetsujs/typebox`](/docs/packages/typebox/#files) describe them:

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

Any validator that can describe a `File` works the same way — with Zod,
`z.file()`. A few things about forms are worth knowing:

- A field sent once is a value, a repeated one an array, as with the query
  string.
- A file input nothing was chosen in is left out, as a field that is not
  there. A browser sends it as a file with no name and no bytes; kept, it
  would make an optional file field fail as the wrong type on every
  ordinary form. A file that has a name and no bytes is a file, and stays.
- A file's `type` is the MIME type the client declared, not what its bytes
  are. A check on `type` is a check on what the client said.
- The whole form is read within `maxBodySize` before it is parsed, and the
  limit counts the multipart framing too, which is larger than it looks.

A form of files alone needs no schema to be parsed: `bodyType: "form"` is
enough, and `ctx.body` is the record of fields and files as they
arrived.

## Size limits

`maxBodySize` is the most a route reads, in bytes. It is 1 MiB by default,
set for the whole application on `createApp`, and overridden per route:

```ts twoslash
declare const routes: object;
// ---cut---
import { createApp } from "@tetsujs/core";

createApp({ routes, maxBodySize: 256 * 1024 });
```

One number cannot serve a JSON API and an upload endpoint at once: raising
the application's limit for one route raises it everywhere else. The
exception belongs on the route that is one, as `maxBodySize` does in the
upload above.

The limit is counted while the body is read, so an oversized request is
refused without being buffered:

- A `content-length` above the limit is refused before a single byte is
  read.
- A chunked body declares no length, so its chunks are counted as they are
  buffered, and the request is refused at the first chunk that crosses the
  limit. The rest of that body is abandoned mid-flight, which leaves the
  connection unusable: the client gets its `413`, and the next request over
  the same connection fails.
- A `"stream"` body is counted chunk by chunk as the handler reads it,
  without being buffered.

Each is the same `413`:

```json
{ "status": 413, "message": "Body exceeds the configured limit", "error": "BODY_TOO_LARGE" }
```

A stream fails later than a buffered body, and it has to: the handler is
already running and may have written part of the upload somewhere. The
`413` is raised by the stream, which the handler's `for await` rethrows;
undoing the partial write is the handler's, in the `finally` it needs
anyway.

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

A `"stream"` body cannot have a `body` schema — the bytes reach the
handler unread, so there is nothing to validate them against — and
declaring both is a compile error.

### Bun's own limit

`Bun.serve` has a limit of its own, `maxRequestBodySize`, 128 MiB by
default. It refuses a larger body before the request reaches the
application, with a bare `413` rather than the envelope. An application
that allows more would otherwise need the number in two places, one of
them outside the framework, and would find the omission as a status with
an empty body.

So `createApp()` works it out: when the largest `maxBodySize` anywhere in
the application — its own or any route's — is above Bun's default, the
application carries a `maxRequestBodySize` a little above it, and
`Bun.serve({ ...app })` picks it up with everything else. The margin makes
the framework's check come first, with its envelope, and leaves Bun's as
the backstop. It is only ever raised, never lowered. A value written after
the spread still wins, because that is what spreading means.

The framework caps only the bodies it reads. A handler that reads
`ctx.req` directly is limited by Bun's cap alone.

### Large uploads

Streaming lets a route accept a large body without holding it in memory,
but the bytes still pass through the application's process and its
connection, for as long as the upload takes. For files of many megabytes
and more, the usual design keeps them out of the application altogether:
the route checks who is asking and answers with a pre-signed URL, and the
client uploads straight to object storage. The application then handles
a small JSON request, and the upload is the storage's to carry.

## Raw bytes for signatures

A webhook is signed over the bytes it was sent as, and handled as the
payload they carry. `rawBody: true` keeps both: the bytes in
`ctx.rawBody`, and the body parsed and validated in `ctx.body`. The bytes
are there from `beforeValidation` on, so a hook in that slot can check the
signature before anything is validated:

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
needs it cannot be mounted on one that does not — and it cannot be a field
a hook forges. It goes with a `json` or `text` body: a form is parsed
natively and its bytes are not kept, and a stream is the raw body already;
declaring either with `rawBody` is a compile error. Only the route that
asks pays for it, since its body is held twice, as bytes and as what was
parsed from them.

The [Webhooks guide](/docs/guides/webhooks/) builds a complete receiver on
this.
