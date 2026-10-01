---
title: Lifecycle hooks
description: Hooks run in fixed, named slots of a request, extend the context by returning an object, and refuse a request by throwing or returning a Response.
sidebar:
  order: 3
---

A hook is a function bound to one slot of the request lifecycle. Hooks do
authentication, logging, headers and error mapping around a handler.

## The slots

A request passes through fixed stages. There is no `next()`: every hook
runs at one point, named by its slot.

```text
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse

onError: when any stage up to beforeResponse throws
```

`parse` reads the body and `validate` checks the request against the
route's schemas. The other names are slots:

| Slot | Runs | Typical use |
| --- | --- | --- |
| `beforeParse` | before the body is read | authentication, rate limits, request ids |
| `beforeValidation` | after the body is parsed, before it is checked | normalizing raw input, checking a signature |
| `beforeHandle` | after validation, right before the handler | loading an entity by a validated id, ownership checks |
| `beforeResponse` | once the response exists, on every outcome | response headers, replacing the response |
| `afterResponse` | as the response goes out, on every outcome | access logs, metrics, audit |
| `onError` | when any stage up to `beforeResponse` throws | turning an error into a response |

A request refused in `beforeParse` never pays for parsing the body, and a
`401` from there always comes before a `422` from validation. The
[hook slots reference](/docs/reference/hooks/) lists what each slot's
context holds.

## Making a hook

Make a hook with its slot's factory, `hook.<slot>(fn)`. The function
receives `ctx` and returns one of three things:

- **nothing**: the request goes on;
- **an object**: its fields are added to `ctx`, typed in later hooks and
  in the handler;
- **a `Response`**: the request stops, and that response is sent.

To refuse a request, throw an `HttpError` or return a `Response`. Any
other thrown error becomes a `500`.

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

A hook that sometimes returns nothing adds an optional field:
`return user ? { user } : undefined` makes `ctx.user` a
`User | undefined`. [Context](/docs/concepts/context/) covers what a hook
can and cannot add to `ctx`.

Build a returned `Response` on every call. Its body can be read only once,
so a response kept in a module-level constant sends an empty body to
every request after the first.

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

Within a slot, hooks run in array order. The compiler checks that each
hook sits under the slot it was made for, and a plain function without
its factory is a compile error. Code the compiler did not check is
checked at startup, including a misspelled slot such as `beforParse`.
[Groups and mounting](/docs/concepts/groups-and-mounting/) covers the
order of hooks across the application, groups and a route.

## Before the handler

The three slots before the handler add to the context. Each hook sees
what earlier hooks returned.

- **`beforeParse`** sees the request, the raw path parameters and
  `ctx.route`. There is no body, query or validated headers yet.
- **`beforeValidation`** also sees `ctx.body`, parsed but not yet
  checked: `unknown` for JSON. A hook here may normalize it, for example
  trim strings or rename a legacy field. What it returns under `body` is
  what gets validated. This is also where a webhook signature is checked;
  see
  [Request bodies](/docs/concepts/request-bodies/#raw-bytes-for-signatures).
- **`beforeHandle`** sees the validated request. A reusable hook here
  states what it needs with `Requires`; see
  [Context](/docs/concepts/context/#stating-what-a-hook-needs).

A `Response` returned from any of them skips the rest, handler included,
but still goes through `beforeResponse` and `afterResponse`.

## `beforeResponse`

A `beforeResponse` hook sees the response as `ctx.res` and may replace it
by returning another `Response`. It runs for every response: a handler's
result, a hook's early response, and error responses too.

A response a hook returns here is not checked against the route's
response map and is not in the OpenAPI document. If clients should know
about it, annotate the hook with
[`documented()`](/docs/packages/openapi/#documenting-hooks).

A `beforeResponse` hook that throws goes to `onError` like any stage. The
hooks after it then run over the error response; the ones before it do not
run again.

```ts twoslash
import { hook } from "@tetsujs/core";

export const noStore = hook.beforeResponse((ctx) => {
  if (ctx.res.status >= 400) return;

  const res = new Response(ctx.res.body, ctx.res);

  res.headers.set("cache-control", "no-store");

  return res;
});
```

To add a header only, `ctx.out.headers` is simpler: it is applied to
every response. Returning anything other than a `Response` from this slot
does nothing.

This is the last place where you can read the body. To audit it, clone
the response: `void ctx.res.clone().text().then(…)`. A clone of a streamed
body holds every chunk until it is read, so audit a stream where it is
produced.

## `afterResponse`

`afterResponse` hooks observe. They run on every outcome, errors
included, and nothing they return changes the response. Use them for logs
and metrics.

An observer runs as the response goes to Bun. Its synchronous part adds
to the response's latency; the promise it returns is not awaited. Two
rules apply:

- `ctx.res` has the status and headers but no way to read the body.
  Reading it is a compile error.
- Read what you need from the request and the response before the first
  `await`. After it, the response may be sent, and a header or the client
  address nobody read before is gone.

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

`performance.now() - ctx.startedAt` is how long the request has been in
the framework so far.

The observers of one request all start in order, without waiting for
each other. One that throws or rejects is reported to
`reportError`, or to the console, and the others still run. It does not
reach `onError`: the response has already gone, so there is nothing left
to answer. Work whose failure must fail the request, such as a required
audit record, belongs in `beforeResponse` or the handler.

## `onError`

An `onError` hook receives `ctx.error` and may answer it with a
`Response`. Returning nothing passes the error on; returning a plain object
is a compile error.

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

The error response then goes through `beforeResponse` and `afterResponse`
like any other. [Errors](/docs/concepts/errors/#onerror-hooks) covers the
order of `onError` hooks, what answers when none does, and an error format
for the whole application.

## Synchronous hooks

A request runs through the stages as plain function calls and becomes
asynchronous only at the first stage that returns a promise. A hook that
only reads a header is best written without `async`: it then costs a
function call and nothing more.
