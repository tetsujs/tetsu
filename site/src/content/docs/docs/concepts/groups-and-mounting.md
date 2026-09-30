---
title: Groups and mounting
description: Groups add a path prefix and hooks to everything under them; application hooks run for every request; and a few habits keep what runs for a route visible where it is mounted.
sidebar:
  order: 5
---

A group mounts controllers under a path prefix and adds hooks to every
route below it; the application has hooks of its own that run for every
request. This page covers both, the order their hooks run in, and the
habits that keep hook mounting readable.

## Groups

`group(prefix, { hooks, children })` joins its prefix onto every route of
its children, which are controllers, routes or other groups:

```ts twoslash
import { controller, hook, HttpError, route } from "@tetsujs/core";
const notesController = controller("Notes", () => ({
  list: route({ method: "GET", path: "/notes", handler: () => [] }),
}));
const statsController = controller("Stats", () => ({
  get: route({ method: "GET", path: "/stats", handler: () => ({}) }),
}));
// ---cut---
import { createApp, group } from "@tetsujs/core";

const adminOnly = hook.beforeParse((ctx) => {
  if (ctx.req.headers.get("x-role") !== "admin") throw new HttpError(403);
});

createApp({
  routes: group("/api", {
    children: [
      notesController(),
      group("/admin", {
        hooks: { beforeParse: [adminOnly] },
        children: [statsController()],
      }),
    ],
  }),
});
```

The routes are `GET /api/notes` and `GET /api/admin/stats`, and only the
second runs `adminOnly`. A route declared at `/` under a group answers the
prefix itself.

A prefix follows the rules of a path and a few more: it is not `/` alone,
which would mount nothing, it has no `*`, and it declares no `:params`. A
parameter in a prefix would exist at runtime and never in `ctx.params`,
since a controller is typed where it is written, not where it is mounted —
and a route's own `params` schema would then strip it. Each of these is a
compile error on a literal and an error at startup otherwise.

Groups nest only through `group()`. A controller never contains another
controller, so the whole shape of the API — prefixes, protected zones,
hook order — is written in one place.

## Application hooks

`createApp({ hooks })` takes hooks keyed by slot, like a route and a group.
They run for every request the application answers:

```ts twoslash
declare const routes: object;
// ---cut---
import { createApp } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";

const id = requestId();
const browser = cors({ origin: "https://app.example.com" });
const log = accessLog();

createApp({
  hooks: {
    beforeParse: [id, browser],
    afterResponse: [log],
  },
  routes,
});
```

For a request that matched a route, the chains are joined outermost-first
in every slot: the application's hooks, then each enclosing group's from
the outside in, then the route's own. `onError` is the one slot joined the
other way — route first, application last — so the most specific hook maps
an error before the general ones.

## Requests no route answered

A `404`, a `405` and an `OPTIONS` preflight run through the lifecycle too,
but with the application's hooks alone. No group's hooks run for them,
because no route of the group answered.

This is deliberate. Application-wide observers see requests nothing
handled, so a flood of `404`s shows up in the access log and can be rate
limited there. A CORS hook on the application can answer a preflight. And
a zone's guard does not refuse a browser's preflight before the CORS
headers are on it — an authentication hook on `/admin` would otherwise
turn every preflight to `/admin` into a `401` the browser cannot read.
That is why `cors()` belongs on the application, not on a group.

The `404` and `405` also reach the application's `onError` hooks, as an
`HttpError`, so one hook sets the error format for everything the
application answers.

## What a level sees

A group's hooks, and the application's, run for routes they have never
seen, so the compiler cannot give them a route's schemas or its hooks'
fields. What it can give them is what the hooks before them **at the same
level** contributed — earlier in the same slot, or in any slot that runs
before theirs. Those are written in the same object, and always run first:

