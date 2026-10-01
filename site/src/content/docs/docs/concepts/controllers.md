---
title: Controllers and dependencies
description: A controller is a name and a function from its dependencies to its routes, wired by hand in one composition root.
sidebar:
  order: 2
---

A controller groups the routes of one part of an API and gives them the
services they depend on.

## Declaring a controller

`controller(name, build)` takes a name and a function from dependencies to
routes, and returns a function that takes the same dependencies. Declare
the dependencies as the function's parameter, usually with an interface:

```ts twoslash
interface Order { id: string; total: number }
interface OrderService {
  all(): Order[];
  find(id: string): Order | undefined;
}
// ---cut---
import { controller, httpError, route } from "@tetsujs/core";

export interface OrdersDeps {
  readonly orders: OrderService;
}

export const ordersController = controller("Orders", ({ orders }: OrdersDeps) => ({
  list: route({ method: "GET", path: "/orders", handler: () => orders.all() }),

  get: route({
    method: "GET",
    path: "/orders/:id",
    handler: (ctx) => {
      const order = orders.find(ctx.params.id);

      if (!order) throw httpError(404, "ORDER_NOT_FOUND");

      return order;
    },
  }),
}));
```

Calling it with the dependencies gives a plain object whose fields are the
routes, tagged with the controller's name. The application reads those
fields and nothing else. A controller without dependencies is called with
no arguments.

Because the result is plain data, you can unit-test a handler by calling
it: `ordersController(fakes).get.handler(testCtx({ params: { id: "1" } }))`.
[Testing](/docs/guides/testing/) covers `testCtx()`.

## The name is a contract

[`@tetsujs/openapi`](/docs/packages/openapi/) builds every `operationId`
from the controller's name and the route's field: `list` in `"Orders"`
becomes `ordersList`. A generated client names its methods after these, so
changing the name changes the client. Renaming the variable does not. To
set an id by hand, use `docs: { operationId }` on the route.

The name is also what `ctx.route.controller` reports in logs and metrics.

Two controllers in one application cannot share a name, and `createApp()`
refuses it at startup. To serve two versions of an API from one function,
declare it twice under two names: `controller("UsersV1", users)` and
`controller("UsersV2", users)`, each mounted under its own group.

## The composition root

Wire the application by hand, in one place. Build every service there once
and pass it to the controllers that need it. There is no container and no
registration.

```ts twoslash
interface User { readonly id: string }
class NoteStore { constructor(readonly db: unknown) {} }
class Sessions { constructor(readonly tokens: ReadonlyMap<string, User>) {} }
import { controller, route } from "@tetsujs/core";
const notesController = controller("Notes", (deps: { notes: NoteStore; sessions: Sessions }) => ({
  list: route({ method: "GET", path: "/notes", handler: () => [] }),
}));
// ---cut---
import type { Database } from "bun:sqlite";
import { createApp, group } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";

export function buildApp(db: Database, tokens: ReadonlyMap<string, User>) {
  const notes = new NoteStore(db);
  const sessions = new Sessions(tokens);

  return createApp({
    hooks: { beforeParse: [requestId()], afterResponse: [accessLog()] },
    routes: group("/api", { children: [notesController({ notes, sessions })] }),
  });
}
```

`buildApp` takes the database instead of opening it, so `main.ts` can open
a file and the tests an in-memory one. The full example is
[`examples/app`](https://github.com/tetsujs/tetsu/blob/main/examples/app/app.ts),
a small notes API on `bun:sqlite`.

To get a controller's dependency type without importing the interface,
use `Parameters<typeof notesController>[0]`.

## Hooks and dependencies

A hook that needs a service is built inside the controller, from the
dependency it received:

```ts twoslash
interface User { readonly id: string }
interface Note { id: number; title: string }
interface NoteStore { list(owner: string): Note[] }
interface Sessions { find(token: string): User | undefined }
// ---cut---
import { controller, hook, HttpError, route } from "@tetsujs/core";

const authenticate = (sessions: Sessions) =>
  hook.beforeParse((ctx) => {
    const token = ctx.req.headers.get("authorization")?.replace(/^Bearer /, "");
    const user = token ? sessions.find(token) : undefined;

    if (!user) throw new HttpError(401);

    return { user };
  });

export const notesController = controller(
  "Notes",
  ({ notes, sessions }: { notes: NoteStore; sessions: Sessions }) => {
    const signedIn = authenticate(sessions);

    return {
      list: route({
        method: "GET",
        path: "/notes",
        hooks: { beforeParse: [signedIn] },
        handler: (ctx) => notes.list(ctx.user.id),
      }),
    };
  },
);
```

A hook whose state several controllers must share is different. One rate
limit for the whole API is one `rateLimit()` instance; made inside each
controller, it would be a separate limit per controller. Make such a hook
once in the composition root and pass it in like a service:

```ts twoslash
interface Note { id: number; title: string }
interface NoteStore { list(): Note[] }
declare const store: NoteStore;
// ---cut---
import { controller, createApp, route } from "@tetsujs/core";
import type { RateLimitHook } from "@tetsujs/rate-limit";
import { rateLimit } from "@tetsujs/rate-limit";

const notesController = controller("Notes", ({ notes, limit }: { notes: NoteStore; limit: RateLimitHook }) => ({
  list: route({
    method: "GET",
    path: "/notes",
    hooks: { beforeParse: [limit] },
    handler: () => notes.list(),
  }),
}));

const limit = rateLimit({
  limit: 100,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

createApp({ routes: notesController({ notes: store, limit }) });
```

See [Groups and mounting](/docs/concepts/groups-and-mounting/#mounting-hooks)
for more on where hooks and their state live.

## Why a function and not a class

A route reads its hooks and schemas when it is declared. A function has
its dependencies from its first line, so a hook built from one of them
gets the real service.

In a class, fields are initialized before the constructor's parameters are
assigned. A route declared as a field that builds a hook from a
constructor argument gets `undefined`. TypeScript reports the direct case
as error TS2729. A class instance can still be mounted, and it is named
after its class, but `controller()` avoids the problem.

Services can stay classes. A service is called by other code; a controller
is a declaration made once at startup.

## Handing a controller the application

A controller that needs the built application, for example to list or
document its routes, cannot get it as a dependency: the application does
not exist yet. Give the controller a method under the `onMount` symbol.
`createApp()` calls it once with the application, after the route table is
built and before it returns:

```ts twoslash
import type { App } from "@tetsujs/core";
import { controller, onMount, route } from "@tetsujs/core";

export const routesController = controller("Routes", () => {
  let mounted: App | undefined;

  return {
    [onMount]: (app: App) => {
      mounted = app;
    },
    list: route({
      method: "GET",
      path: "/routes",
      handler: () => mounted?.entries.map((entry) => `${entry.method} ${entry.path}`) ?? [],
    }),
  };
});
```

It runs at startup, so an error thrown there stops the process. This is
how `docs()` from `@tetsujs/openapi` builds its document.
