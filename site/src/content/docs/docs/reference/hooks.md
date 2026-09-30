---
title: Hook slots
description: The lifecycle slots in order — when each runs, what ctx holds there, what a return value and a throw do — the hook factories, Requires, and the compile-time and startup checks.
sidebar:
  order: 3
---

A hook is a function bound to one slot of the request lifecycle by a
`hook.<slot>()` factory. This page lists the slots, the factories and the
checks. [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) explains the
model.

```
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse      (onError on failure)
```

## Slots

| Slot | Runs | `ctx` has, on a route | A return value | A throw |
| --- | --- | --- | --- | --- |
| `beforeParse` | first, before the body is read | `req`, `server`, `out`, `route`, `startedAt`, `params` as strings | an object joins `ctx`; a `Response` ends the request; nothing goes on | goes to `onError` |
| `beforeValidation` | after the body is parsed, before any schema runs | the above, `body` as parsed (`unknown`), `rawBody` when the route asks | as `beforeParse` | goes to `onError` |
| `beforeHandle` | after validation, right before the handler | the above, with `params`, `query`, `headers`, `cookies` and `body` validated | as `beforeParse` | goes to `onError` |
| `beforeResponse` | once the response exists — after the handler, a short-circuit or an error | `res: Response`; validated parts and hook fields optional | a `Response` replaces `ctx.res`; anything else is ignored | goes to `onError`; the rest of the chain runs over the error response |
| `afterResponse` | as the response goes to Bun, on every outcome | `res: SentResponse`, without the body; validated parts and hook fields optional | ignored; a promise is not awaited | reported, `source: "afterResponse"` |
| `onError` | when a stage throws | `error: unknown`; validated parts and hook fields optional | a `Response` answers; nothing passes the error on | reported, `source: "onError"`; the next hook tries |

Between the slots, `parse` reads the body when the route declares
`schema.body`, `bodyType` or `rawBody` (`400` or `413` on failure), and
`validate` checks every declared part at once (`422`).

- **Order.** Slots run in lifecycle order whatever order they are written
  in. Inside a slot, the array is the order. Across levels, the
  application's hooks run first, then each group's from the outermost in,
  then the route's — except `onError`, which runs from the route outwards.
- **Short-circuit.** A `Response` returned from a `before*` hook before
  the handler skips the remaining stages and the handler, and still passes
  `beforeResponse`, `ctx.out.headers` and `afterResponse`. Build it on
  every call: its body is single-use.
- **`beforeResponse`** sees every response, error responses included.
  Each of its hooks starts at most once per request: when one throws, the
  error response continues from the next hook. A replaced response's body
  is cancelled.
- **`afterResponse`** hooks start in order, each without waiting for the
  one before, once the response is ready. Their synchronous part is part
  of the response's latency. What they need of `ctx.req` and `ctx.res`
  they read before their first `await`.
- **`onError`** returns a `Response` or nothing; an object is a compile
  error.
- **Protocol responses** — `404`, `405`, `OPTIONS` — run the
  application's hooks only.
- **A WebSocket handshake** that succeeds runs no response hooks: there is
  no response.

## What a slot guarantees on its own

What an unannotated hook's `ctx` is typed as, and the most a group's or the
application's hook may require:

| Slot | `SlotBases[slot]` |
| --- | --- |
| `beforeParse` | `BaseCtx & { params: Record<string, string> }` |
| `beforeValidation` | `BaseCtx & { params: Record<string, string>; body: unknown }` |
| `beforeHandle` | `BaseCtx` |
| `beforeResponse` | `BaseCtx & { res: Response }` |
| `afterResponse` | `BaseCtx & { res: SentResponse }` |
| `onError` | `BaseCtx & { error: unknown }` |

A hook of a group or the application may also require what the hooks
before it at the same level contribute — earlier in its slot, or in a slot
that runs before its own. In `beforeResponse`, `afterResponse` and
`onError` those fields are optional. `BaseCtx` is described in
[Context fields](/docs/reference/context/).

## Factories

`hook` has one factory per slot: `hook.beforeParse`,
`hook.beforeValidation`, `hook.beforeHandle`, `hook.beforeResponse`,
`hook.afterResponse`, `hook.onError`.

