---
title: Controllers and dependencies
description: A controller is a name and a function from its dependencies to its routes, wired by hand in one composition root.
sidebar:
  order: 2
---

A controller groups the routes of one part of an API and gives them what
they depend on. This page covers `controller()`, why its name matters, why
it is a function rather than a class, and where the application is wired.

## Declaring a controller

`controller(name, build)` takes a name and a function from dependencies to
routes, and returns that function, named. The dependencies are whatever the
function declares for its parameter — an interface is the usual way to
write it:

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

Calling it with the dependencies gives an ordinary object whose fields are
the routes. The application reads those fields and nothing else — not the
file name, not a class, not metadata. A controller without dependencies
takes none, and is called with none:

```ts twoslash
import { controller, route } from "@tetsujs/core";
// ---cut---
export const healthController = controller("Health", () => ({
  live: route({ method: "GET", path: "/live", handler: () => "ok" }),
}));

healthController();
```

Because the result is plain data, a handler is unit-tested by calling it:
`ordersController(fakes).get.handler(testCtx({ params: { id: "1" } }))`.
[Testing](/docs/guides/testing/) covers `testCtx()`.

## The name is a contract

The name is not a label for logs. [`@tetsujs/openapi`](/docs/packages/openapi/)
builds every `operationId` from it and the route's field — `list` in
`"Orders"` becomes `ordersList` — and a client generated from the document
names its methods after those. Renaming the variable that holds the
controller changes nothing a client sees; changing the name does, and it
is written where a reviewer sees it change. A route that needs an id of its
own states it with `docs: { operationId }`.

The name is also what `ctx.route.controller` reports, so a log line and a
metric name the same controller the document does.

Two controllers of one application cannot share a name: their
`operationId`s would collide, so `createApp()` refuses it at startup. Two
versions of an API are therefore two names over one body:

```ts twoslash
interface User { id: string; name: string }
interface UserService { all(): User[] }
// ---cut---
import { controller, createApp, group, route } from "@tetsujs/core";

interface UsersDeps {
  readonly users: UserService;
}

const users = ({ users }: UsersDeps) => ({
  list: route({ method: "GET", path: "/users", handler: () => users.all() }),
});

export const usersV1 = controller("UsersV1", users);
export const usersV2 = controller("UsersV2", users);

declare const service: UserService;

createApp({
  routes: [
    group("/v1", { children: [usersV1({ users: service })] }),
    group("/v2", { children: [usersV2({ users: service })] }),
  ],
});
```

An empty name is refused when `controller()` is called.

## Why a function and not a class

A route reads what it declares — its hooks, its schemas, its body limit —
at the moment it is declared. A function has its dependencies from its
first line, so a hook built from one of them is built from the real thing.

A class does not. Its fields are initialized before the constructor's
parameters are assigned, so a route declared as a field that builds a hook
from a constructor argument builds it from `undefined`. The compiler
catches the direct case and reports it as TS2729:

```ts twoslash
interface User { id: string }
interface Sessions { find(token: string): User | undefined }
import { hook, HttpError, route } from "@tetsujs/core";
const authenticate = (sessions: Sessions) =>
  hook.beforeParse((ctx) => {
    const user = sessions.find(ctx.req.headers.get("authorization") ?? "");
    if (!user) throw new HttpError(401);
    return { user };
  });
// ---cut---
// @errors: 2729
class NotesController {
  constructor(private readonly sessions: Sessions) {}

  list = route({
    method: "GET",
    path: "/notes",
    hooks: { beforeParse: [authenticate(this.sessions)] },
    handler: (ctx) => ctx.user.id,
  });
}
```

The framework still reads routes from any object, so a class instance can
be mounted, and it is named after its class. A hook whose body reads
`this.sessions` only when it runs avoids the trap. `controller()` avoids
the question.

Services stay classes. A service is behaviour other code calls — a store,
a mailer, a payment client — and a class is a good way to write one. A
controller is a declaration, made once at startup.

## The composition root

The application is wired by hand, in one place: every service is built
there once and handed to the controllers that need it. There is no
container and no registration; the file that does the wiring is the whole
of it.

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

`buildApp` takes the database instead of opening it, so `main.ts` opens a
file and the tests open one in memory. The whole example is
[`examples/app`](https://github.com/tetsujs/tetsu/blob/main/examples/app/app.ts),
a small notes API on `bun:sqlite`.

The code that wires a controller can read its dependencies' type back
instead of importing the interface: `Parameters<typeof notesController>[0]`.

## Hooks and dependencies

A hook that needs a service is built inside the controller, from the
dependency it was given, next to the routes that mount it. In the notes
example the authentication hook is made from `sessions`; `main.ts` wires
services, not hooks:

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
limit budget for the whole API is one `rateLimit()` instance; made inside
each controller, it would be one budget per controller. Such a hook is made
once in the composition root and passed in like a service:

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

[Groups and mounting](/docs/concepts/groups-and-mounting/#mounting-hooks)
has the rest of the habits that keep shared state where it is meant to be.

## Handing a controller the application

A controller is data, and the application is built from that data, so a
controller that wants to describe the application — list its routes,
document it, register them with a metrics system — cannot receive it as a
dependency: it does not exist yet. `onMount` closes the loop. A controller
that has a method under this symbol is handed the built application once,
after the route table is compiled and before `createApp()` returns:

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

It is a symbol rather than a method name such as `init`, so it cannot
collide with a method a controller already has. It runs at startup: a
controller that throws there takes the process down instead of failing on
a request. This is how `docs()` from `@tetsujs/openapi` builds the document
from the application it is mounted in.
