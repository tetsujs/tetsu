---
title: Lifecycle hooks
description: Hooks run in fixed, named slots of a request, extend the context by returning an object, and refuse a request by throwing or returning a Response.
sidebar:
  order: 3
---

A hook is a function bound to one slot of the request lifecycle. This page
covers the slots and their order, how a hook adds to the context or stops a
request, and what each slot may do.

## The slots

A request passes through fixed stages. There is no `next()` and no onion
to reason about: every hook has one position in time, named by its slot.

```text
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse

onError: when any stage throws, before beforeResponse
```

`parse` and `validate` are the framework's own stages — reading the body
and checking the request against the route's schemas. The other names are
the slots a hook can be mounted in:

| Slot | Runs | Typical use |
| --- | --- | --- |
| `beforeParse` | before the body is read | authentication, rate limits, request ids |
| `beforeValidation` | after the body is parsed, before it is checked | normalizing raw input, checking a signature |
| `beforeHandle` | after validation, right before the handler | loading an entity by a validated id, ownership checks |
| `beforeResponse` | once the response exists, on every outcome | response headers, replacing the response |
| `afterResponse` | as the response goes out, on every outcome | access logs, metrics, audit |
| `onError` | when a stage throws | turning an error into a response |

Because `beforeParse` runs before the body is read, a request refused there
never pays for parsing, and a `401` from it always comes before a `422`
from validation. The [hook slots reference](/docs/reference/hooks/) lists
what each slot's context holds.

## Making a hook

A hook is made by the factory of its slot, `hook.<slot>(fn)`. The function
receives `ctx` and may return three things:

- **nothing** — the hook observed or checked, and the request goes on;
- **an object** — its fields join `ctx`, typed in every later hook and in
  the handler;
- **a `Response`** — the request stops here, and that response is sent.

To refuse a request, throw an `HttpError` — or anything else, which becomes
a `500` — or return a `Response`:

```ts twoslash
interface User { id: string }
declare const sessions: { verify(token: string | null): Promise<User | undefined> };
declare const notes: { listFor(userId: string): { id: number }[] };
// ---cut---
import { hook, HttpError, route } from "@tetsujs/core";

export const auth = hook.beforeParse(async (ctx) => {
  const user = await sessions.verify(ctx.req.headers.get("authorization"));

  if (!user) throw new HttpError(401);

  return { user };
});

route({
  method: "GET",
  path: "/notes",
  hooks: { beforeParse: [auth] },
  handler: (ctx) => notes.listFor(ctx.user.id),
  //                                   ^?
});
```

A hook that may return nothing contributes an optional field:
`return user ? { user } : undefined` makes `ctx.user` a `User | undefined`,
because on the requests where the hook returned nothing the field is not
there. Return a plain object literal: the context copies the object's own
string keys, so a class instance contributes its fields but not its
methods or getters. [Context](/docs/concepts/context/) covers what a hook
can and cannot put on `ctx`.

A `Response` a hook returns is built on every call. Its body is a stream
that can be read once, so a response kept in a module-level constant sends
its body to the first request and an empty one to every request after,
with the status and headers intact.

A bare function is not a hook. Mounted without its factory, it is a
compile error that names the fix — `wrap it with hook.beforeParse(...)` —
because the factory is what carries the slot and the types.

## Mounting by slot

Hooks are mounted by slot, the same way on a route, a group and the
application:

```ts twoslash
import { hook } from "@tetsujs/core";
const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));
const log = hook.afterResponse(() => {});
// ---cut---
import { route } from "@tetsujs/core";

route({
  method: "GET",
  path: "/me",
  hooks: { beforeParse: [auth], afterResponse: [log] },
  handler: (ctx) => ctx.user,
});
```

The key says where a hook runs, and the compiler checks it against the
slot the hook was made for:

```ts twoslash
import { hook, route } from "@tetsujs/core";
// ---cut---
const loadNote = hook.beforeHandle(() => ({ note: { id: 1 } }));

// @errors: 2322
route({
  method: "GET",
  path: "/notes/:id",
  hooks: { beforeParse: [loadNote] },
  handler: () => undefined,
});
```

Inside a slot, the array is the order. The slots themselves always run in
lifecycle order, whatever order they are written in. The same mistakes are
refused at startup for code the compiler did not check: a misspelled slot
such as `beforParse`, a hook under the wrong key, and a value that is not a
hook. [Groups and mounting](/docs/concepts/groups-and-mounting/) covers the
order of hooks across the application, groups and a route.

## Before the handler

The three slots before the handler extend the context. Each hook sees what
the hooks before it returned — earlier in its own slot, or in an earlier
slot — and its own contribution is typed for everything after it.

- **`beforeParse`** sees the request, the raw path parameters and
  `ctx.route`. No body, query or validated headers exist yet.
