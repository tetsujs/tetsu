---
title: Key concepts
description: The whole model of Tetsu on one page — the application, controllers, routes, hooks in slots, the context and errors.
---

Tetsu has few moving parts, and each is an ordinary value. This page goes
through them in the order a request meets them, with a link to the full
page for each.

## The application is data

`createApp` returns plain data — the routes, a fallback for unmatched paths
and a WebSocket handler — and `Bun.serve` takes it as it is:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const health = controller("Health", () => ({
  live: route({ method: "GET", path: "/livez", handler: () => "ok" }),
}));

const app = createApp({ routes: health() });

Bun.serve({ ...app, port: 3000 });
```

There is no server object of the framework's own. Routing is Bun's native
router, `ctx.server` is Bun's server, and starting and stopping it is up to
you. Graceful shutdown is a package:
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/).

## Controllers take their dependencies as arguments

A controller is a name and a function from its dependencies to its routes.
You call it once, where the application is wired:

```ts twoslash
interface Note { id: number; text: string }
class NoteStore { all(): Note[] { return []; } }
// ---cut---
import { controller, createApp, route } from "@tetsujs/core";

const notesController = controller("Notes", (notes: NoteStore) => ({
  list: route({ method: "GET", path: "/notes", handler: () => notes.all() }),
}));

const notes = new NoteStore();

export default createApp({ routes: notesController(notes) });
```

There is no container, no decorator and no registry. The name matters: the
OpenAPI document builds each `operationId` from it.
[Controllers and dependencies](/docs/concepts/controllers/)

## A route declares what it needs

`route()` takes a method, a path, schemas for the parts of the request, hooks
by slot and the handler. Its context is typed from what the route itself
declares; hooks of its groups and of the application run for it too, but add
nothing to its types. The compiler checks the path against what Bun's router
matches.
[Routes and handlers](/docs/concepts/routes-and-handlers/)

## Hooks sit in fixed slots

A request passes through named stages. There is no `next()`: each hook is
made for a slot, and the slot says when it runs.

```
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse      (onError on failure)
```

What a hook returns is added to `ctx`. To refuse the request, it throws.

```ts twoslash
interface User { id: string }
declare const sessions: { verify(token: string | null): Promise<User | undefined> };
// ---cut---
import { hook, HttpError, route } from "@tetsujs/core";

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

`auth` sits in `beforeParse`, so an anonymous request is refused before its
body is read. [Lifecycle hooks](/docs/concepts/lifecycle-hooks/)

## The context has only what exists

`ctx` is never annotated. A field is on it exactly when it exists at that
point: the parameters of the path, the body once it is validated, `user`
after the hook that returned it. A hook that needs a field declares it with
`Requires`, and mounting it where nothing provides the field is a compile
error:

```ts twoslash
interface User { id: string }
// ---cut---
import type { Requires } from "@tetsujs/core";
import { hook, route } from "@tetsujs/core";

const audit = hook.beforeHandle((ctx: Requires<{ user: User }>) => {
  console.log("request by", ctx.user.id);
});

// @errors: 2322
route({
  method: "GET",
  path: "/reports",
  hooks: { beforeHandle: [audit] },
  handler: () => [],
});
```

[Context and its types](/docs/concepts/context/)

## Validation is Standard Schema

`params`, `query`, `headers`, `cookies` and `body` are each validated by the
schema you give them: Zod, Valibot, ArkType, or TypeBox through an adapter.
All parts are checked at once, and a failure is a `422` listing every issue.
A `response` schema checks what the route sends back.
[Validation](/docs/concepts/validation/) ·
[Responses](/docs/concepts/responses/)

## One shape for every error

A thrown `HttpError`, a failed validation, an unmatched path, a body over
the limit — every failure is answered in one shape:

```json
{ "status": 404, "message": "Not Found", "error": "NOT_FOUND" }
```

An `onError` hook on the application sees every failure and can change the
format. An error that can no longer become a response, because the response
was already sent, goes to `reportError`. [Errors](/docs/concepts/errors/)

## Packages are hooks

There is no plugin system. CORS, request ids, access logs, rate limits and
security headers are packages, each a function that returns a hook, mounted
in its slot like your own:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { accessLog } from "@tetsujs/request-log";
import { requestId } from "@tetsujs/request-id";
declare const routes: Parameters<typeof createApp>[0]["routes"];
// ---cut---
createApp({
  hooks: {
    beforeParse: [cors({ origin: "https://app.example.com" }), requestId()],
    afterResponse: [accessLog()],
  },
  routes,
});
```

[Groups and mounting](/docs/concepts/groups-and-mounting/) ·
[Packages](/docs/packages/core/)
