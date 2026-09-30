---
title: Comparison
description: How Tetsu relates to Elysia, Hono, NestJS and Fastify — what it borrows, where it differs, and when another framework is the better choice.
---

Tetsu is not a new paradigm. It recombines ideas that have proven
themselves elsewhere: a request lifecycle like Elysia's without the method
chain, hooks in named stages like Fastify's with their types inferred, and
the structure of Nest — controllers and explicit composition — without
decorators or a container. The value is in the combination, and this page
says honestly what it costs and when something else fits better.

Descriptions of other frameworks are brief and may lag behind their latest
releases; their own documentation is the authority.

## At a glance

| | Tetsu | Elysia | Hono | NestJS |
| --- | --- | --- | --- | --- |
| Runtime | Bun | Bun first, others via adapters | many: Workers, Deno, Bun, Node | Node (Express or Fastify underneath) |
| Structure | named controllers, wired by hand | a chain of methods and plugins | an app with middleware and routes | modules, classes and decorators |
| Around a handler | hooks in fixed slots | lifecycle hooks, scoped by plugin | middleware with `next()` | guards, pipes, interceptors, filters |
| Request types | inferred from path, schemas and hooks | inferred through the chain | inferred from validators | declared on DTO classes |
| Dependencies | function arguments | decorate / derive / plugins | context variables | a DI container |
| Validation | Standard Schema | TypeBox built in, Standard Schema | validator middleware | pipes, usually class-validator |
| Typed client | via the OpenAPI document | Eden | `hc` (RPC) | via the OpenAPI document |

## Elysia

Elysia is the closest relative: Bun first, a request lifecycle with named
events, types inferred end to end, and very fast. The differences are in
shape. An Elysia application is a chain — each `.use()`, `.derive()` or
`.get()` extends the type of what follows — and plugins decide how far
their hooks reach (local, scoped, global). A Tetsu application is a tree of
plain objects: a controller is a named function, a route lists its own hooks
by slot, and the reach of a hook is the place it is mounted.

Elysia's chain gives it Eden, a client typed straight from the server's
type. Tetsu's typed boundary is the OpenAPI document instead, which any
generator and any language can use.

On raw speed Elysia 1.4, with its ahead-of-time compilation, spends a
little less processor time per request than Tetsu on three of the four
routes in [the benchmark](/docs/more/performance/) — tenths of a
microsecond either way.

## Hono

Hono runs almost anywhere — Workers, Deno, Bun, Node — and is small and
quick to start. Its model is middleware around `next()`, which is flexible
and familiar; the price is that "what runs, and in which order" is a
property of the call stack rather than something a type can check. Tetsu
gives up every runtime but Bun to use Bun's router, server and cookies
directly, and gives up `next()` for fixed slots, so the compiler checks
the order of hooks and what each needs.

If the application must run on an edge platform or on more than one
runtime, Hono is the better choice.

## NestJS

Nest brought controllers, services and explicit modules to Node, and a
large ecosystem with them. It is built on decorators, `reflect-metadata`
and a DI container: types of request parts are declared on DTO classes,
and the container resolves what each class needs. Tetsu keeps the
controllers and the services and drops the rest — a controller receives
its dependencies as function arguments in one composition root, and the
types of `ctx` are inferred, never declared.

If the team relies on Nest's ecosystem — its modules for queues,
microservices, GraphQL, its guards and interceptors — Nest remains the
practical choice.

## Fastify

Fastify's hooks — `onRequest`, `preParsing`, `preValidation`,
`preHandler`, `onSend`, `onResponse`, `onError` — are the model Tetsu's
slots are closest to. Fastify runs on Node, has a mature plugin system with
encapsulation, and types its routes through type providers. Tetsu has no
plugins: a package is one hook in one slot, and its contribution to `ctx`
is inferred.

## What Tetsu costs

- **Bun only.** No Node, no Deno, no edge runtimes.
- **Explicit over DRY.** Routes list their hooks; similar routes repeat
  them. A shared set is spread into slots by hand.
- **A young ecosystem.** Ten official packages, and few integrations
  beyond what a hook of your own does.
- **`0.x`.** The API may change between minor versions until `1.0`; every
  change is listed with how to move. See
  [Stability and versioning](/docs/more/stability/).
