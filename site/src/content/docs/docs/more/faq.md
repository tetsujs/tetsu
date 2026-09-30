---
title: FAQ
description: Short answers to the questions people ask about Tetsu first — decorators, classes, Bun only, plugins, typed clients and the version.
---

## Why no decorators or DI container?

Decorators and a container add a second, hidden layer — metadata,
registration, resolution order — that the compiler cannot check and a
reader cannot follow. A controller here receives its dependencies as the
argument of a function, and the wiring is ordinary code in one file. There
is a practical reason too: a TypeScript decorator cannot put the inferred
type of `ctx` into a method's signature, so every handler would have to be
annotated by hand.

## Can a controller be a class?

The framework reads routes from any object, so an instance works, and is
named after its class. But a route declared as a class field is built
before the constructor has assigned its parameters: a hook made from a
constructor argument there is made from `undefined` (TypeScript reports it
as TS2729). A hook whose body reads `this.service` only when it runs avoids
that; `controller()` avoids the question. Services stay classes — see
[Controllers and dependencies](/docs/concepts/controllers/).

## Why only Bun?

Because the framework uses Bun rather than abstracting it: the native
router, `CookieMap`, `Bun.serve`, `Bun.Server`. Supporting other runtimes
would mean a second router and a wrapper around everything else, and a
second router is a second source of truth about which request matches
which route.

## Is there a plugin system?

No. A package is a function returning one hook, mounted in its slot like
any other, so everything that runs for a route is visible where it is
mounted. See [Writing a hook package](/docs/guides/writing-a-hook-package/).

## Why does `ctx.user` from a group hook not show up in the handler's type?

A controller is typed where it is written, not where it is mounted, and a
group does not know which routes it will hold. The hook still runs. To use
its field in a handler, mount the hook on the route, or have the code that
reads it declare `Requires<{ user: User }>` — the compiler then checks that
something provides it. See [Context and its types](/docs/concepts/context/).

## Why is a path parameter a string?

A path segment is text. `ctx.params.id` is a `string` until a `params`
schema says otherwise — `z.coerce.number()` makes it a number, checked
before the handler runs. The same holds for the query and form fields.

## Can I call the application without starting a server?

Not through routing: routing is Bun's, and only a socket reaches it. Call
handlers directly with `testCtx()`, or start a real server on a free port
with `serve()` from `@tetsujs/core/testing`. See
[Testing](/docs/guides/testing/).

## Is there a typed client, like Eden or Hono RPC?

The typed boundary is the OpenAPI document. `@tetsujs/openapi` builds it
from the routes you already declared, and any OpenAPI generator turns it
into a client — in the same repository or in another language. See
[Typed client from OpenAPI](/docs/guides/typed-client/).

## Can I use Express or Hono middleware?

No. A middleware is a function around `next()`; a hook has a slot and no
`next()`. Most middleware maps onto one hook in one slot, and the official
packages cover the common ones — CORS, request ids, logs, rate limits,
security headers.

## Does the framework read environment variables?

No. The core reads no environment, and neither does any package. Read your
configuration in the file that starts the server and pass it in; that is
also what makes a test's configuration a plain argument.

## Is it ready for production?

Tetsu is at `0.x`: usable, and the API may still change between minor
versions until `1.0`. Every change that breaks something is listed in the
[changelog](https://github.com/tetsujs/tetsu/releases) with how to move. See
[Stability and versioning](/docs/more/stability/).

## How is it different from Nest, Hono or Elysia?

In short: controllers and explicit wiring like Nest, without decorators or a
container; a fixed lifecycle instead of Hono's middleware; controllers
instead of Elysia's method chain. The longer answer is
[Comparison](/docs/more/comparison/).