```ts
hook.beforeParse(fn: (ctx) => object | Response | void | Promise<…>): Hook<"beforeParse", Req, Ext>
hook.onError(fn: (ctx) => Response | void | Promise<…>): Hook<"onError", Req, unknown>
```

A factory returns `{ slot, fn }`, typed with what the hook requires (its
`ctx` parameter, or the slot's base when it is not annotated) and what it
contributes (its return type). A bare function is not accepted where a
hook is mounted.

```ts twoslash
import { hook, HttpError, route } from "@tetsujs/core";
interface User { id: number; role: "admin" | "member" }
declare const sessions: { verify(header: string | null): Promise<User | undefined> };
// ---cut---
const auth = hook.beforeParse(async (ctx) => {
  const user = await sessions.verify(ctx.req.headers.get("authorization"));

  if (!user) throw new HttpError(401);

  return { user };
});

route({
  method: "GET",
  path: "/me",
  hooks: { beforeParse: [auth] },
  handler: (ctx) => ctx.user,
  //                    ^?
});
```

What a return value contributes:

- the fields of the object returned, typed in every later hook and in the
  handler;
- optional fields when the hook may also return nothing
  (`return user ? { user } : undefined`);
- nothing for a `Response`, which short-circuits instead;
- never `req`, `server`, `out`, `route`, `res`, `error`, `startedAt`,
  `rawBody`, `__proto__`, `constructor` or `prototype`: the pipeline owns
  them, and the runtime drops them;
- only own enumerable string keys. Return a plain object literal: a class
  instance's methods and getters live on its prototype and never arrive.

A returned `cookies` object under a signed name is checked like the
request's cookies, in every slot.

## `Requires`

```ts
type Requires<T extends object> = BaseCtx & T;
```

A hook that is reused declares what it needs instead of where it sits.
Mounting it where nothing provides that is a compile error naming the
missing field:

```ts twoslash
import { hook, HttpError, route } from "@tetsujs/core";
import type { Requires } from "@tetsujs/core";
interface User { id: number }
interface Order { id: string; ownerId: number }
declare const orders: { find(id: string): Promise<Order | undefined> };
declare const sessions: { verify(): Promise<User> };
const auth = hook.beforeParse(async () => ({ user: await sessions.verify() }));
// ---cut---
const withOrder = hook.beforeHandle(
  async (ctx: Requires<{ params: { id: string }; user: User }>) => {
    const order = await orders.find(ctx.params.id);

    if (!order || order.ownerId !== ctx.user.id) throw new HttpError(404);

    return { order };
  },
);

route({
  method: "POST",
  path: "/orders/:id/cancel",
  hooks: { beforeParse: [auth], beforeHandle: [withOrder] },
  handler: (ctx) => ({ cancelled: ctx.order.id }),
});
```

## Checks

At compile time, where the hooks are mounted:

| Error | When |
| --- | --- |
| `HookSlotError` | a hook sits in a slot other than its own |
| `HookRequirementError` | a hook requires a field nothing before it provides; the message names it |
| `HookStackError` | a slot holds an array type rather than a tuple — `const shared = [auth]` without `as const` |
| `HooksIndexError` | `hooks` is typed with an index signature, so none of its slots can be checked |
| a bare function | a function not wrapped by a `hook.*` factory |

At startup, `createApp` refuses a key that is not a slot, a slot that is not
a list, an element that is not a hook, a hook in a slot other than its own,
`hooks` given as a list, and the same hook instance mounted twice in one
route's chain.

## Types

| Type | |
| --- | --- |
| `Hook<Slot, Req, Ext>` | a hook: its slot, what it requires, what it contributes |
| `AnyHook` | the widest hook type |
| `SlotName` | `"beforeParse" \| "beforeValidation" \| "beforeHandle" \| "beforeResponse" \| "afterResponse" \| "onError"` |
| `SlotBases` | what each slot guarantees on its own |
| `SentResponse` | `Response` without its body: `status`, `statusText`, `headers`, `ok`, `redirected`, `type`, `url` |
| `HooksConfig`, `GroupHooks` | hooks keyed by slot |
| `MergedHooks` | the chains of a route table entry, every slot present |
| `HandlerCtx`, `ResponseCtx`, `ErrorCtx` | the context a handler, a response-slot hook and an `onError` hook of a route receive |
| `Requires<T>` | `BaseCtx & T` |
