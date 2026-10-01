---
title: Hook slots
description: The lifecycle slots in order, what ctx holds in each, what a return value and a throw do, the hook factories, Requires, and the checks.
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
| `beforeValidation` | after the body is parsed, before any schema runs | the above, `body` as parsed, `rawBody` when the route asks | as `beforeParse` | goes to `onError` |
| `beforeHandle` | after validation, right before the handler | the above, with `params`, `query`, `headers`, `cookies` and `body` validated | as `beforeParse` | goes to `onError` |
| `beforeResponse` | once the response exists: after the handler, a short-circuit or an error | `res: Response`; validated parts and hook fields optional | a `Response` replaces `ctx.res`; anything else is ignored | goes to `onError`; the remaining hooks run on the error response |
| `afterResponse` | as the response goes to Bun, on every outcome | `res: SentResponse`, without the body; validated parts and hook fields optional | ignored; a promise is not awaited | reported, `source: "afterResponse"` |
| `onError` | when a stage throws | `error: unknown`; validated parts and hook fields optional | a `Response` answers; nothing passes the error on | reported, `source: "onError"`; the next hook tries |

`parse` reads the body when the route declares `schema.body`, `bodyType`
or `rawBody`, and fails with `400` or `413`. `validate` checks every
declared part at once and fails with `422`.

- **Order.** Slots run in lifecycle order, whatever order they are written
  in. Inside a slot, the array order is the run order. Application hooks
  run first, then each group's from the outermost in, then the route's.
  `onError` runs the other way, from the route outwards.
- **Short-circuit.** A `Response` returned before the handler skips the
  remaining stages and the handler. It still goes through
  `beforeResponse`, `ctx.out.headers` and `afterResponse`. Build a new one
  on every call: a body can be read only once.
- **`beforeResponse`** sees every response, error responses included. Each
  hook runs at most once per request: if one throws, the error response
  continues from the next hook.
- **`afterResponse`** hooks start in order without waiting for each other.
  Their synchronous part adds to the response's latency. Read what you
  need from `ctx.req` and `ctx.res` before the first `await`.
- **`404`, `405` and `OPTIONS`** run the application's hooks only.
- **A successful WebSocket handshake** runs no response hooks: there is no
  response.

## What a slot guarantees

`SlotBases[slot]` is what an unannotated hook's `ctx` is typed as. It is
also the most a group or application hook may require, besides what the
hooks before it at the same level contribute.

| Slot | `SlotBases[slot]` |
| --- | --- |
| `beforeParse` | `BaseCtx & { params: Record<string, string> }` |
| `beforeValidation` | `BaseCtx & { params: Record<string, string>; body: unknown }` |
| `beforeHandle` | `BaseCtx` |
| `beforeResponse` | `BaseCtx & { res: Response }` |
| `afterResponse` | `BaseCtx & { res: SentResponse }` |
| `onError` | `BaseCtx & { error: unknown }` |

`BaseCtx` is described in [Context fields](/docs/reference/context/).

## Factories

`hook` has one factory per slot: `hook.beforeParse`,
`hook.beforeValidation`, `hook.beforeHandle`, `hook.beforeResponse`,
`hook.afterResponse` and `hook.onError`. Each takes a function of `ctx` and
returns a hook typed with what it requires (its `ctx` parameter, or the
slot's base when unannotated) and what it contributes (its return type).
Only a hook made by a factory can be mounted.

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

What a returned object contributes:

- its own enumerable fields, typed in every later hook and in the handler.
  Return a plain object literal: a class instance's methods and getters
  live on its prototype and are not copied;
- optional fields when the hook may also return nothing
  (`return user ? { user } : undefined`);
- never `req`, `server`, `out`, `route`, `res`, `error`, `startedAt` or
  `rawBody`: the pipeline owns them and drops them from a returned object.

A `Response` contributes nothing; it short-circuits instead. An `onError`
hook returns a `Response` or nothing; returning an object is a compile
error.

A returned `cookies` object is checked like the request's cookies: under
a signed name, a value whose signature does not hold is dropped.

## `Requires`

```ts
type Requires<T extends object> = BaseCtx & T;
```

A reusable hook declares what it needs instead of where it sits. Mounting
it where nothing provides that is a compile error naming the missing
field:

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
| `HookSlotError` | a hook sits in a slot other than its own, its type was widened to `AnyHook`, or a function is not wrapped by a `hook.*` factory |
| `HookRequirementError` | a hook requires a field nothing before it provides; the message names it |
| `HookStackError` | a slot holds a widened array instead of a tuple, such as `const shared = [auth]` without `as const` |
| `HooksIndexError` | `hooks` is typed with an index signature, so its slots cannot be checked |

What `createApp` refuses at startup is listed in
[`createApp`](/docs/reference/create-app/#checked-at-startup).

## Types

| Type | |
| --- | --- |
| `Hook<Slot, Req, Ext>` | a hook: its slot, what it requires, what it contributes |
| `AnyHook` | any hook |
| `SlotName` | `"beforeParse" \| "beforeValidation" \| "beforeHandle" \| "beforeResponse" \| "afterResponse" \| "onError"` |
| `SlotBases` | what each slot guarantees on its own |
| `SentResponse` | `Response` without its body |
| `HooksConfig`, `GroupHooks` | hooks keyed by slot |
| `MergedHooks` | the chains of a route table entry, every slot present |
| `HandlerCtx`, `ResponseCtx`, `ErrorCtx` | the context of a route's handler, response-slot hook, `onError` hook |
