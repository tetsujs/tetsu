---
title: Context and its types
description: What is on ctx at each point of a request, why a field exists only when something provides it, and how a reusable hook states what it needs.
sidebar:
  order: 4
---

`ctx` is the object a request carries through its hooks and its handler.
A field is on it only once it exists at that point of the request: the
body after it was read, `ctx.user` after the hook that returned it. Its
type is inferred at the `route()` call from the path, the schemas and the
hooks, so you never annotate it in a handler.

## What is on it

- **Always:** `req` and `server`, Bun's own request and server, not
  wrappers; `out`, what the response will carry; `startedAt`, a
  `performance.now()` reading taken as the request arrived.
- **Where a route matched:** `route`, the matched route's `method`,
  `path`, `controller` and `name`; `params`, the path parameters.
- **With a schema:** `query`, `headers`, `cookies` and `body`, validated,
  from `beforeHandle`. A body the route reads is there as parsed from
  `beforeValidation`, and so is `rawBody` with `rawBody: true`.
- **In their slots:** `res` in `beforeResponse` and `afterResponse`,
  `error` in `onError`.
- **After a hook:** whatever that hook returned.

`ctx.server.requestIP(ctx.req)` gives the client's address; behind a proxy
it is the proxy's, see [Behind a proxy](/docs/guides/behind-a-proxy/).

Write to `ctx.out`, do not replace it: `ctx.out.status = 201`,
`ctx.out.headers.set(…)`, `ctx.out.cookies.set(…)`. Its headers are added
to every response, error responses included. See
[Responses](/docs/concepts/responses/) and
[Cookies](/docs/concepts/cookies/).

The [context reference](/docs/reference/context/) lists every field with
its type and the slot it exists from.

## No schema, no field

`ctx.query`, `ctx.headers`, `ctx.cookies` and `ctx.body` exist only on a
route that declares them. Without a `query` schema there is no
`ctx.query` at all, not even an `unknown` one:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
// @errors: 2339
route({
  method: "GET",
  path: "/notes",
  handler: (ctx) => ctx.query.page,
});
```

Unvalidated input has no type worth trusting, and an `unknown` field is
one cast away from being used as if it were checked. A part without a
schema is also not read at all. Declare a schema for the part you need,
and the field arrives typed from its output. For raw access, `ctx.req` is
always there.

`ctx.params` always exists, typed from the path.

## Fields from hooks

A hook in `beforeParse`, `beforeValidation` or `beforeHandle` adds fields
by returning an object. Those fields are typed in the hooks after it and
in the handler:

```ts twoslash
interface Session { userId: string; expiresAt: number }
declare const sessions: { get(token: string): Session | undefined };
// ---cut---
import { hook, HttpError, route } from "@tetsujs/core";

const session = hook.beforeParse((ctx) => {
  const found = sessions.get(ctx.req.headers.get("authorization") ?? "");

  if (!found) throw new HttpError(401);

  return { session: found };
});

route({
  method: "GET",
  path: "/me",
  hooks: { beforeParse: [session] },
  handler: (ctx) => ({ id: ctx.session.userId }),
  //                            ^?
});
```

A later hook's field replaces an earlier one's of the same name. A hook
before validation may change `ctx.query` or `ctx.body`, but validation
runs after it, and the handler sees the schema's output.

In `beforeResponse`, `afterResponse` and `onError` these fields are
optional. Those slots run on every outcome, including a request refused
before the hook that adds the field ran.

## Stating what a hook needs

A hook reused across routes cannot know which route it will be mounted
on. It states what it needs instead, with `Requires<{ … }>` on its
parameter:

```ts twoslash
interface User { id: string }
interface Note { id: number; owner: string; title: string }
declare const notes: { find(id: number): Promise<Note | undefined> };
// ---cut---
import type { Requires } from "@tetsujs/core";
import { hook, HttpError } from "@tetsujs/core";

export const withNote = hook.beforeHandle(
  async (ctx: Requires<{ params: { id: number }; user: User }>) => {
    const note = await notes.find(ctx.params.id);

    if (!note || note.owner !== ctx.user.id) throw new HttpError(404);

    return { note };
  },
);
```

`Requires<T>` is the base context (`req`, `server`, `out`, `startedAt`)
plus `T`. Where the hook is mounted, the compiler checks that the path,
the schemas and the earlier hooks provide those fields. Mounted on a route
without a `params` schema, where `params.id` is a string, or with no hook
providing `user`, it is a compile error that names the missing field.

## Why a group hook's field is not in the handler's type

A hook mounted on a group runs for every route under it, but the fields it
returns are not in the handlers' types. A controller is typed where it is
written, not where it is mounted, and the same controller could be
mounted under an authenticated group and outside one.

The field is still there at runtime, but to use it in a handler, mount the
hook on the route itself. For hooks several routes share, keep them in a
constant, such as `{ beforeParse: [auth] } as const`.

Use group hooks for work that needs no typed field later: guards that
refuse, logs, metrics, CORS. See
[Groups and mounting](/docs/concepts/groups-and-mounting/#what-a-level-sees)
for what group hooks can see of each other.

## What a hook cannot put there

A hook cannot replace the framework's own fields: `req`, `server`, `out`,
`route`, `res`, `error`, `startedAt` and `rawBody`. If a hook returns one
of them, the key is dropped at runtime and left out of the hook's type.
Otherwise a hook could, for example, forge `server` and defeat every
address-based rate limit behind it. The keys `__proto__`, `constructor`
and `prototype` are dropped too.

`params`, `query`, `body`, `headers` and `cookies` are not protected;
hooks may normalize them.

Only the returned object's own string keys are copied. Return a plain
object literal: the methods and getters of a class instance are not
copied.