- **`beforeValidation`** also sees `ctx.body`, parsed and not yet trusted:
  `unknown` for JSON. A hook here may normalize it — trim strings, rename a
  legacy field — and what it returns under `body` is what gets validated.
  This is also where a webhook's signature is checked, over the bytes
  `rawBody: true` keeps; see
  [Request bodies](/docs/concepts/request-bodies/#raw-bytes-for-signatures).
- **`beforeHandle`** sees the validated request. A reusable hook here
  states what it needs with `Requires`, and mounting it where that is not
  provided is a compile error; see
  [Context](/docs/concepts/context/#stating-what-a-hook-needs).

A `Response` returned from any of them skips the rest of the stages,
handler included, and still goes through `beforeResponse` and
`afterResponse`.

## `beforeResponse`

A `beforeResponse` hook sees the response as `ctx.res` and may replace it
by returning another `Response`. It runs for every response the route
sends: a handler's result, a hook's short-circuit, and an error response
too — so a hook that decorates responses does not go missing on exactly
the `401`s and `500`s where it matters:

```ts twoslash
import { hook } from "@tetsujs/core";

export const noStore = hook.beforeResponse((ctx) => {
  if (ctx.res.status >= 400) return;

  const res = new Response(ctx.res.body, ctx.res);

  res.headers.set("cache-control", "no-store");

  return res;
});
```

For a header alone, `ctx.out.headers` is shorter: it is laid over every
response that leaves, whatever produced it. Returning anything but a
`Response` from this slot changes nothing; the context is not extended
after the handler.

Each `beforeResponse` hook starts at most once per request. When one of
them throws, its error is mapped through `onError`, and the resulting
error response continues the chain from the next hook — the hooks that
already ran do not run again, so an audit line is not written twice.

This is also the last place the body is yours to read. To audit a body,
clone the response here: `void ctx.res.clone().text().then(…)`. A clone of
a streamed body keeps every chunk until it is read, so a stream is audited
where it is produced.

## `afterResponse`

`afterResponse` hooks observe. They run on every outcome, errors included,
and nothing they return affects the response — which makes them the place
for logs and metrics.

An observer starts as the response goes to Bun, with the whole request in
reach: its headers, the client's address. Its synchronous part is part of
the response's latency; the promise it returns is not waited for. Two
things follow.

The body is not an observer's to read. `ctx.res` is a `SentResponse` —
status, headers and the rest, with no way to the body — and reading one is
a compile error:

```ts twoslash
import { hook } from "@tetsujs/core";
// ---cut---
// @errors: 2339
hook.afterResponse(async (ctx) => {
  const body = await ctx.res.text();
});
```

And what an observer needs of the request or the response, it reads before
its first `await`. By then the response may be sent, and Bun fills the
request lazily: a URL, a header or the address nobody read is gone,
without an error.

```ts twoslash
declare const shipper: { send(line: object): Promise<void> };
// ---cut---
import { hook } from "@tetsujs/core";

export const shipped = hook.afterResponse(async (ctx) => {
  const line = {
    status: ctx.res.status,
    route: ctx.route?.path,
    agent: ctx.req.headers.get("user-agent"),
    ip: ctx.server.requestIP(ctx.req)?.address,
    ms: performance.now() - ctx.startedAt,
  };

  await shipper.send(line);
});
```

The observers of a request start in order, each without waiting for the
one before, so each reaches its first `await` while the request is still
there. One that needs another's result does both in one hook, or awaits a
promise the other left. An observer that throws or rejects is reported —
to `reportError`, or to the console — and the others still run.

## `onError`

An `onError` hook receives `ctx.error` and may answer it with a
`Response`. Returning nothing passes the error on to the next `onError`
hook. What no hook answered gets the default: an `HttpError` becomes its
JSON envelope, anything else a `500`, reported to `reportError`.

```ts twoslash
class AlreadyShipped extends Error {}
// ---cut---
import { hook } from "@tetsujs/core";

export const conflicts = hook.onError((ctx) =>
  ctx.error instanceof AlreadyShipped
    ? Response.json({ error: "ALREADY_SHIPPED" }, { status: 409 })
    : undefined,
);
```

The slot takes a `Response` or nothing; returning a plain object is a
compile error rather than a body. Every other slot runs outermost-first —
the application's hooks, then each group's, then the route's — but
`onError` runs innermost-first: the route's hooks, then the groups', then
the application's. The most specific hook gets to map an error before the
general ones. An application-level `onError` hook sees every failure,
`404` and `405` included, which makes it the place to change the error
format for the whole application; see [Errors](/docs/concepts/errors/).

The error response then goes through `beforeResponse` and `afterResponse`
like any other.

## Time

Every hook and handler sees `ctx.startedAt`, the `performance.now()`
reading taken when the framework received the request — before any hook
ran. `performance.now() - ctx.startedAt` is how long the request has been
in the framework, which is what an access log reports. It is a monotonic
clock, so a difference of two readings is a duration even when the system
clock is adjusted; wall-clock time is `Date.now()`.

## Synchronous until something is not

A request runs through the stages as plain function calls, and becomes
asynchronous only at the first stage that returns a promise — a hook that
awaits, a body being read, an `async` handler. A synchronous hook before
the handler costs a function call and no microtask, so a guard that only
reads a header is best written without `async`. A route with
`beforeResponse` hooks goes through them asynchronously.
