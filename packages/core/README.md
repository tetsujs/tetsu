<!-- Generated from the repository's README.md by scripts/readme.ts: edit that one. -->

# Tetsu

Tetsu (鉄, "iron") is an HTTP framework for Bun: controllers as plain
classes, lifecycle hooks instead of middleware, and types inferred from end
to end — without decorators, a DI container or dependencies in the core.

```ts
import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

class UsersController {
  constructor(private users: UserRepository) {}

  get = route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const user = this.users.find(ctx.params.id);
      //                                  ^? number — from the schema

      if (!user) throw httpError(404, "USER_NOT_FOUND");

      return user;
    },
  });
}

const app = createApp({ routes: new UsersController(users) });

Bun.serve({ ...app, port: 3000 });
```

- [Install](#install)
- [Quick start](#quick-start)
- [Philosophy](#philosophy)
- [Guide](#guide): [routes](#routes-and-controllers) ·
  [hooks](#lifecycle-hooks) · [validation](#validation) ·
  [request bodies](#request-bodies) · [responses and errors](#responses-and-errors) ·
  [cookies](#cookies) · [groups and hook packages](#groups-and-hook-packages) ·
  [WebSockets](#websockets) · [streaming](#streaming) ·
  [cancellation](#cancellation-and-timeouts) · [testing](#testing) ·
  [logging](#logging)
- [Packages](#packages)
- [FAQ](#faq)
- [Performance](#performance)

## Install

```bash
bun add @tetsujs/core
```

Requires Bun 1.4 or later and TypeScript 5.7 or later with `strict` on. The
types name Bun's own (`Bun.Server`, `CookieMap`), so the project needs
`@types/bun` — `bun init` adds it, `bun add -d @types/bun` otherwise.

## Quick start

```ts
// server.ts
import { createApp, route } from "@tetsujs/core";

class HelloController {
  greet = route({
    method: "GET",
    path: "/hello/:name",
    handler: (ctx) => ({ hello: ctx.params.name }),
  });
}

const app = createApp({ routes: new HelloController() });

Bun.serve({ ...app, port: 3000 });
```

```bash
bun server.ts
curl localhost:3000/hello/ada   # {"hello":"ada"}
```

`createApp` returns plain data — routes, a fallback, a WebSocket handler —
and `Bun.serve` takes it as it is. There is no server object of our own.

## Philosophy

1. **Classes without decorators.** The structure of Nest — controllers,
   explicit composition — in standard TypeScript. A controller is any object
   whose fields are `route()`s; the framework reads the fields and nothing
   else, not the file name, not the class, not metadata.
2. **Flat, and no magic.** No global registry, no file scanning, no
   reflection, no container. The application is a tree of objects wired by
   hand in one place, and any point of it reads top to bottom.
3. **Types do not lie.** `ctx` is never annotated. A field is in it exactly
   when it exists at that point of the request: path parameters from the
   path literal, the body only after it was validated, `ctx.user` only after
   the hook that returned it.
4. **Explicit over DRY.** A route lists its own hooks, so reading a route
   shows everything that runs for it, and in what order.
5. **The platform, not a wrapper.** Routing is Bun's native router, headers
   are `Headers`, cookies are Bun's `CookieMap`, `ctx.server` is the real
   server. The core has no dependencies: validation goes through
   [Standard Schema](https://standardschema.dev), so you bring Zod, Valibot,
   ArkType or TypeBox.

## Guide

### Routes and controllers

A route is a field created by `route()`. A controller is any object holding
such fields — a class when it has dependencies, a literal when it does not:

```ts
class OrdersController {
  constructor(private orders: OrderService) {}

  list = route({ method: "GET", path: "/orders", handler: () => this.orders.all() });
}

const health = {
  live: route({ method: "GET", path: "/live", handler: () => "ok" }),
};

const app = createApp({ routes: [new OrdersController(orders), health] });
```

Dependencies are passed by hand, in the one file that builds the
application. Paths are checked at compile time: `:id` is a parameter, `*`
is allowed only as the whole last segment, and syntax that looks like a
parameter but is not one — `{id}`, `:id?` — is refused rather than matched
literally.

`ctx.route` is the route that matched, as declared, which is what a log
line or a metric should be labelled with:

```ts
handler: (ctx) => {
  ctx.route.path;       // "/api/users/:id" — the template, not the URL
  ctx.route.method;     // "GET"
  ctx.route.controller; // "UsersController"
  ctx.route.name;       // "get"
},
```

### Lifecycle hooks

A request passes through fixed slots. There is no `next()` and no onion to
reason about:

```
beforeParse → parse → beforeValidation → validate → beforeHandle
  → handler → beforeResponse → afterResponse      (onError on failure)
```

A hook extends the context by returning an object, and what it returned is
typed in every later hook and in the handler. It stops the request by
throwing or by returning a `Response`:

```ts
import { hook, HttpError, route } from "@tetsujs/core";

export const auth = hook.beforeParse(async (ctx) => {
  const user = await sessions.verify(ctx.req.headers.get("authorization"));

  if (!user) throw new HttpError(401);

  return { user };
});

route({
  method: "GET",
  path: "/orders",
  hooks: { beforeParse: [auth] },
  handler: (ctx) => orders.listFor(ctx.user.id),
  //                                    ^? User
});
```

A hook can also state what it needs instead of where it sits. Mounting it
where nothing provides that is a compile error naming the missing field:

```ts
import type { Requires } from "@tetsujs/core";

export const withOrder = hook.beforeHandle(
  async (ctx: Requires<{ params: { id: string }; user: User }>) => ({
    order: await orders.find(ctx.params.id),
  }),
);
```

`beforeResponse` hooks see the response and may replace it; `afterResponse`
hooks run after it has been sent, on every outcome, which makes them the
place for logs and metrics. `onError` hooks turn an error into a response.

### Validation

Any schema implementing Standard Schema validates any part of the request.
All parts are checked at once, and a failure answers `422` with every issue:

```ts
const Page = z.object({ page: z.coerce.number().int().min(1).default(1) });
const NewItem = z.object({ name: z.string().min(1), qty: z.number().int() });

create = route({
  method: "POST",
  path: "/items",
  schema: { query: Page, body: NewItem, response: { 201: Item } },
  handler: (ctx) => {
    ctx.out.status = 201;

    return this.items.add(ctx.body); // ctx.body is NewItem's output type
  },
});
```

The parts are `params`, `query`, `headers`, `cookies` and `body`, and
`response` checks what leaves. The value the response schema returns is
what gets serialized, so a schema that strips unknown keys keeps fields
like `passwordHash` out of the JSON.

A response map is also the list of statuses the route answers with: the
handler may only set a declared status and return a declared shape, and a
response with any other status is refused with a `500`. A status without a
body is declared `null`:

```ts
schema: { response: { 200: Session, 204: null } },
```

`validateResponses: false` on `createApp` turns response checks off.

### Request bodies

A route declares how its body is read with `bodyType`: `"json"` (the
default), `"form"` (multipart and urlencoded; uploads arrive as `File`
values inside `ctx.body`, validated like any other field), `"text"`, or
`"stream"`:

```ts
route({
  method: "POST",
  path: "/uploads",
  bodyType: "stream",
  maxBodySize: 5 * 1024 ** 3,
  handler: async (ctx) => {
    await storage.put(ctx.body); // ^? ReadableStream<Uint8Array>
  },
});
```

`maxBodySize` — 1 MiB by default, per application or per route — is counted
while the body is read, so an oversized request is refused with `413`
without buffering the rest of it. A streamed body is counted too, chunk by
chunk, without being buffered.

### Responses and errors

What the handler returns becomes the response: `undefined` is `204` with
no body, anything else is JSON with `200`, and a `Response` is sent as it
is. Everything else the response will carry goes on `ctx.out`:

```ts
ctx.out.status = 201;
ctx.out.headers.set("location", `/orders/${order.id}`);
```

Every error the framework produces has one shape, and so do the ones you
throw:

```ts
throw new HttpError(404);
// { "status": 404, "message": "Not Found", "error": "NOT_FOUND" }

throw httpError(409, "ALREADY_SHIPPED", "Order already shipped");
// { "status": 409, "message": "Order already shipped", "error": "ALREADY_SHIPPED" }
```

`error` is the code to branch on; `message` is for people and may change.
A validation failure adds `issues`. An `onError` hook replaces the format
for the whole application.

### Cookies

Incoming cookies are `ctx.cookies`, validated by `schema.cookies` like any
other part. Outgoing ones are written on `ctx.out.cookies`:

```ts
ctx.out.cookies.set("session", token, { httpOnly: true, maxAge: 3600 });
ctx.out.cookies.delete("theme");
```

Give the application a secret and the named cookies are signed on the way
out and verified on the way in; a cookie whose signature does not hold is
treated as absent:

```ts
createApp({ cookies: { secret: env.COOKIE_SECRET, sign: ["session"] }, routes });
```

### Groups and hook packages

A group adds a path prefix and hooks to everything under it. Hook packages
are functions returning hooks, mounted whole on the application or a group
— there is no plugin system:

```ts
import { cors } from "@tetsujs/cors";
import { accessLog, requestId } from "@tetsujs/request-id";

createApp({
  hooks: [cors({ origin: "https://app.example.com" }), requestId(), accessLog()],
  routes: group("/api", {
    children: [
      new StatusController(),
      group("/admin", {
        hooks: { beforeParse: [adminOnly] },
        children: [new AdminController()],
      }),
    ],
  }),
});
```

A group's hooks run for its routes but do not add to their types — see the
[FAQ](#why-does-ctxuser-from-a-group-hook-not-show-up-in-the-handlers-type).
Among themselves they do: a hook of a group or of the application sees
what the hooks before it at the same level contributed, in the order they
run — `[requestId(), { beforeParse: [scope] }]` gives `scope` a typed
`ctx.requestId`.
Unmatched paths (`404`, `405`) and CORS preflights run only the
application's hooks.

### WebSockets

A WebSocket endpoint is declared like a route. The handshake goes through
the same hooks, so a refused one is an ordinary `401`, and what the hooks
returned becomes `socket.data`:

```ts
import { ws } from "@tetsujs/core";

room = ws({
  path: "/chat/:room",
  hooks: { beforeParse: [auth] },
  schema: { message: ChatMessage },
  open: (socket) => socket.subscribe(socket.data.params.room),
  message: (socket, message) => socket.publish(socket.data.params.room, message.text),
});
```

### Streaming

A handler that streams returns a `Response` carrying the stream. For
server-sent events and other streamed formats,
[`@tetsujs/sse`](https://github.com/tetsujs/tetsu/tree/main/packages/sse) turns an async generator into one, with
backpressure, cleanup when the client leaves, and keep-alives:

```ts
import { sse } from "@tetsujs/sse";

handler: (ctx) =>
  sse(ctx, async function* () {
    for await (const price of prices.watch()) yield { event: "price", data: price };
  }),
```

### Cancellation and timeouts

`ctx.req.signal` aborts when the client disconnects. A deadline comes from
the platform, and the two combine:

```ts
handler: async (ctx) => {
  const signal = AbortSignal.any([ctx.req.signal, AbortSignal.timeout(5_000)]);

  return await upstream.fetch({ signal });
},
```

A signal stops only the work it was passed to — a query started without
one runs to completion however long it takes.

### Testing

A handler keeps its types, so a unit test calls it directly with a
context built by `testCtx()`:

```ts
import { testCtx } from "@tetsujs/core/testing";

const controller = new UsersController(users);

expect(controller.get.handler(testCtx({ params: { id: 1 } }))).toEqual(user);
```

Integration tests go through a real server, because Bun's router is only
reachable through a socket. `serve()` starts one on a free port and stops
it when the test file finishes:

```ts
import { serve } from "@tetsujs/core/testing";

const request = serve(createApp({ routes: new UsersController(users) }));

expect((await request("/users/1")).status).toBe(200);
```

### Logging

The framework has no logger of its own, and writes no lines of its own
except the failures it cannot return to a client: an error no `onError`
hook answered, a handler breaking its response contract, a hook failing
after the response went, a WebSocket handler, a stream. By default they go
to `console.error`. Pass `reportError`, and they go to you instead:

```ts
createApp({
  hooks: [requestId(), accessLog({ write: (r) => logger.info(r) })],
  reportError: ({ source, error, ctx }) =>
    logger.error({ err: error, source, requestId: ctx?.requestId }, "tetsu"),
  routes,
});
```

`error` is what was thrown, untouched, so the logger's redaction applies to
it. `source` says what failed — `"unhandled"`, `"response"`,
`"afterResponse"` and so on — and `ctx` is the request's context, typed from
the application's own hooks, absent where there was no request. The
receiver is not awaited.

For request logs, see [`@tetsujs/request-id`](https://github.com/tetsujs/tetsu/tree/main/packages/request-id).

## Packages

| Package | What it does |
| --- | --- |
| [`@tetsujs/core`](https://github.com/tetsujs/tetsu/tree/main/packages/core) | routes, hooks, validation, WebSockets — the framework |
| [`@tetsujs/typebox`](https://github.com/tetsujs/tetsu/tree/main/packages/typebox) | TypeBox schemas as DTOs, file uploads included |
| [`@tetsujs/openapi`](https://github.com/tetsujs/tetsu/tree/main/packages/openapi) | an OpenAPI 3.1 document and docs page generated from the routes |
| [`@tetsujs/cors`](https://github.com/tetsujs/tetsu/tree/main/packages/cors) | CORS |
| [`@tetsujs/rate-limit`](https://github.com/tetsujs/tetsu/tree/main/packages/rate-limit) | rate limiting with a replaceable store |
| [`@tetsujs/request-id`](https://github.com/tetsujs/tetsu/tree/main/packages/request-id) | request ids and access logs |
| [`@tetsujs/secure-headers`](https://github.com/tetsujs/tetsu/tree/main/packages/secure-headers) | security headers |
| [`@tetsujs/sse`](https://github.com/tetsujs/tetsu/tree/main/packages/sse) | server-sent events and streamed responses |
| [`@tetsujs/lifecycle`](https://github.com/tetsujs/tetsu/tree/main/packages/lifecycle) | graceful shutdown |

[`examples/`](https://github.com/tetsujs/tetsu/tree/main/examples) has a runnable file per feature, and
[`examples/app`](https://github.com/tetsujs/tetsu/tree/main/examples/app) is a small notes API on `bun:sqlite` showing
how the pieces sit in a project.

## FAQ

#### Why classes, but no decorators or DI container?

Classes give a codebase structure: a controller groups related routes and
receives its dependencies in the constructor. Decorators and a container
add a second, hidden layer on top — metadata, registration, resolution
order — that the compiler cannot check and a reader cannot follow. Here
the wiring is ordinary code in one file.

#### Why only Bun?

Because the framework uses Bun rather than abstracting it: the native
router, `CookieMap`, `Bun.serve`. Supporting other runtimes would mean a
second router and wrappers around everything else.

#### How is it different from Nest, Hono or Elysia?

From Nest: the same controller-based structure, without decorators,
reflection or a container, and with request types inferred rather than
declared. From Hono: classes and a fixed lifecycle instead of middleware,
and Bun only. From Elysia: controllers as classes instead of a method
chain, and explicit wiring instead of plugins.

#### Why does `ctx.user` from a group hook not show up in the handler's type?

A controller is typed where it is written, not where it is mounted, and a
group does not know which routes it will hold. The hook still runs. To use
its field in a handler, mount the hook on the route, or have the code that
reads it declare `Requires<{ user: User }>` — the compiler then checks that
something provides it.

#### Can I call the app without starting a server?

Not through routing: routing is Bun's, and only a socket reaches it. Call
handlers directly with `testCtx()`, or use `serve()` from
`@tetsujs/core/testing` — see [Testing](#testing).

#### Is there a plugin system?

No. A package is a function returning hooks, mounted like any other hooks,
so everything that runs for a route is visible where the route is mounted.

## Performance

Measured against raw `Bun.serve` handlers, each in a process of its own —
processor time per request and the share of raw Bun's throughput:

| Route | raw Bun, µs | Tetsu, µs | share of raw |
| --- | --- | --- | --- |
| `GET`, no hooks | 4.62 | 4.88 | 95.6% |
| `GET` + 2 hooks | 4.75 | 5.11 | 94.3% |
| `POST`, parsed and validated | 5.75 | 6.36 | 92.0% |
| `404` | 4.67 | 4.97 | 94.9% |

Hono, Elysia, memory, startup and the cost of types are in
[`bench/`](https://github.com/tetsujs/tetsu/tree/main/bench).

## Status

`0.1` — usable, and the API may still change between minor versions until
`1.0`. All packages share one version.

## Contributing

See [CONTRIBUTING.md](https://github.com/tetsujs/tetsu/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/tetsujs/tetsu/blob/main/LICENSE)
