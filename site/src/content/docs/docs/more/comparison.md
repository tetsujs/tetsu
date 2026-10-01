---
title: Comparison
description: How Tetsu relates to Elysia, Hono, NestJS and Fastify — what it borrows, where it differs, and when another framework is the better choice.
---

Tetsu combines ideas from other frameworks: a request lifecycle like
Elysia's without the method chain, hooks in named stages like Fastify's with
inferred types, and Nest's controllers without decorators or a container.
This page says where it differs, what that costs, and when another framework
fits better. The notes on other frameworks are brief and may lag behind
their latest releases.

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
events, types inferred end to end. The difference is in shape. An Elysia
application is a chain, where each `.use()`, `.derive()` or `.get()` extends
the type of what follows, and plugins decide how far their hooks reach. A
Tetsu application is a tree of plain objects: a route lists its own hooks by
slot, and a hook reaches as far as the place it is mounted.

The chain gives Elysia Eden, a client typed straight from the server's type.
Tetsu's typed boundary is the OpenAPI document, which any generator and any
language can use.

In [the benchmark](/docs/more/performance/), Elysia 1.4 is level with Tetsu
on the `GET` routes and up to 0.3 µs a request faster on the `404` and the
validated `POST`.

## Hono

Hono runs almost anywhere — Workers, Deno, Bun, Node — and is small and
quick to start. Its middleware around `next()` is flexible and familiar, but
what runs and in which order is decided at runtime, where a type cannot
check it. Tetsu gives up every runtime but Bun to use Bun's router, server
and cookies directly, and gives up `next()` for fixed slots, so the compiler
checks the order of hooks and what each needs.

If the application must run on an edge platform or on more than one
runtime, Hono is the better choice.

## NestJS

Nest brought controllers, services and modules to Node, with a large
ecosystem. It is built on decorators, `reflect-metadata` and a DI container:
request types are declared on DTO classes, and the container resolves what
each class needs. Tetsu keeps controllers and services and drops the rest: a
controller gets its dependencies as function arguments, wired in one place,
and the types of `ctx` are inferred.

If the team relies on Nest's ecosystem — queues, microservices, GraphQL —
Nest remains the practical choice.

## Fastify

Fastify's hooks — `onRequest`, `preParsing`, `preValidation`,
`preHandler`, `onSend`, `onResponse`, `onError` — are what Tetsu's slots are
closest to. Fastify runs on Node, has a mature plugin system with
encapsulation, and types its routes through type providers. Tetsu has no
plugins: a package is a hook in a slot, and what it adds to `ctx` is
inferred.

## What Tetsu costs

- **Bun only.** No Node, no Deno, no edge runtimes.
- **Explicit over DRY.** Each route lists its hooks. A set several routes
  share is a constant you spread into their slots.
- **A young ecosystem.** Ten official packages; beyond them, you write the
  hook yourself.
- **`0.x`.** The API may change between minor versions until `1.0`, and
  every such change comes with how to move. See
  [Stability and versioning](/docs/more/stability/).
