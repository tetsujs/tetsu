---
title: Introduction
description: Tetsu is an HTTP framework for Bun with controllers, lifecycle hooks in fixed slots and types inferred from end to end.
---

Tetsu is an HTTP framework for Bun. Controllers get their dependencies as
function arguments, hooks run in fixed slots instead of a middleware chain,
and the compiler infers every type from the path to the handler. There are
no decorators, no DI container and no dependencies in the core.

```ts twoslash
interface User { id: number; name: string }
interface UserRepository { find(id: number): User | undefined }
declare const repo: UserRepository;
// ---cut---
import { controller, createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const users = controller("Users", ({ repo }: { repo: UserRepository }) => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const user = repo.find(ctx.params.id);
      //                                ^?
      if (!user) throw httpError(404, "USER_NOT_FOUND");
      return user;
    },
  }),
}));

Bun.serve({ ...createApp({ routes: users({ repo }) }) });
```

Nothing here is annotated. `ctx.params.id` is a number because the schema
converts the path segment, and without `:id` in the path it would not exist.
A request with a bad id gets a `422` and never reaches the handler.

## What it is not

Tetsu runs on Bun only. It has no plugin system: a package such as CORS or
rate limiting is a hook, mounted like your own. It has no container, no
file-based routing and no global registry: what runs for a route is
declared in code, on the route, its groups or the application.

## Where to go next

- [Installation](/docs/installation/) — requirements and TypeScript settings.
- [Quick start](/docs/quick-start/) — a first application with a test.
- [Key concepts](/docs/key-concepts/) — the whole model on one page.