```ts twoslash
declare const routes: object;
// ---cut---
import type { Requires } from "@tetsujs/core";
import { createApp, hook } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";

const id = requestId();

const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => ({
  tenant: ctx.req.headers.get("x-tenant") ?? "public",
}));

createApp({
  hooks: { beforeParse: [id, scope] },
  routes,
});
```

A hook still declares what it reads, with `Requires`; the level checks
that something before it provides that. `scope` is accepted because `id`
comes first. Written the other way round, it is a compile error naming the
missing field:

```ts twoslash
declare const routes: object;
import type { Requires } from "@tetsujs/core";
import { createApp, hook } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
const id = requestId();
const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => ({
  tenant: ctx.req.headers.get("x-tenant") ?? "public",
}));
// ---cut---
// @errors: 2322
createApp({
  hooks: { beforeParse: [scope, id] },
  routes,
});
```

A hook in a later slot of the same level sees the same fields: a
`beforeHandle` hook of the application may require what its `beforeParse`
hooks returned. In `beforeResponse`, `afterResponse` and `onError` they
are optional — `Requires<{ requestId?: string }>` — since those slots run
on every outcome, and the hook that adds a field may never have run. A
group hook that asks for something only a route could provide, such as a
validated body or a route hook's field, is a compile error.

What a group hook returns does not reach the handlers' types, for the
reason [Context](/docs/concepts/context/#why-a-group-hooks-field-is-not-in-the-handlers-type)
explains.

## Mounting hooks

Everything that runs for a request is written out where it is mounted. A
few habits keep it that way.

### Make a hook once, in a named constant

Make a hook in a constant and mount it by name:
`const log = accessLog()`, then `afterResponse: [log]`. A package's
options stay out of the `hooks` object, and the slot reads as a list of
names. A factory called inside `hooks` makes a new instance every time the
code around it runs.

### Share hooks, not `hooks` objects

Two applications that log the same way import the same `id` and `log`,
and each lists them in its own slots. A set several places share is
written `as const` and spread into each slot where it is mounted:

```ts twoslash
import { hook } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";
const id = requestId();
const browser = cors({ origin: "https://app.example.com" });
const log = accessLog();
const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));
declare const routes: object;
// ---cut---
import { createApp } from "@tetsujs/core";

const common = { beforeParse: [id, browser], afterResponse: [log] } as const;

createApp({
  hooks: {
    beforeParse: [...common.beforeParse, auth],
    afterResponse: [...common.afterResponse],
  },
  routes,
});
```

Every slot stays a tuple, so the order is still checked, and the slot
still shows what runs before what. A set without `as const` is an array
whose element types are gone, and is refused where it is mounted:
nothing in it could be checked. `Object.assign` and spreading whole
`hooks` objects replace a slot instead of joining it. For every route
under a prefix, a group's `hooks` is the shared set.

### State lives in the instance

A hook with state keeps it in the instance. One `rateLimit()` mounted on
two groups shares its counters between them; for separate budgets, make
two. A hook made inside a controller is that controller's own, and one
whose state is shared is made in the composition root and passed in — see
[Controllers](/docs/concepts/controllers/#hooks-and-dependencies).

### An instance runs once per request

The same hook mounted twice in one route's chain — on a group and on a
route under it, or twice in one slot — is refused at startup. There is no
case where that is meant: an authentication hook would go to the database
twice, a rate limit would count the request twice. A hook wanted twice
with separate state is two instances, and those are not the same hook.

### Order within a slot is yours

The compiler checks what a hook needs — `scope` after `id` — not what
should come first. The rule to keep: `cors()` goes before every hook that
can refuse, so that the refusal carries the headers a browser needs to
read it. A hook that never refuses, such as `requestId()` or
`arrivalLog()`, may go before it, and then a preflight gets its id and its
log line too.

### A package is one hook

A hook package is a function that takes options and returns one hook,
mounted in its slot like any other; there is no plugin system. Writing
your own, return the hook from a function that takes the options — see
[Writing a hook package](/docs/guides/writing-a-hook-package/).
