---
title: Groups and mounting
description: Groups add a path prefix and hooks to the routes under them, application hooks run for every request, and a few habits keep hook mounting readable.
sidebar:
  order: 5
---

A group mounts controllers under a path prefix and adds hooks to every
route below it. The application has hooks of its own that run for every
request.

## Groups

`group(prefix, { hooks, children })` adds its prefix to every route of its
children. Children are controllers, routes or other groups:

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
second runs `adminOnly`. A route with the path `/` inside a group answers
at the prefix itself.

A prefix follows the path rules, and also cannot be `/` alone, contain a
`*` or declare a `:param`. A controller is typed where it is written, so
a parameter from the prefix would never appear in `ctx.params`.

Groups nest only through `group()`; a controller never contains another
controller. The whole shape of the API is written in one place.

## Application hooks

`createApp({ hooks })` takes hooks keyed by slot, like a route and a
group. They run for every request the application answers:

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

For a matched route, each slot runs the application's hooks first, then
each group's from the outside in, then the route's own. `onError` runs
the other way, route first and application last, so the most specific
hook maps an error first.

## Requests no route answered

A `404`, a `405` and an `OPTIONS` preflight also go through the
lifecycle, but only with the application's hooks. Group hooks do not run
for them, because no route in the group matched.

This means application-wide logs and rate limits see requests nothing
handled, and a CORS hook on the application can answer a preflight. It
also keeps a group's guard from refusing a preflight: an authentication
hook on `/admin` would otherwise turn every preflight into a `401` the
browser cannot read. That is why `cors()` belongs on the application.

The `404` and `405` also reach the application's `onError` hooks as an
`HttpError`, so one hook sets the error format for everything.

## What a level sees

Group and application hooks run for routes they do not know, so they
cannot see a route's schemas or its hooks' fields. They can see what
earlier hooks **at the same level** returned, in the same slot or an
earlier one:

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

`scope` declares what it reads with `Requires`, and compiles because `id`
comes first. In the other order it is a compile error that names the
missing field. In `beforeResponse`, `afterResponse` and `onError` such
fields are optional, `Requires<{ requestId?: string }>`, since the hook
that adds them may not have run.

What a group hook returns does not reach the handlers' types, for the
reason [Context](/docs/concepts/context/#why-a-group-hooks-field-is-not-in-the-handlers-type)
explains.

## Mounting hooks

A few habits keep it clear what runs for each request.

**Make a hook once, in a named constant.** Write `const log = accessLog()`,
then `afterResponse: [log]`. The slot then reads as a list of names, and
you do not create a new instance each time the surrounding code runs.

**Share hooks, not `hooks` objects.** To reuse a set of hooks, declare it
`as const` and spread each slot where it is mounted:

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

Without `as const`, the array loses its element types, and mounting it is
a compile error. Spreading whole `hooks` objects, or `Object.assign`,
replaces a slot instead of joining it. For every route under a prefix,
use a group's `hooks`.

**State lives in the instance.** One `rateLimit()` mounted on two groups
shares one counter. For separate limits, make two instances. To share a
hook's state across controllers, make it in the composition root and pass
it in; see
[Controllers](/docs/concepts/controllers/#hooks-and-dependencies).

**An instance runs once per request.** The same hook mounted twice in one
route's chain, for example on a group and on a route under it, is refused
at startup.

**You choose the order within a slot.** The compiler checks what a hook
needs, not what should come first. Put `cors()` before every hook that
can refuse a request, so the refusal carries the headers a browser needs
to read it.

**A package is one hook.** A hook package is a function that takes
options and returns one hook; there is no plugin system. See
[Writing a hook package](/docs/guides/writing-a-hook-package/).
