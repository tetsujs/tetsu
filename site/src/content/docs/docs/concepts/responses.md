---
title: Responses
description: What a handler's return value becomes, what ctx.out carries, how a response map lists the statuses a route answers with, and how redirects and your own Response objects are sent.
sidebar:
  order: 8
---

A handler answers by returning a value, and the framework turns that value
into the response. This page covers the rule for that, what `ctx.out` adds
to every response, how a response map states which statuses a route
answers with and what each one carries, and the two ways to redirect.

## What a handler's return becomes

| The handler returns | The response |
| --- | --- |
| `undefined`, or nothing | `204`, no body |
| a `Response` | sent as it is |
| any other value | JSON, with `200` |

`ctx.out.status` replaces the `200` or the `204` of a serialized value. It
has no effect on a `Response`, which states its own status:

```ts twoslash
import { route } from "@tetsujs/core";
declare const orders: { create(): { id: number } };
// ---cut---
route({
  method: "POST",
  path: "/orders",
  handler: (ctx) => {
    const order = orders.create();

    ctx.out.status = 201;
    ctx.out.headers.set("location", `/orders/${order.id}`);

    return order;
  },
});
```

A stream is not a value the framework serializes. A `ReadableStream` or a
generator has no own enumerable fields, so as JSON it would be `{}` and the
body would vanish without a word. Returning one bare is a compile error,
and the runtime refuses it too with a `500`; a stream leaves inside a
`Response` that states its content type. See [Streaming](/docs/concepts/streaming/).

## `ctx.out`

`ctx.out` is what the response will carry besides its body. It pairs with
the request side by position: `ctx.headers` and `ctx.cookies` are what
arrived, `ctx.out.headers` and `ctx.out.cookies` are what leaves.

| Field | |
| --- | --- |
| `status` | the status of a serialized result |
| `headers` | a standard `Headers`, created the first time it is read |
| `cookies` | `set(name, value, attributes)` and `delete(name, attributes)` — see [Cookies](/docs/concepts/cookies/) |

`headers` is never assigned, only changed: `set()` to own a header,
`append()` to add to one. Two hooks that write headers therefore compose
rather than replace each other's whole set. Every hook and the handler see
the same `ctx.out`, so a hook in `beforeParse` can set a header that goes
out with whatever the request ends in.

## Headers on every response

`ctx.out.headers` is laid over every response that leaves the pipeline:
a serialized result, a `Response` the handler built, a `Response` a hook
short-circuited with, and an error response. A request id or a rotated
session cookie does not disappear on exactly the `401` it accompanies.

The headers are merged name by name:

- `set-cookie` is appended to what the response already has;
- `vary` is merged, each token once, so a handler's `Vary: Cookie` survives
  a CORS hook adding `Origin`;
- every other name overwrites the response's own value.

A response whose headers cannot be changed — one a `fetch` to another
service returned — is copied first, so this holds for it too.

`ctx.out.status`, by contrast, applies only to a serialized result. An
error's status belongs to the error, and a `Response` carries its own.

## The response map

`schema.response` describes what leaves. A single schema checks every
response the handler serializes, whatever its status. A map binds a schema
to each status, and it is also the list of statuses the route answers with:

```ts twoslash
import { controller, httpError, route } from "@tetsujs/core";
import { z } from "zod";
interface StoredUser { id: number; name: string; passwordHash: string }
declare const users: Map<number, StoredUser>;
// ---cut---
const UserId = z.object({ id: z.coerce.number().int().positive() });
const NewUser = z.object({ name: z.string().min(1) });
const PublicUser = z.object({ id: z.number(), name: z.string() });

export const usersController = controller("Users", () => ({
  create: route({
    method: "POST",
    path: "/users",
    schema: { body: NewUser, response: { 201: PublicUser } },
    handler: (ctx) => {
      const user = { id: users.size + 1, name: ctx.body.name, passwordHash: "…" };

      users.set(user.id, user);
      ctx.out.status = 201;

      return user;
    },
  }),

  remove: route({
    method: "DELETE",
    path: "/users/:id",
    schema: { params: UserId, response: { 204: null } },
    handler: (ctx) => {
      if (!users.delete(ctx.params.id)) throw httpError(404, "USER_NOT_FOUND");
    },
  }),
}));
```

The rules the map sets:

- **Only a declared status leaves.** The handler can write only a declared
  status into `ctx.out.status`; anything else is a compile error. A
  response that leaves with an undeclared status anyway — the implicit
  `200` of a handler that forgot to set `201`, a status a hook wrote — is
  refused at runtime with a `500`.
- **`null` declares a status without a body**, such as a `204` or a `304`.
  It is in the map because it is part of what the endpoint answers, and the
  generated document lists it.
- **A value under a bodiless status is a `500`.** Returned for a status
  declared `null`, it would skip every schema — the stripping a `200` would
  have done included — so it is refused rather than sent.
- **The status picks the schema.** The handler may return any of the
  declared shapes, and the status the response leaves with decides which
  schema checks it. A documented error shape returned under `200`
  therefore compiles and fails at runtime.

