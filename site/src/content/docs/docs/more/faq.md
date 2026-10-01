---
title: FAQ
description: Short answers to the questions people ask about Tetsu first — decorators, classes, start and shutdown, Bun only, plugins, typed clients and the version.
---

## Why no decorators or DI container?

They add a hidden layer — metadata, registration, resolution order — that
the compiler cannot check and a reader cannot follow. Here a controller gets
its dependencies as function arguments, and the wiring is ordinary code in
one file. Decorators also cannot carry the inferred type of `ctx` into a
method, so every handler would need a hand-written annotation.

## Can a controller be a class?

It can: the framework reads routes from any object and names it after its
class. But class fields are initialized before the constructor assigns its
parameters, so a hook built from a constructor argument in a field is built
from `undefined` (TypeScript reports TS2729). `controller()` avoids the
problem. Services stay classes — see
[Controllers and dependencies](/docs/concepts/controllers/).

## Where are `onStart` and `onShutdown`?

There are none. A container needs them because it creates your objects in
an order of its own; here you create them in `main.ts`, so the order is the
order of the lines. Whatever must happen before the first request, such as
connecting to the database or running migrations, goes before `Bun.serve()`.
For stopping, [`@tetsujs/lifecycle`](/docs/packages/lifecycle/) handles
`SIGTERM`: it drains the server and then runs the `close` functions you give
it, in order. See [Health checks and shutdown](/docs/guides/health-and-shutdown/).

## Why only Bun?

Tetsu uses Bun directly: its native router, `CookieMap`, `Bun.serve` and
`Bun.Server`. Other runtimes would need a second router and a wrapper around
everything else, and a second router is a second answer to which route a
request matches.

## Is there a plugin system?

No. Packages such as CORS or rate limiting are hooks, mounted in their slot
like your own, so everything that runs for a route is visible where it is
mounted. See [Writing a hook package](/docs/guides/writing-a-hook-package/).

## Why is `ctx.user` from a group hook missing from the handler's type?

A controller is typed where it is written, not where it is mounted, so a
group's hooks do not reach the handler's type. The hook still runs. To use
its field in a handler, mount the hook on the route. See
[Context and its types](/docs/concepts/context/).

## Why is a path parameter a string?

A path segment is text. `ctx.params.id` is a `string` until a `params`
schema converts it, for example with `z.coerce.number()`. The same holds for
query and form fields.

## Can I call the application without starting a server?

Not through routing: routing is Bun's, and only a socket reaches it. Call a
handler directly with `testCtx()`, or start a real server on a free port
with `serve()` from `@tetsujs/core/testing`. See
[Testing](/docs/guides/testing/).

## Is there a typed client, like Eden or Hono RPC?

The typed boundary is the OpenAPI document. `@tetsujs/openapi` builds it
from your routes, and any OpenAPI generator turns it into a client, in
TypeScript or another language. See
[Typed client from OpenAPI](/docs/guides/typed-client/).

## Can I use Express or Hono middleware?

No. Middleware wraps `next()`; a hook has a slot and no `next()`. Most
middleware maps onto one hook in one slot, and the official packages cover
the common cases: CORS, request ids, logs, rate limits, security headers.

## Does the framework read environment variables?

No, neither the core nor any package. Read your configuration where the
server starts and pass it in; in a test, configuration is then a plain
argument.

## Is it ready for production?

Tetsu is at `0.x`: usable, but the API may change between minor versions
until `1.0`. Every breaking change is listed in the
[release notes](https://github.com/tetsujs/tetsu/releases) with how to
move. See [Stability and versioning](/docs/more/stability/).

## How is it different from Nest, Hono or Elysia?

Controllers and explicit wiring like Nest, without decorators or a
container; fixed slots instead of Hono's middleware; controllers instead of
Elysia's method chain. See [Comparison](/docs/more/comparison/).
