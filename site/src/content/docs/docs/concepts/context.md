---
title: Context and its types
description: What is on ctx at each point of a request, why a field exists only when something provides it, and how a reusable hook states what it needs.
sidebar:
  order: 4
---

`ctx` is the one object a request carries through its hooks and its
handler. This page covers what is on it and when, how a reusable hook
states what it needs, and what a hook cannot put there.

## One rule

A field is on `ctx` exactly when it exists at that point of the request.
Path parameters come from the path literal, the body exists only after it
was read and validated, and `ctx.user` exists only after the hook that
returned it. `ctx` is never annotated in a handler; its type is worked out
at the `route()` call from the path, the schemas and the hooks.

## What is on it

| Field | Where | What it is |
| --- | --- | --- |
| `req` | everywhere | the incoming `Request`, as Bun delivered it |
| `server` | everywhere | the real `Bun.Server`: `requestIP`, `upgrade`, `timeout` |
| `out` | everywhere | what the response will carry: `status`, `headers`, `cookies` |
| `route` | everywhere a route matched | the matched route: `method`, `path`, `controller`, `name` |
| `startedAt` | everywhere | a `performance.now()` reading taken as the request arrived |
| `params` | everywhere a route matched | path parameters: strings, or a `params` schema's output |
| `query` | from `beforeHandle`, with `schema.query` | the validated query |
| `headers` | from `beforeHandle`, with `schema.headers` | the validated headers |
| `cookies` | from `beforeHandle`, with `schema.cookies` | the validated cookies |
| `body` | from `beforeValidation` when a body is read | the parsed body; from `beforeHandle`, validated when there is a schema |
| `rawBody` | from `beforeValidation`, with `rawBody: true` | the body's bytes, a `Uint8Array` |
| `res` | `beforeResponse`, `afterResponse` | the response; a `SentResponse` without its body in `afterResponse` |
| `error` | `onError` | what was thrown |
| anything else | after the hook that returned it | a hook's contribution |

`req` and `server` are the platform's own objects, not wrappers — an escape
hatch to everything Bun offers. `ctx.server.requestIP(ctx.req)` is the
client's address, in the form the socket reports it: a server listening on
both IPv4 and IPv6, Bun's default, reports an IPv4 client as
`::ffff:203.0.113.7`. `ctx.req.cookies` is Bun's `CookieMap` on a request
Bun's router delivered, and absent where it was not involved — the `404`
fallback and a unit-tested handler — which is why its type is optional.

`ctx.out` is written, not assigned: `ctx.out.status = 201`,
`ctx.out.headers.set(…)`, `ctx.out.cookies.set(…)`. Its headers are laid
over every response that leaves, error responses included. See
[Responses](/docs/concepts/responses/) and
[Cookies](/docs/concepts/cookies/).

The [context reference](/docs/reference/context/) lists every field with
its type.

## No schema, no field

`ctx.query`, `ctx.headers`, `ctx.cookies` and `ctx.body` exist only on a
route that declares them. Without a `query` schema the route has no
`ctx.query` — not an `unknown` one, none at all:

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

This is deliberate. Unvalidated input has no type worth trusting, and a
field typed `unknown` is one cast away from being used as if it were
checked. A part without a schema is also not read: the query string is not
parsed and the body is not touched. When a route needs a part, it declares
a schema for it, and the field arrives typed from the schema's output. For
a raw value, `ctx.req` is always there.

`ctx.params` always exists, typed from the path: `{ id: string }` for
`/notes/:id`, and an empty object for a path without parameters.

## Fields from hooks

A hook in `beforeParse`, `beforeValidation` or `beforeHandle` extends the
context by returning an object. Every field of it is typed in the hooks
after it and in the handler:

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

A later hook's field replaces an earlier one's of the same name, at
runtime and in the type. A part a schema validates is the exception: a
hook before validation may normalize `ctx.query` or `ctx.body`, but
validation runs after it, and the handler sees the schema's output.

In `beforeResponse`, `afterResponse` and `onError` the same fields are
optional. Those slots run on every outcome — a request refused in
`beforeParse`, a body that failed to parse — so the hook that contributes
a field, and the validation that produces one, may never have run.

## Stating what a hook needs

A hook written for one route can be typed by where it sits. A hook reused
across routes cannot know which route it will be mounted on, so it states
a contract instead: `Requires<{ … }>` on its parameter names the fields it
needs, on top of what every slot has.

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

Where the hook is mounted, the compiler checks that the path, the schemas
and the hooks before it provide those fields. Mounted on a route whose
`params.id` is a string — no `params` schema — or with no hook providing
`user`, it is a compile error naming what is missing:

```ts twoslash
interface User { id: string }
interface Note { id: number; owner: string; title: string }
import type { Requires } from "@tetsujs/core";
import { hook, route } from "@tetsujs/core";
const withNote = hook.beforeHandle(
  (ctx: Requires<{ params: { id: number }; user: User }>) => ({ note: { id: ctx.params.id } as Note }),
);
// ---cut---
// @errors: 2322
route({
  method: "GET",
  path: "/notes/:id",
  hooks: { beforeHandle: [withNote] },
  handler: (ctx) => ctx.note,
});
```

`Requires<T>` is the base context — `req`, `server`, `out`, `startedAt` —
with `T` on top. Hook packages use it the same way: a rate limit keyed by
user declares `Requires<{ userId: string }>`, and cannot be mounted ahead
of the hook that provides it.

## Why a group hook's field is not in the handler's type

A hook mounted on a group runs for every route under it, but what it
returns does not reach the handlers' types. A controller is typed where it
is written, not where it is mounted, and a group does not know which
routes it will hold: the same controller could be mounted under an
authenticated group and outside one.

The hook still runs, and its field is on the object at runtime. To use it
in a handler, do one of two things:

- mount the hook on the route itself — a set of hooks several routes share
  is a constant, `{ beforeParse: [auth] } as const`, written once;
- or have the code that reads the field declare it, with
  `Requires<{ user: User }>`, so the compiler checks that something
  provides it.

A group's hooks are for work that needs no typed field downstream:
guards that refuse, logs, metrics, CORS. Among themselves they are typed:
a group hook sees what the hooks before it at the same level contributed.
See [Groups and mounting](/docs/concepts/groups-and-mounting/#what-a-level-sees).

## What a hook cannot put there

Some fields belong to the framework: `req`, `server`, `out`, `route`,
`res`, `error`, `startedAt` and `rawBody`. A hook that returns one of them
does not replace it — the key is dropped, and it is left out of the
hook's type too. A forged `server` would defeat every address-based rate
limit behind it, a forged `route` would rename the endpoint in every log
line, and a forged `startedAt` would shorten every duration. The keys
`__proto__`, `constructor` and `prototype` are dropped for the same
reason: a hook that spreads a parsed body must not re-point the context's
prototype at data the client sent.

`params`, `query`, `body`, `headers` and `cookies` are not protected. A
hook is expected to normalize them.

Only the object's own string keys are copied. A symbol key never arrives,
so it is not typed either. A class instance contributes its own fields,
but not its methods or getters, which live on its prototype — the compiler
cannot tell an instance from an object literal, so return an object
literal.
