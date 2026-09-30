---
title: Key concepts
description: The whole model of Tetsu on one page — the application, controllers, routes, hooks in slots, the context and errors.
---

Tetsu has few moving parts, and each is an ordinary value. This page walks
through all of them in the order a request meets them; each section links to
the page that covers it in full.

## The application is data

`createApp` returns an object — the routes, a fallback for unmatched paths,
a WebSocket handler — and `Bun.serve` takes it as it is. There is no server
object of the framework's own:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const health = controller("Health", () => ({
  live: route({ method: "GET", path: "/live", handler: () => "ok" }),
}));

const app = createApp({ routes: health() });

Bun.serve({ ...app, port: 3000 });
```

Because the application is data, starting and stopping it is yours:
`ctx.server` is Bun's real server, graceful shutdown is a package
([`@tetsujs/lifecycle`](/docs/packages/lifecycle/)), and routing is Bun's
native router — the framework has no router of its own to disagree with it.

## Controllers take their dependencies as arguments

A controller is a name and a function from its dependencies to its routes.
It is called once, in the one place where the application is wired — the
composition root:

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

There is no container, no decorator and no registry. The name is a contract:
the OpenAPI document builds each `operationId` from it, and generated clients
name their methods after those.
[Controllers and dependencies](/docs/concepts/controllers/)

## A route declares everything that runs for it

`route()` takes a method, a path, the schemas of the request parts, the hooks
and the handler. Nothing about a route is configured elsewhere, so reading
it shows what happens to a request:

```ts twoslash
interface Order { id: number }
declare const orders: { find(id: number): Order | undefined };
import { hook } from "@tetsujs/core";
const auth = hook.beforeParse(() => ({ user: { id: "ada" } }));
// ---cut---
import { route } from "@tetsujs/core";
import { z } from "zod";

route({
  method: "GET",
  path: "/orders/:id",
  schema: { params: z.object({ id: z.coerce.number() }) },
  hooks: { beforeParse: [auth] },
  handler: (ctx) => orders.find(ctx.params.id),
});
```

Paths are checked by the compiler against what Bun's router actually
matches. [Routes and handlers](/docs/concepts/routes-and-handlers/)

## Hooks sit in fixed slots

A request passes through named stages. There is no `next()` and no onion:
each hook has a slot, and the slot says when it runs.

```
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse      (onError on failure)
```

A hook is made for a slot and mounted by slot. What it returns joins `ctx`;
to stop the request it throws.

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

`auth` runs before the body is read, so an anonymous request is refused
without reading it. [Lifecycle hooks](/docs/concepts/lifecycle-hooks/)

## The context tells the truth

`ctx` is never annotated. A field is on it exactly when it exists at that
point of the request: parameters from the path, the body only once it was
validated, `user` only after the hook that returned it. A hook that needs a
field says so with `Requires`, and mounting it where nothing provides that
field is a compile error:

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
schema you give them — Zod, Valibot, ArkType, or TypeBox through an adapter.
All parts are checked at once; a failure is answered with `422` and every
issue. `response` checks what leaves, and lists the statuses the route
answers with. [Validation](/docs/concepts/validation/) ·
[Responses](/docs/concepts/responses/)

## One shape for every error

A thrown `HttpError`, a failed validation, an unmatched path or method, a
body over the limit — every failure is answered in one shape:

```json
{ "status": 404, "message": "Not Found", "error": "NOT_FOUND" }
```

An `onError` hook on the application sees all of them and can replace the
format for the whole application. What cannot become a response — an error
after the response was sent — goes to `reportError`.
[Errors](/docs/concepts/errors/)

## Packages are hooks

There is no plugin system. A package is a function that takes options and
returns one hook, mounted in its slot like your own:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { accessLog } from "@tetsujs/request-log";
import { requestId } from "@tetsujs/request-id";
declare const routes: Parameters<typeof createApp>[0]["routes"];
// ---cut---
const browser = cors({ origin: "https://app.example.com" });
const id = requestId();
const log = accessLog();

createApp({
  hooks: { beforeParse: [browser, id], afterResponse: [log] },
  routes,
});
```

[Groups and mounting](/docs/concepts/groups-and-mounting/) ·
[Packages](/docs/packages/core/)
