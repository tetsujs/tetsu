# Tetsu

Tetsu (鉄, "iron") is an HTTP framework for Bun: controllers declared with
the dependencies they need, lifecycle hooks in fixed slots instead of
middleware, and types inferred from end to end — down to the order of the
hooks, checked by the compiler — without decorators, a DI container or
dependencies in the core.

```ts
import { controller, createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const usersController = controller("Users", ({ users }: { users: UserRepository }) => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const user = users.find(ctx.params.id);
      //                             ^? number — from the schema

      if (!user) throw httpError(404, "USER_NOT_FOUND");

      return user;
    },
  }),
}));

const app = createApp({ routes: usersController({ users }) });

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
import { controller, createApp, route } from "@tetsujs/core";

const helloController = controller("Hello", () => ({
  greet: route({
    method: "GET",
    path: "/hello/:name",
    handler: (ctx) => ({ hello: ctx.params.name }),
  }),
}));

const app = createApp({ routes: helloController() });

Bun.serve({ ...app, port: 3000 });
```

```bash
bun server.ts
curl localhost:3000/hello/ada   # {"hello":"ada"}
```

`createApp` returns plain data — routes, a fallback, a WebSocket handler —
and `Bun.serve` takes it as it is. There is no server object of our own.

## Philosophy

1. **Controllers without decorators.** A controller is a named function
   from its dependencies to its routes, called once where the application
   is wired. The framework reads the routes it returns and nothing else —
   not the file name, not a class, not metadata.
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

A route is created by `route()`. A controller is a name and a function from
its dependencies to its routes:

```ts
import { controller, route } from "@tetsujs/core";

export interface OrdersDeps {
  readonly orders: OrderService;
}

export const ordersController = controller("Orders", ({ orders }: OrdersDeps) => ({
  list: route({ method: "GET", path: "/orders", handler: () => orders.all() }),
  get: route({ method: "GET", path: "/orders/:id", handler: (ctx) => orders.find(ctx.params.id) }),
}));

export const healthController = controller("Health", () => ({
  live: route({ method: "GET", path: "/live", handler: () => "ok" }),
}));

// main.ts — the one place the application is wired
const app = createApp({
  routes: [ordersController({ orders }), healthController()],
});
```

It is a function, and not a class, because a route reads what it declares
— its hooks, its schemas, its body limit — when it is declared. A function
has its dependencies from its first line; a class's fields are initialized
before its constructor's parameters are assigned, so a hook built from a
constructor argument in a field is built from `undefined`. Services stay
classes: a service is behaviour other code calls, a controller is a
declaration made once.

A hook that needs a service is built inside the controller, next to the
routes that mount it. A hook whose state several controllers must share —
one rate limit budget — is made once in `main.ts` and passed in like a
service.

The name is a contract: `@tetsujs/openapi` builds every `operationId` from
it (`ordersList`), and a generated client names its methods after those.
Renaming the variable changes nothing a client sees; changing the name
does, where a reviewer sees it. Two controllers of one application cannot
share a name — it is refused at startup — so two versions of an API are two
names over one body:

```ts
const users = ({ users }: UsersDeps) => ({ list: route({ … }) });

export const usersV1 = controller("UsersV1", users);
export const usersV2 = controller("UsersV2", users);
```

Paths are checked at compile time: `:id` is a parameter, `*` is allowed
only as the whole last segment, and syntax that looks like a parameter but
is not one — `{id}`, `:id?` — is refused rather than matched literally.

`ctx.route` is the route that matched, as declared, which is what a log
line or a metric should be labelled with:

```ts
handler: (ctx) => {
  ctx.route.path;       // "/api/users/:id" — the template, not the URL
  ctx.route.method;     // "GET"
  ctx.route.controller; // "Users"
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

Hooks are mounted by slot, the same way on a route, a group and the
application: `hooks: { beforeParse: [auth], afterResponse: [log] }`. The key
says where a hook runs, and the compiler checks it against the slot the
hook was made for. Inside a slot the array is the order; the slots
themselves always run in lifecycle order, whatever order they are written
in. Every hook and handler also sees `ctx.startedAt`, the monotonic time the
request was taken, before any hook ran.

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

A group adds a path prefix and hooks to everything under it. A hook package
is a function that takes options and returns one hook, mounted in its slot
like any other — there is no plugin system:

```ts
import { cors } from "@tetsujs/cors";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";

const browser = cors({ origin: "https://app.example.com" });
const id = requestId();
const log = accessLog();

