---
title: Responses
description: What a handler's return value becomes, what ctx.out carries, how a response map lists the statuses a route answers with, and how redirects and your own Response objects are sent.
sidebar:
  order: 8
---

A handler answers by returning a value, and the framework turns that value
into the response.

## What a handler's return becomes

| The handler returns | The response |
| --- | --- |
| `undefined`, or nothing | `204`, no body |
| a `Response` | sent as it is |
| any other value | JSON, with `200` |

`ctx.out.status` replaces the `200` or `204` of a serialized value. It has
no effect on a `Response`, which states its own status:

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

A `ReadableStream` or a generator returned bare is a compile error, and a
`500` at runtime: as JSON it would be `{}`. A stream goes out inside a
`Response` that states its content type. See
[Streaming](/docs/concepts/streaming/).

## `ctx.out`

`ctx.out` is what the response carries besides its body. `ctx.headers` and
`ctx.cookies` are what arrived; `ctx.out.headers` and `ctx.out.cookies` are
what leaves.

| Field | |
| --- | --- |
| `status` | the status of a serialized result |
| `headers` | a standard `Headers` |
| `cookies` | `set(name, value, attributes)` and `delete(name, attributes)`, see [Cookies](/docs/concepts/cookies/) |

Every hook and the handler share the same `ctx.out`. `headers` is never
replaced, only changed with `set()` and `append()`, so two hooks that write
headers do not overwrite each other's.

`ctx.out.headers` is applied to every response that leaves: a serialized
result, a `Response` the handler built, a hook's short-circuit, and an
error response. A request id or a rotated session cookie does not vanish
on the `401` it goes with. Headers are merged by name:

- `set-cookie` is appended;
- `vary` is merged, each token once, so a handler's `Vary: Cookie` survives
  a CORS hook adding `Origin`;
- every other name overwrites the response's own value.

`ctx.out.status`, by contrast, applies only to a serialized result. An
error's status belongs to the error, and a `Response` carries its own.

## The response map

`schema.response` describes what leaves. A single schema checks every
serialized response, whatever its status. A map binds a schema to each
status, and is also the list of statuses the route answers with:

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

- **Only a declared status leaves.** Setting an undeclared status on
  `ctx.out.status` is a compile error. A response that still leaves with
  one, such as the implicit `200` of a handler that forgot to set `201`, is
  a `500`.
- **`null` declares a status without a body**, such as `204` or `304`. A
  value returned under it is a `500`.
- **The status picks the schema.** The handler may return any of the
  declared shapes, and the status it leaves with decides which schema
  checks it. The wrong shape for the status compiles, and is a `500`.

Entries for statuses the handler never returns, such as a `404` it throws,
only document the error path. A thrown `HttpError` is answered by the
[error mapping](/docs/concepts/errors/), and no response schema is checked
there.

### What is serialized

The value the schema returns is what becomes the JSON. In the example
above, the stored user carries a `passwordHash` that `PublicUser` does not
name, and Zod's object schema drops unknown keys, so the hash never leaves.
TypeScript alone would not catch this: a `StoredUser` satisfies
`{ id: number; name: string }`, extra field and all.

A response that fails its schema is the server's fault. It answers `500`
with the envelope and nothing of the value, and `reportError` receives a
`ResponseContractError` with `source: "response"`. See
[Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response).

`validateResponses: false` on `createApp` turns every response check off.
The schemas still type the handler and document the route. The framework
never reads `NODE_ENV` itself, so checking outside production only is your
call:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({
  routes,
  validateResponses: Bun.env.NODE_ENV !== "production",
});
```

### Headers and cookies of a status

An entry can check headers and cookies too, with the keys `body`, `headers`
and `cookies`, and name a body that is not JSON with `contentType`
([below](#a-body-that-is-not-json)). Any other key is refused at startup,
so a misspelled part is not silently left unchecked:

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

- `headers` sees `ctx.out.headers` after the handler returns, names in
  lower case, without `set-cookie`. Hooks may have added headers too, so
  the schema should allow keys it does not name.
- `cookies` sees each cookie the response sets, by name, with the value as
  the handler wrote it: opened when signed, `""` when deleted.
- An entry without `body` has no body, like `null`, unless it has a
  `contentType`.

A response that breaks them is a `500`.

### A body that is not JSON

A value the handler returns always leaves as JSON. A CSV export, a file or
an event stream is a `Response` the handler builds, and `contentType` on its
entry says what it carries:

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
declare function toCsv(rows: object[]): string;
declare const orders: { all(): object[] };
// ---cut---
route({
  method: "GET",
  path: "/orders.csv",
  schema: { response: { 200: { contentType: "text/csv", body: z.string() } } },
  handler: () =>
    new Response(toCsv(orders.all()), { headers: { "content-type": "text/csv" } }),
});
```

- The [document](/docs/packages/openapi/) describes the status under
  `text/csv` instead of `application/json`, with `body` as its schema.
  Without `body`, by the type alone: `"application/pdf"`, `"image/*"`, or
  `"*/*"` for a file of any type.
- Returning a value for such a status is a compile error, and so is
  returning nothing: a value would leave as JSON, nothing as an empty body.
  A type the compiler knows only as a `string`, in a map declared apart
  from the route, counts as not JSON; `as const` keeps the literal. Where
  the compiler does not see the key at all, as in an entry typed as
  `ResponseEntry`, the response is a `500` when responses are validated.
- Its `headers` and `cookies` are documented, not checked: only a
  `Response` answers such a status, and a `Response` is not checked.
- The type goes alone, `"text/csv"` and not `"text/csv; charset=utf-8"`:
  the charset belongs on the `Response`. `route()` throws on anything but a
  bare type or a range.

## Redirects

A redirect is a response like any other. `Response.redirect` works from a
handler or a hook, and cookies set on `ctx.out` go with it:

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

That redirect is a `Response`, so it is not checked and not in the
generated document. To have it checked and documented, declare it in the
response map, set the status and `location` on `ctx.out`, and return
nothing:

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

A `Response` the handler builds is sent as it is: no response schema checks
it, the response map does not apply to its status, and the generated
document does not describe it. `ctx.out.headers` is still applied, and
`beforeResponse` and `afterResponse` hooks still see it.

Use it for what JSON is not, such as a file, HTML or a stream. For JSON,
return the value, so the contract stays checked and documented.

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