```ts twoslash
// @errors: 2322
import { route } from "@tetsujs/core";
import { z } from "zod";
const Order = z.object({ id: z.number() });
// ---cut---
route({
  method: "POST",
  path: "/orders",
  schema: { response: { 200: Order } },
  handler: (ctx) => {
    ctx.out.status = 201;
    return { id: 1 };
  },
});
```

Entries for statuses the handler never returns — a `404` it throws, a `409`
a hook raises — document the error path and nothing more. A thrown
`HttpError` is answered by the [error mapping](/docs/concepts/errors/),
and no schema is consulted there.

### Headers and cookies of a status

A status that leaves with headers or cookies says so in place of its body's
schema, the way a request declares its parts. The entry has three keys —
`body`, `headers` and `cookies` — and any other is refused at startup, so a
misspelled part is not silently left unchecked:

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
declare const orders: { create(): { id: number; total: number } };
// ---cut---
const Order = z.object({ id: z.number(), total: z.number() });
const Created = z.object({ location: z.string() });

route({
  method: "POST",
  path: "/orders",
  schema: { response: { 201: { body: Order, headers: Created } } },
  handler: (ctx) => {
    const order = orders.create();

    ctx.out.status = 201;
    ctx.out.headers.set("location", `/orders/${order.id}`);

    return order;
  },
});
```

`headers` sees the headers on `ctx.out` once the handler has returned,
names in lower case and without `set-cookie`. That includes headers a hook
set before the handler, so a schema should not refuse keys it does not
name. `cookies` sees each cookie the response sets — through `ctx.out` or
through Bun's `ctx.req.cookies` — by name, with the value as the handler
wrote it: opened when the cookie is signed, `""` when it is deleted. An
entry without `body` carries none, as `null` does.

They are checked with the body, and a response that breaks them is a
`500`. What `ctx.out` holds still goes out with that `500`, as with every
error response: the schema says what a status leaves with, and is not a
filter over it.

## What is serialized

The response check is a transformation as well as a contract: the value the
schema returns is what becomes the JSON. In the example above, the stored
user carries a `passwordHash` and `PublicUser` does not name it. Zod's
object schema drops unknown keys, so the hash never leaves the process.

The compiler cannot guarantee that on its own. Typing is structural, and a
value of type `StoredUser` satisfies `{ id: number; name: string }`, extra
field and all. The runtime check is the barrier.

A response that fails its schema is not the client's fault. It answers
`500` with the envelope and nothing of the offending value, and the
application's `reportError` receives a `ResponseContractError` with
`source: "response"` — see [Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response).

`validateResponses: false` on `createApp` turns every response check off:
the schemas, the list of statuses, the bodiless rule. The schema still
checks the handler's return type at compile time and still documents the
route. Checking outside production only is a decision for the place the
application is built:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({
  routes,
  validateResponses: Bun.env.NODE_ENV !== "production",
});
```

The framework never reads `NODE_ENV` itself: a declared schema behaves the
same in every environment unless you say otherwise.

## Redirects

A redirect is a response like any other. The platform's
`Response.redirect` works from a handler, or from a hook that turns a
request away, and cookies set on `ctx.out` go with it:

```ts twoslash
import { route } from "@tetsujs/core";
declare const sessions: { open(): string };
// ---cut---
route({
  method: "POST",
  path: "/login",
  handler: (ctx) => {
    ctx.out.cookies.set("session", sessions.open(), { httpOnly: true });

    return Response.redirect("/orders", 303);
  },
});
```

Such a redirect is a `Response`, so it is sent unchecked and is absent from
the generated document. A redirect the response map declares is checked
and documented like any other status, its `location` included. The status
and the header go on `ctx.out`, and the handler returns nothing:

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
declare const orders: { create(): { id: number } };
// ---cut---
const SeeOther = z.object({ location: z.string() });

route({
  method: "POST",
  path: "/orders",
  schema: { response: { 303: { headers: SeeOther } } },
  handler: (ctx) => {
    const order = orders.create();

    ctx.out.status = 303;
    ctx.out.headers.set("location", `/orders/${order.id}`);
  },
});
```

## A `Response` of your own

A `Response` the handler builds is sent as it is. The framework does not
inspect a response it did not build: no response schema checks it, the
response map does not apply to its status, and the generated document does
not describe it. It is still a response leaving the pipeline, so
`ctx.out.headers` is laid over it and `beforeResponse` and `afterResponse`
hooks see it.

That makes a `Response` the way out for what JSON is not — a file, HTML, a
stream — and the reason not to reach for it by default. A route that
returns a value keeps its contract checked and documented; a route that
returns a `Response` gives both up.

```ts twoslash
import { route } from "@tetsujs/core";
declare const reports: { csv(id: string): Promise<string> };
// ---cut---
route({
  method: "GET",
  path: "/reports/:id",
  handler: async (ctx) =>
    new Response(await reports.csv(ctx.params.id), {
      headers: { "content-type": "text/csv" },
    }),
});
```