createApp({
  hooks: {
    beforeParse: [browser, id],
    afterResponse: [log],
  },
  routes: group("/api", {
    children: [
      statusController(),
      group("/admin", {
        hooks: { beforeParse: [adminOnly] },
        children: [adminController()],
      }),
    ],
  }),
});
```

A group's hooks run for its routes but do not add to their types — see the
[FAQ](#why-does-ctxuser-from-a-group-hook-not-show-up-in-the-handlers-type).
Among themselves they do: a hook of a group or of the application sees
what the hooks before it at the same level contributed — earlier in its
slot, or in any slot that runs before its own. `beforeParse: [id, scope]`
gives `scope` a typed `ctx.requestId`; in `beforeResponse`, `afterResponse`
and `onError` such fields are optional, since the hook that adds them may
never have run. Unmatched paths (`404`, `405`) and CORS preflights run only
the application's hooks.

### Mounting hooks

Everything that runs for a request is written out where it is mounted.
A few habits keep it that way:

- **Make a hook once, in a named constant, and mount it by name.** A
  package's options stay out of the `hooks` object, and a factory called
  inside it would make a new instance every time the code around it runs.
- **Share hooks, not `hooks` objects.** Two applications that log the same
  way import the same `id` and `log` and each lists them in its own slots.
  If you do want to combine two `hooks` objects, join them slot by slot —
  `Object.assign` and spreading replace a slot instead of joining it — and
  keep every slot a tuple, or the compiler cannot check the order:

  ```ts
  import type { HooksConfig } from "@tetsujs/core";

  const slots = ["beforeParse", "beforeValidation", "beforeHandle", "beforeResponse", "afterResponse", "onError"] as const;

  type Slot = (typeof slots)[number];
  type Of<S, K extends Slot> = S extends { readonly [P in K]: infer T extends readonly unknown[] } ? T : [];

  export function join<const A extends HooksConfig, const B extends HooksConfig>(a: A, b: B) {
    const joined: Record<string, unknown[]> = {};

    for (const slot of slots) joined[slot] = [...(a[slot] ?? []), ...(b[slot] ?? [])];

    return joined as unknown as { readonly [K in Slot]: readonly [...Of<A, K>, ...Of<B, K>] };
  }
  ```

  A helper that returns plain arrays or a `Record<string, …>` is refused
  where it is mounted: nothing in it could be checked.
- **State lives in the instance.** One `rateLimit()` mounted on two groups
  shares its counters between them. For separate budgets, make two. A hook
  made inside a controller is that controller's own; one whose state is
  shared is made in `main.ts` and passed in.
- **An instance runs once per request.** The same hook mounted twice in one
  route's chain — on a group and on a route under it — is refused at
  startup.
- **Order within a slot is yours.** The compiler checks what a hook needs
  (`scope` after `id`), not what should come first. The rule to keep:
  `cors()` goes before every hook that can refuse, so that the refusal
  carries the headers a browser needs to read it. A hook that never
  refuses — `requestId()`, `arrivalLog()` — may go before it, and then a
  preflight gets its id and its log line too.
- **A package is one hook.** Writing your own, return the hook from a
  function that takes the options. A package that seems to need two slots
  is usually missing something the core should provide — say so in an
  issue.

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
[`@tetsujs/sse`](packages/sse) turns an async generator into one, with
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

const routes = usersController({ users });

expect(routes.get.handler(testCtx({ params: { id: 1 } }))).toEqual(user);
```

Integration tests go through a real server, because Bun's router is only
reachable through a socket. `serve()` starts one on a free port and stops
it when the test file finishes:

```ts
import { serve } from "@tetsujs/core/testing";

const request = serve(createApp({ routes: usersController({ users }) }));

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
  hooks: {
    beforeParse: [requestId()],
    afterResponse: [accessLog({ write: (r) => logger.info(r) })],
  },
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

For request logs, see [`@tetsujs/request-log`](packages/request-log): a
line when a request is done, and one when it arrives.

## Packages

| Package | What it does |
| --- | --- |
| [`@tetsujs/core`](packages/core) | routes, hooks, validation, WebSockets — the framework |
| [`@tetsujs/typebox`](packages/typebox) | TypeBox schemas as DTOs, file uploads included |
| [`@tetsujs/openapi`](packages/openapi) | an OpenAPI 3.1 document and docs page generated from the routes |
| [`@tetsujs/cors`](packages/cors) | CORS |
| [`@tetsujs/rate-limit`](packages/rate-limit) | rate limiting with a replaceable store |
| [`@tetsujs/request-id`](packages/request-id) | request ids |
| [`@tetsujs/request-log`](packages/request-log) | access and arrival logs |
| [`@tetsujs/secure-headers`](packages/secure-headers) | security headers |
| [`@tetsujs/sse`](packages/sse) | server-sent events and streamed responses |
| [`@tetsujs/lifecycle`](packages/lifecycle) | graceful shutdown |

[`examples/`](examples) has a runnable file per feature, and
[`examples/app`](examples/app) is a small notes API on `bun:sqlite` showing
how the pieces sit in a project.

## FAQ

#### Why no decorators or DI container?

Decorators and a container add a second, hidden layer — metadata,
registration, resolution order — that the compiler cannot check and a
reader cannot follow. Here a controller receives its dependencies as the
argument of a function, and the wiring is ordinary code in one file.

#### Can a controller be a class?

The framework reads routes from any object, so an instance works, and is
named after its class. But a route declared as a field is built before the
constructor has assigned its parameters: a hook made from a constructor
argument there is made from `undefined` (the compiler reports it as
TS2729). A hook whose body reads `this.service` only when it runs avoids
that; `controller()` avoids the question.

#### Why only Bun?

Because the framework uses Bun rather than abstracting it: the native
router, `CookieMap`, `Bun.serve`. Supporting other runtimes would mean a
second router and wrappers around everything else.

#### How is it different from Nest, Hono or Elysia?

From Nest: controllers and explicit composition, without decorators,
reflection or a container, and with request types inferred rather than
declared. From Hono: named controllers and a fixed lifecycle instead of
middleware, and Bun only. From Elysia: controllers instead of a method
chain, and explicit wiring instead of plugins. From all three: the order of
hooks, what each one needs and what it adds, checked by the compiler.

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

No. A package is a function returning a hook, mounted in its slot like any
other, so everything that runs for a route is visible where it is mounted.

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
[`bench/`](bench).

## Status

`0.x` — usable, and the API may still change between minor versions until
`1.0`; [`CHANGELOG.md`](CHANGELOG.md) says what changed and how to move.
All packages share one version.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
